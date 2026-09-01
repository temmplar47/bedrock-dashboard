"""
Bedrock multi-account dashboard - Lambda handler (single-service deployment).

This Lambda serves BOTH the frontend page and the query API:
  - GET     -> returns the embedded single-file dashboard page (PAGE_HTML,
              injected at build time by deploy/build-template.py)
  - POST    -> proxy query: uses the caller-supplied AWS credentials to call
              CloudWatch GetMetricData and Cost Explorer GetCostAndUsage
  - OPTIONS -> CORS preflight

It does NOT store credentials. Only boto3 (bundled in the runtime) is needed,
so the whole function can be inlined in a CloudFormation ZipFile.

Required permissions for the uploaded keys (see deploy/iam-policy.json):
  - cloudwatch:GetMetricData, cloudwatch:ListMetrics
  - ce:GetCostAndUsage
  - servicequotas:GetServiceQuota
  - sts:GetCallerIdentity (works even without explicit grant; only Deny blocks)
  - cloudshell:ListEnvironments (optional — for the account-health probe)
"""

import json
import re
from datetime import datetime, timedelta, timezone

import boto3

MODEL_DIM_RE = re.compile(r'ModelId\s*=\s*([^\s,]+)')

# Embedded single-file frontend page. Replaced at build time by
# deploy/build-template.py (frontend/index.html with inlined css/js).
PAGE_HTML = ''

# Bedrock model invocation metrics (namespace AWS/Bedrock).
# NOTE: the invocation-count metric is "Invocations" (plural) - there is no
# "InvocationCount" metric in the AWS/Bedrock namespace.
CW_QUERIES = [
    ('inputTokens', 'InputTokenCount', 'Sum'),
    ('outputTokens', 'OutputTokenCount', 'Sum'),
    ('invocations', 'Invocations', 'Sum'),
    ('latency', 'InvocationLatency', 'Average'),
]

# Service quotas shown on the dashboard (queried per-region on the caller's
# account). Override per request via body.quotaCodes / body.quotaServiceCode.
QUOTA_SERVICE_CODE = 'bedrock'
QUOTA_CODES = ['L-D06938E7']


def _cors_headers():
    return {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,x-api-key',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
    }


def _resp(status, obj):
    return {
        'statusCode': status,
        'headers': _cors_headers(),
        'body': json.dumps(obj, default=str),
    }


def _html_resp():
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
        },
        'body': PAGE_HTML,
    }


def _parse_model_id(label):
    # SEARCH labels can be either "ModelId=<value> <MetricName>" or, for a
    # single-dimension search, "<value> <MetricName>" (e.g. the actual
    # response is "global.anthropic.claude-opus-4-7 InputTokenCount").
    m = MODEL_DIM_RE.search(label or '')
    if m:
        return m.group(1)
    parts = (label or '').split()
    if len(parts) >= 2 and parts[0] not in {'Sum', 'Average', 'Maximum', 'Minimum', 'SampleCount'}:
        return parts[0]
    return None


def _build_session(creds, region):
    return boto3.Session(
        aws_access_key_id=creds.get('accessKeyId') or None,
        aws_secret_access_key=creds.get('secretAccessKey') or None,
        aws_session_token=creds.get('sessionToken') or None,
        region_name=region or 'us-east-1',
    )


def _fetch_cloudwatch(session, regions, start_dt, end_dt, model_filter):
    models = {}
    errors = []
    for region in regions:
        try:
            cw = session.client('cloudwatch', region_name=region)
            queries = []
            for qid, metric, stat in CW_QUERIES:
                queries.append({
                    'Id': qid,
                    'Expression':
                        "SEARCH(' {AWS/Bedrock, ModelId} MetricName=\"%s\" ', '%s', 3600)" % (metric, stat),
                    'ReturnData': True,
                })
            results = cw.get_metric_data(
                MetricDataQueries=queries,
                StartTime=start_dt,
                EndTime=end_dt,
                ScanBy='TimestampDescending',
            ).get('MetricDataResults', [])

            for r in results:
                qid = r.get('Id')
                model_id = _parse_model_id(r.get('Label', ''))
                if not model_id:
                    continue
                if model_filter and model_id not in model_filter:
                    continue
                vals = [v for v in r.get('Values', []) if v is not None]
                if not vals:
                    continue
                agg = sum(vals)
                m = models.setdefault(model_id, {
                    'modelId': model_id,
                    'inputTokens': 0,
                    'outputTokens': 0,
                    'invocations': 0,
                    'latList': [],
                })
                if qid == 'inputTokens':
                    m['inputTokens'] += agg
                elif qid == 'outputTokens':
                    m['outputTokens'] += agg
                elif qid == 'invocations':
                    m['invocations'] += agg
                elif qid == 'latency':
                    # InvocationLatency is an Average-stat: each value is an
                    # hourly average (ms). Average them, don't sum them.
                    m['latList'].append(sum(vals) / len(vals))
        except Exception as e:  # noqa: BLE001 - surface per-region errors to user
            errors.append({'type': 'cloudwatch', 'region': region, 'message': str(e)})

    out = []
    for m in models.values():
        lat = sum(m['latList']) / len(m['latList']) if m['latList'] else 0
        out.append({
            'modelId': m['modelId'],
            'inputTokens': int(m['inputTokens']),
            'outputTokens': int(m['outputTokens']),
            'invocations': int(m['invocations']),
            'avgLatencyMs': round(lat, 2),
        })
    return out, errors


def _parse_dt(v):
    """Parse an ISO-8601 datetime string; return aware datetime or None."""
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(str(v).strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _resolve_window(body):
    """Absolute range (startTime/endTime) wins; fall back to windowMinutes."""
    start_dt = _parse_dt(body.get('startTime'))
    end_dt = _parse_dt(body.get('endTime'))
    if start_dt and end_dt and start_dt < end_dt:
        return start_dt, end_dt
    window_min = int(body.get('windowMinutes') or 60)
    now = datetime.now(timezone.utc)
    return now - timedelta(minutes=window_min), now


def _fetch_cost(session, start_dt, end_dt):
    try:
        # Cost Explorer is only served from the us-east-1 endpoint.
        # HOURLY granularity only supports short windows (~2 weeks); use
        # DAILY for longer ranges so month-level windows still return data.
        span_days = (end_dt - start_dt).total_seconds() / 86400
        granularity = 'HOURLY' if span_days <= 2 else 'DAILY'
        ce = session.client('ce', region_name='us-east-1')

        def _time_period(gran):
            # HOURLY requires full datetime TimePeriod (yyyy-MM-ddThh:mm:ssZ);
            # DAILY requires date-only values.
            if gran == 'HOURLY':
                return {
                    'Start': start_dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                    'End': end_dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                }
            return {
                'Start': (start_dt - timedelta(days=1)).strftime('%Y-%m-%d'),
                'End': (end_dt + timedelta(days=1)).strftime('%Y-%m-%d'),
            }

        time_period = _time_period(granularity)
        # Group by SERVICE and keep any service whose name contains "bedrock":
        # on-demand usage is billed under "Amazon Bedrock", but marketplace
        # subscriptions report as e.g. "Claude Opus 4.8 (Amazon Bedrock
        # Edition)" — a plain SERVICE="Amazon Bedrock" filter misses those.
        totals = {}
        currency = 'USD'
        token = None
        while True:
            kwargs = {
                'TimePeriod': time_period,
                'Granularity': granularity,
                'Metrics': ['UnblendedCost'],
                'GroupBy': [{'Type': 'DIMENSION', 'Key': 'SERVICE'}],
            }
            if token:
                kwargs['NextPageToken'] = token
            try:
                resp = ce.get_cost_and_usage(**kwargs)
            except Exception as e:  # noqa: BLE001
                # Hourly granularity is opt-in (enabled on the PAYER account's
                # Cost Explorer settings); member accounts usually lack it.
                # Fall back to DAILY — cost then reflects whole days.
                if granularity == 'HOURLY' and 'Hourly data granularity' in str(e):
                    granularity = 'DAILY'
                    time_period = _time_period('DAILY')
                    token = None
                    continue
                raise
            for r in resp.get('ResultsByTime', []):
                bstart = datetime.fromisoformat(
                    r['TimePeriod']['Start'].replace('Z', '+00:00')
                )
                if bstart.tzinfo is None:  # DAILY results are date-only
                    bstart = bstart.replace(tzinfo=timezone.utc)
                # keep buckets that overlap the requested window
                bucket_end = bstart + (timedelta(hours=1) if granularity == 'HOURLY' else timedelta(days=1))
                if bucket_end <= start_dt or bstart > end_dt:
                    continue
                for g in r.get('Groups', []):
                    name = g['Keys'][0] if g.get('Keys') else ''
                    if 'bedrock' not in name.lower():
                        continue
                    m = g.get('Metrics', {}).get('UnblendedCost', {}) or {}
                    amt = m.get('Amount')
                    if amt:
                        totals[name] = totals.get(name, 0.0) + float(amt)
                    if m.get('Unit'):
                        currency = m['Unit']
            token = resp.get('NextPageToken')
            if not token:
                break
        total = sum(totals.values())
        services = [
            {'name': k, 'amount': round(v, 4)}
            for k, v in sorted(totals.items(), key=lambda x: -x[1])
        ]
        return {'amount': round(total, 4), 'currency': currency, 'services': services}, []
    except Exception as e:  # noqa: BLE001
        return {'amount': 0, 'currency': 'USD', 'error': str(e)}, [
            {'type': 'cost', 'message': str(e)}
        ]


def _fetch_caller(session):
    """STS GetCallerIdentity — validates the credential and reads the real
    account id / user. GetCallerIdentity needs no explicit IAM permission
    (only an explicit Deny blocks it), so it works for minimal keys."""
    try:
        c = session.client('sts').get_caller_identity()
        return {'accountId': c.get('Account'), 'arn': c.get('Arn'), 'userId': c.get('UserId')}
    except Exception as e:  # noqa: BLE001
        return {'error': str(e)}


def _fetch_cloudshell(session):
    """CloudShell health probe (read-only, us-east-1 only).

    When AWS puts an account under verification / risk control, the CloudShell
    console shows "无法创建环境。正在验证您的账户" and CloudShell API calls fail
    with an account-level error even though STS / Cost Explorer still work —
    the discriminating account-health signal. We call ListEnvironments only
    (pure read: never creates or deletes environments).
    """
    try:
        cs = session.client('cloudshell', region_name='us-east-1')
        envs = cs.list_environments().get('environments', [])
        return {'status': 'ok', 'environments': len(envs)}
    except Exception as e:  # noqa: BLE001
        return {'status': 'error', 'message': str(e)}


def _fetch_quotas(session, regions, service_code, quota_codes):
    """Query Service Quotas (e.g. L-D06938E7) for the caller's account, per region."""
    out = []
    for region in regions:
        for code in quota_codes:
            item = {'region': region, 'quotaCode': code}
            try:
                sq = session.client('service-quotas', region_name=region)
                q = sq.get_service_quota(ServiceCode=service_code, QuotaCode=code).get('Quota') or {}
                item.update({
                    'quotaName': q.get('QuotaName'),
                    'value': q.get('Value'),
                    'unit': q.get('Unit'),
                    'adjustable': q.get('Adjustable'),
                })
            except Exception as e:  # noqa: BLE001 - quota errors shown inline per cell
                item['error'] = str(e)
            out.append(item)
    return out


def lambda_handler(event, context):
    # Lambda Function URL / API Gateway v2 use requestContext.http.method;
    # API Gateway v1 (REST) uses top-level httpMethod.
    http_ctx = (event.get('requestContext') or {}).get('http') or {}
    method = (http_ctx.get('method') or event.get('httpMethod') or 'POST').upper()

    if method == 'GET':
        return _html_resp()
    if method == 'OPTIONS':
        return _resp(200, {})

    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        body = {}

    creds = body.get('credentials') or {}
    regions = body.get('regions') or []
    if not regions:
        regions = [body.get('region') or 'us-east-1']
    model_filter = body.get('modelFilter') or None
    if isinstance(model_filter, str):
        model_filter = [x.strip() for x in model_filter.split(',') if x.strip()]
    if not creds.get('accessKeyId') or not creds.get('secretAccessKey'):
        return _resp(400, {'success': False, 'error': 'Missing credentials'})

    start_dt, end_dt = _resolve_window(body)

    try:
        session = _build_session(creds, regions[0])
    except Exception as e:  # noqa: BLE001
        return _resp(400, {'success': False, 'error': f'Invalid credential config: {e}'})

    models, cw_errors = _fetch_cloudwatch(session, regions, start_dt, end_dt, model_filter)
    cost, cost_errors = _fetch_cost(session, start_dt, end_dt)
    caller = _fetch_caller(session)
    cloudshell = _fetch_cloudshell(session)
    quota_service = body.get('quotaServiceCode') or QUOTA_SERVICE_CODE
    quota_codes = body.get('quotaCodes') or QUOTA_CODES
    quotas = _fetch_quotas(session, regions, quota_service, quota_codes)
    errors = cw_errors + cost_errors

    result = {
        'success': True,
        'account': body.get('accountLabel'),
        'window': {'start': start_dt.isoformat(), 'end': end_dt.isoformat()},
        'models': models,
        'cost': cost,
        'caller': caller,
        'health': {'cloudshell': cloudshell},
        'quotas': quotas,
        'errors': errors,
    }
    return _resp(200, result)

<#
  Bedrock multi-account dashboard - one-click deploy (AWS CLI)
  Deploys:
    - S3 static website (frontend/)
    - Lambda (lambda/bedrock_dashboard.py) + execution role
    - API Gateway REST (/query, Lambda Proxy, CORS, API Key)
  Usage:
    powershell -ExecutionPolicy Bypass -File deploy/deploy.ps1 [-BucketName my-bucket] [-Region us-east-1]
  Prereqs:
    - AWS CLI installed and `aws configure` done (creds that can create S3/Lambda/API GW/IAM)
#>
param(
  [string]$BucketName = "bedrock-dashboard-$((Get-Random).ToString('x'))",
  [string]$Region = "us-east-1",
  [string]$LambdaName = "bedrock-dashboard",
  [string]$ApiName = "bedrock-dashboard-api"
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir

function Invoke-Aws { param([string[]]$CliArgs); & aws @CliArgs 2>&1; return $LASTEXITCODE }
function Aws-Out {
  param([string[]]$CliArgs)
  $out = & aws @CliArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "aws failed: $($CliArgs -join ' ') -> $out" }
  return ($out | Out-String).Trim()
}
function Aws-Ignore { param([string[]]$CliArgs); & aws @CliArgs 2>$null | Out-Null }
# AWS CLI --output text prints the literal "None" for null JMESPath results; normalize to $null.
function Norm-Val { param([string]$v); if ([string]::IsNullOrWhiteSpace($v) -or $v.Trim() -eq 'None') { return $null }; return $v.Trim() }
# apigateway import/put-rest-api expect the spec body base64-encoded.
function Api-BodyB64 { param([string]$path); return [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path)) }

# ---------- 0. prereqs ----------
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "aws cli not found. Install AWS CLI v2 and run 'aws configure'." }
$null = Aws-Out @('sts', 'get-caller-identity')
Write-Host "[1/9] AWS credential check OK" -ForegroundColor Green
$AccountId = Aws-Out @('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text')

# ---------- 1. package Lambda ----------
$tmp = Join-Path $env:TEMP "bd_lambda_build"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null
Copy-Item (Join-Path $Root "lambda\bedrock_dashboard.py") $tmp
if (Test-Path (Join-Path $ScriptDir "lambda.zip")) { Remove-Item (Join-Path $ScriptDir "lambda.zip") -Force }
Compress-Archive -Path "$tmp\*" -DestinationPath (Join-Path $ScriptDir "lambda.zip") -Force
Write-Host "[2/9] Lambda packaged" -ForegroundColor Green

# ---------- 2. S3 static site ----------
Aws-Ignore @('s3', 'mb', "s3://$BucketName")
$pol = [System.IO.File]::ReadAllText((Join-Path $ScriptDir "s3-policy.template.json")).Replace('__BUCKET__', $BucketName)
[System.IO.File]::WriteAllText((Join-Path $ScriptDir "s3-policy.json"), $pol)
Aws-Ignore @('s3api', 'put-public-access-block', '--bucket', $BucketName, '--public-access-block-configuration',
  'BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false')
Aws-Ignore @('s3api', 'put-bucket-policy', '--bucket', $BucketName, '--policy', "file://$(Join-Path $ScriptDir 's3-policy.json')")
Aws-Ignore @('s3', 'website', "s3://$BucketName", '--index-document', 'index.html', '--error-document', 'index.html')
Write-Host "[3/9] S3 bucket $BucketName configured as static site" -ForegroundColor Green

# ---------- 3. Lambda execution role ----------
$trustFile = Join-Path $ScriptDir "trust-policy.json"
Aws-Ignore @('iam', 'create-role', '--role-name', "$LambdaName-role", '--assume-role-policy-document', "file://$trustFile")
Aws-Ignore @('iam', 'attach-role-policy', '--role-name', "$LambdaName-role", '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole')
$roleArn = Aws-Out @('iam', 'get-role', '--role-name', "$LambdaName-role", '--query', 'Role.Arn', '--output', 'text')
Write-Host "[4/9] Lambda role OK" -ForegroundColor Green

# ---------- 4. create/update Lambda (idempotent) ----------
Aws-Ignore @('lambda', 'create-function', '--function-name', $LambdaName, '--runtime', 'python3.12', '--handler', 'bedrock_dashboard.lambda_handler', '--role', $roleArn, '--zip-file', "fileb://$(Join-Path $ScriptDir 'lambda.zip')", '--timeout', '30', '--memory-size', '256')
Start-Sleep -Seconds 2
Aws-Ignore @('lambda', 'update-function-code', '--function-name', $LambdaName, '--zip-file', "fileb://$(Join-Path $ScriptDir 'lambda.zip')")
Aws-Ignore @('lambda', 'update-function-configuration', '--function-name', $LambdaName, '--handler', 'bedrock_dashboard.lambda_handler', '--runtime', 'python3.12', '--role', $roleArn, '--timeout', '30', '--memory-size', '256')
$fnArn = Aws-Out @('lambda', 'get-function', '--function-name', $LambdaName, '--query', 'Configuration.FunctionArn', '--output', 'text')
Write-Host "[5/9] Lambda deployed: $fnArn" -ForegroundColor Green

# ---------- 6. API Gateway ----------
$spec = ([System.IO.File]::ReadAllText((Join-Path $ScriptDir "api-spec.template.json"))).Replace('__REGION__', $Region).Replace('__FNARN__', $fnArn)
[System.IO.File]::WriteAllText((Join-Path $ScriptDir "api-spec.json"), $spec)

$apiId = Norm-Val (Aws-Out @('apigateway', 'get-rest-apis', '--query', "items[?name=='$ApiName'].id | [0]", '--output', 'text'))
if (-not $apiId) {
  $apiId = Aws-Out @('apigateway', 'import-rest-api', '--body', (Api-BodyB64 (Join-Path $ScriptDir 'api-spec.json')), '--query', 'id', '--output', 'text')
} else {
  Aws-Ignore @('apigateway', 'put-rest-api', '--rest-api-id', $apiId, '--mode', 'overwrite', '--body', (Api-BodyB64 (Join-Path $ScriptDir 'api-spec.json')))
}
Aws-Ignore @('apigateway', 'create-deployment', '--rest-api-id', $apiId, '--stage-name', 'prod')
Write-Host "[6/9] API Gateway OK (id=$apiId)" -ForegroundColor Green

# ---------- 7. Lambda invoke permission ----------
Aws-Ignore @('lambda', 'add-permission', '--function-name', $LambdaName, '--statement-id', 'apigw-invoke', '--action', 'lambda:InvokeFunction', '--principal', 'apigateway.amazonaws.com', '--source-arn', "arn:aws:execute-api:${Region}:${AccountId}:${apiId}/*/*/query")

# ---------- 8. usage plan + API key ----------
$planId = Norm-Val (Aws-Out @('apigateway', 'get-usage-plans', '--query', "items[?name=='bedrock-plan'].id | [0]", '--output', 'text'))
if (-not $planId) {
  $planId = Aws-Out @('apigateway', 'create-usage-plan', '--name', 'bedrock-plan', '--throttle', 'burstLimit=20,rateLimit=10', '--quota', 'limit=20000,period=DAY', '--query', 'id', '--output', 'text')
}
Aws-Ignore @('apigateway', 'update-usage-plan', '--usage-plan-id', $planId, '--patch-operations', "op=add,path=/apiStages,value=${apiId}:prod")
$keyId = Norm-Val (Aws-Out @('apigateway', 'get-api-keys', '--name-query', 'bedrock-key', '--query', "items[?name=='bedrock-key'].id | [0]", '--output', 'text'))
if (-not $keyId) {
  $keyId = Aws-Out @('apigateway', 'create-api-key', '--name', 'bedrock-key', '--enabled', '--query', 'id', '--output', 'text')
  Aws-Ignore @('apigateway', 'create-usage-plan-key', '--usage-plan-id', $planId, '--key-id', $keyId, '--key-type', 'API_KEY')
}
$apiKeyValue = Aws-Out @('apigateway', 'get-api-key', '--api-key', $keyId, '--include-value', '--query', 'value', '--output', 'text')
$apiBaseUrl = "https://${apiId}.execute-api.${Region}.amazonaws.com/prod/query"
Write-Host "[7/9] API key created" -ForegroundColor Green

# ---------- 9. write config.json and sync frontend ----------
$config = @{ apiBaseUrl = $apiBaseUrl; apiKey = $apiKeyValue } | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $Root "frontend\config.json") -Value $config -Encoding UTF8
Aws-Out @('s3', 'sync', (Join-Path $Root "frontend"), "s3://$BucketName", '--delete') | Out-Null
Write-Host "[8/9] Frontend synced to S3" -ForegroundColor Green

# ---------- done ----------
Write-Host ""
Write-Host "===== Deploy complete =====" -ForegroundColor Cyan
Write-Host "Website:  http://$BucketName.s3-website-$Region.amazonaws.com" -ForegroundColor White
Write-Host "API:      $apiBaseUrl" -ForegroundColor White
Write-Host "API Key:  $apiKeyValue" -ForegroundColor White
Write-Host "(API key auto-written to frontend/config.json; for HTTPS put CloudFront in front of the S3 bucket)" -ForegroundColor DarkGray

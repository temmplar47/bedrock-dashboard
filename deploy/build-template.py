#!/usr/bin/env python3
"""Build the packaged Lambda zip for the single-Lambda Bedrock dashboard.

Steps:
  1. Inline frontend/styles.css + frontend/app.js into frontend/index.html
     (single-file page).
  2. Embed that page into lambda/bedrock_dashboard.py as the PAGE_HTML string.
  3. Zip the result as deploy/lambda.zip (handler: bedrock_dashboard.lambda_handler).

The packaged code is large (the page is ~25 KB, the whole .py ~30+ KB), so it
cannot use CloudFormation's inline ZipFile (4096-byte cap). Instead, upload
deploy/lambda.zip to an S3 bucket and deploy cfn/template.yaml, passing that
bucket/key as the LambdaCodeBucket / LambdaCodeKey parameters.

Usage: python deploy/build-template.py
"""

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def fail(msg):
    print(f'build-template: {msg}', file=sys.stderr)
    sys.exit(1)


def main():
    # ---------- 1. single-file frontend page ----------
    html = (ROOT / 'frontend' / 'index.html').read_text(encoding='utf-8')
    css = (ROOT / 'frontend' / 'styles.css').read_text(encoding='utf-8')
    js = (ROOT / 'frontend' / 'app.js').read_text(encoding='utf-8')

    css_tag = '<link rel="stylesheet" href="styles.css">'
    js_tag = '<script src="app.js"></script>'
    if css_tag not in html:
        fail(f'styles tag not found in index.html: {css_tag}')
    if js_tag not in html:
        fail(f'script tag not found in index.html: {js_tag}')
    page = html.replace(css_tag, '<style>\n' + css + '\n</style>')
    page = page.replace(js_tag, '<script>\n' + js + '\n</script>')

    # ---------- 2. embed page into the lambda source ----------
    py_path = ROOT / 'lambda' / 'bedrock_dashboard.py'
    py = py_path.read_text(encoding='utf-8')
    marker = "PAGE_HTML = ''"
    if marker not in py:
        fail(f'marker not found in {py_path}: {marker}')
    # ensure_ascii=False keeps CJK as UTF-8 (python3 sources are UTF-8 by default).
    # A JSON string literal is also a valid Python string literal.
    py = py.replace(marker, 'PAGE_HTML = ' + json.dumps(page, ensure_ascii=False))
    if '\t' in py:
        fail('lambda source contains TAB characters - not allowed')

    bundled = ROOT / 'lambda' / 'bundled.py'
    bundled.write_text(py, encoding='utf-8', newline='\n')

    # ---------- 3. zip as deploy/lambda.zip ----------
    zip_path = ROOT / 'deploy' / 'lambda.zip'
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(bundled, 'bedrock_dashboard.py')

    print(f'OK: bundled lambda -> {zip_path} ({zip_path.stat().st_size} bytes)')
    print('Next:')
    print('  aws s3 cp deploy/lambda.zip s3://<YOUR-BUCKET>/lambda.zip')
    print('  aws cloudformation deploy --template-file cfn/template.yaml \\')
    print('    --stack-name bedrock-dashboard --capabilities CAPABILITY_IAM \\')
    print('    --parameter-overrides LambdaCodeBucket=<YOUR-BUCKET> LambdaCodeKey=lambda.zip \\')
    print('    --region us-east-1')


if __name__ == '__main__':
    main()

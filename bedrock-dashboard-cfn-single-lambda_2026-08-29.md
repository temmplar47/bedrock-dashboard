# Bedrock 控制面板：改为单 Lambda 直部署 CloudFormation（2026-08-29）

## 背景
用户要求：(1) 修部署脚本报错；(2) 写成**可直接部署到 CloudFormation 的模板**，而不是通过本地 powershell 部署，且要最少服务/最低成本。

复核发现：README 已被改为「单 Lambda + Function URL」设计（GET 返回页面、POST 代理查询，无 S3、无 API Gateway，~$0/月），方向正确。
但原 `deploy/build-template.py` + 旧 README 把整个 Lambda（内联页面后约 30+ KB）塞进 CloudFormation `Code.ZipFile` 字面量 —— **ZipFile 内联有 4096 字节硬上限**，该方案在部署时会失败。旧的 `deploy-cfn.ps1`（路径解析 bug，且是 S3+package 旧思路）也已被弃用。

## 本次改动
- `cfn/template.yaml`（重写）：**单 Lambda + Function URL**。不再创建 S3 静态站桶。Lambda 代码通过参数 `LambdaCodeBucket` / `LambdaCodeKey` 从用户已有 S3 桶读取（绕过 ZipFile 4096 限制的标准做法）。仅含 IAM Role / Function / FunctionUrl / Permission。可直接在控制台 Create stack 或 `aws cloudformation deploy` 部署，**无本地脚本**。
- `deploy/build-template.py`（重写）：把 frontend（css+js 内联进 index.html）→ 嵌入 `bedrock_dashboard.py` 的 `PAGE_HTML` → 打包为 `deploy/lambda.zip`（handler `bedrock_dashboard.lambda_handler`）。`aws cloudformation deploy` 提示命令也写好。
- `lambda/bedrock_dashboard.py`：保持单 Lambda（GET 返回内嵌页面、POST 查询代理、OPTIONS CORS），无改动。
- `README.md`（重写）：文档化为「构建 → 上传 lambda.zip 到 S3 → 部署 template.yaml」三步；删除 `deploy-cfn.ps1` 引用；明确说明 ZipFile 4096 限制为何需要一次性上传 lambda.zip。
- 清理：`cfn/deploy.yaml`（旧 ZipFile 版，已废）、`lambda/bundled.py`、`lambda/__pycache__` 删除。删除了 `deploy-cfn.ps1`。

## 校验
- `python deploy/build-template.py` 成功生成 `deploy/lambda.zip`（11,124 字节 deflated，内含 `bedrock_dashboard.py`）。
- `python -m py_compile lambda/bundled.py` 退出码 0（编译通过）。
- 页面不依赖 `config.json`：同源部署时 `fetch('config.json')` 返回 HTML 导致 `res.json()` 抛错，被 try/catch 吞掉，`apiBaseUrl` 回退为 `location.origin`（即 Function URL），POST 同源。✅

## 部署步骤（用户执行）
```powershell
python deploy/build-template.py
aws s3 cp deploy/lambda.zip s3://<你的代码桶>/lambda.zip
aws cloudformation deploy --template-file cfn/template.yaml --stack-name bedrock-dashboard `
  --capabilities CAPABILITY_IAM `
  --parameter-overrides LambdaCodeBucket=<你的代码桶> LambdaCodeKey=lambda.zip --region us-east-1
# 取地址
aws cloudformation describe-stacks --stack-name bedrock-dashboard `
  --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" --output text
```
打开输出的 DashboardUrl 即面板，页面与 API 同源，无需任何配置。

## 注意
- `LambdaCodeBucket` 必须与部署区域同区域。
- API Gateway 旧路径（`deploy/deploy.ps1`，带 API Key）现已不推荐；之前卡的 `create-usage-plan --throttle burst=20` 参数名也已在那脚本里改为 `burstLimit=20,rateLimit=10`，但本方案不再需要它。
- 之前的「账户级 S3 Block Public Access」问题在单 Lambda 方案下不复存在（没有公开 S3 桶）。

## 待办 / 未验证
- 真实 AWS 部署尚未跑（用户凭证在 Windows PowerShell 5.1 环境）；上面三步是预期流程，需用户实际执行确认。

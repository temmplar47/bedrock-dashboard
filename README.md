# Amazon Bedrock 多账户云监控面板

一个**轻量、可查询多账户**的 Bedrock CloudWatch 自动控制面板：

- 🔑 **自助上传访问密钥（免填账户名）**：前端表单录入各账户的 Access Key / Secret /（可选）Session Token 与区域，**账户名称自动读取**——后端用 STS `GetCallerIdentity` 拿到真实 Account ID 作为账户名（无需额外权限，只有显式 Deny 才会拦）。可选择保存到本机浏览器（localStorage）或仅本次会话使用，随时可单个删除或一键清除。
- 📊 **可自定义时间范围**：顶栏下拉切换**相对**预设（最近 1/6/24 小时、本月、上月）或**自定义绝对时间**（datetime 选择器）；CloudWatch/成本查询均按所选范围执行，成本粒度自动适配（短窗口 HOURLY、长窗口 DAILY）。核心图表 **Token Counts by Model（各模型输入/输出 Token）**，另含调用次数、平均延迟、各账户成本占比。
- 💰 **总成本**：通过 Cost Explorer `GetCostAndUsage` 统计本窗口内 Amazon Bedrock 费用。
- 📏 **服务配额 + 账户健康探测**：通过 Service Quotas `GetServiceQuota` 查询配额码 **L-D06938E7**（Bedrock，按账户/区域显示当前值）。这张表还是一张现成的「账户健康探针」面板——**可间接判断账户是否被封/受限**：
  - **配额能正常返回数值** → 密钥有效、账户状态正常；
  - **`AccessDenied` / 账户级错误** → 往往意味着密钥失效、账户被停用（如欠费封停）或被组织策略限制；悬停报错单元格可看具体原因。
  - **「账户健康探测」表（新增）**：STS 身份列显示 Account ID / 身份 ARN（凭证有效即正常）；**CloudShell 探测列**调用 CloudShell `ListEnvironments`（只读，us-east-1）。当账户被 AWS 风控/验证时，控制台打开 CloudShell 会报「无法创建环境。正在验证您的账户」，此时 **STS 和成本查询仍正常，唯独 CloudShell API 报账户级错误**——这正是区分「账户被风控」与「单纯密钥问题」的判别信号。若显示「密钥无 CloudShell 权限」，只是该密钥未授予 `cloudshell:ListEnvironments`，不影响健康判断。
- 🕒 **本地时区**：自动识别浏览器时区并显示数据窗口的本地时间。
- 🔄 **15 分钟自动刷新**：内置定时器，也支持手动刷新与账户/模型筛选。
- 🚀 **部署形态（推荐：Lambda + API Gateway HTTP API）**：**1 个 Lambda + 1 个 HTTP API（$default 阶段）**，没有 S3 静态站、没有 API Key，免费额度内**约等于 $0/月**。Lambda Function URL 在部分组织被 SCP 禁止，本方案使用 API Gateway 端点规避。

## 架构（推荐：Lambda + API Gateway HTTP API）

**1 个 Lambda 函数 + 1 个 API Gateway HTTP API**：前端页面（构建时内联进函数代码）与查询 API 由同一个 API Gateway 端点提供。页面与 API **同源**，前端自动把当前站点作为查询地址，**无需任何配置**。

```
浏览器 ──GET──>  API Gateway HTTP API $default → Lambda → 返回内嵌的单文件监控页面
        └─POST─>  同一端点                     → 用请求体里的密钥查询:
                      ├─ CloudWatch GetMetricData      → 各模型 Token / 调用 / 延迟
                      ├─ Cost Explorer GetCostAndUsage → Bedrock 本窗口成本
                      └─ Service Quotas GetServiceQuota → 配额 L-D06938E7
```

> Lambda 代码（内联页面后约 30+ KB）超过 CloudFormation `ZipFile` 内联上限（4096 字节），
> 因此代码从你已有的 S3 桶加载（模板参数 `LambdaCodeBucket` / `LambdaCodeKey`）。这是标准做法，
> 只需部署前把 `lambda.zip` 上传一次，**不需要任何本地部署脚本**。

## 目录结构

```
bedrock-dashboard/
├── lambda/bedrock_dashboard.py     # Lambda：GET 返回内嵌页面 / POST 查询代理（python3.12）
├── frontend/                       # 前端源文件（index.html / styles.css / app.js）
├── cfn/template.yaml               # 直接可部署的 CloudFormation 模板（Lambda 代码从 S3 读取）
└── deploy/
    ├── build-template.py           # 构建脚本：内联前端到 Lambda → 生成 deploy/lambda.zip
    ├── lambda.zip                  # 构建产物（打包后的 Lambda，需先上传到 S3）
    ├── deploy.ps1                  # 旧方案：S3 + API Gateway + Lambda（带 API Key），不推荐
    └── iam-policy.json             # 上传密钥所需的 IAM 权限（给用户自己的密钥）
```

## 前提条件

- 已安装 [AWS CLI](https://aws.amazon.com/cli/) 并执行 `aws configure`（执行部署的凭证需能创建 Lambda / IAM / CloudFormation）。
- 目标账户已**启用 Cost Explorer**（成本数据才会有；未启用时成本显示为 0 并在明细中报错）。
- 浏览器可访问 `cdn.jsdelivr.net`（页面从 CDN 加载 Chart.js）。
- （重新构建时需要）Python 3 — 运行 `deploy/build-template.py` 生成 `deploy/lambda.zip`。

## 部署（直接对 CloudFormation，无需本地脚本）

分三步：构建 → 上传 Lambda 代码到 S3 → 部署模板。

**1. 构建 Lambda 包**（把前端内联进 Lambda 代码）：

```powershell
python deploy/build-template.py
# 生成 deploy/lambda.zip
```

**2. 上传到任意 S3 桶**（需与部署区域同区域；控制台拖拽也可）：

```powershell
aws s3 cp deploy/lambda.zip s3://<你的代码桶>/lambda.zip
```

**3. 部署栈**——控制台「Create stack」上传 `cfn/template.yaml`，在参数页填 `LambdaCodeBucket` / `LambdaCodeKey`；或用 CLI：

```powershell
aws cloudformation deploy --template-file cfn/template.yaml `
  --stack-name bedrock-dashboard --capabilities CAPABILITY_IAM `
  --parameter-overrides LambdaCodeBucket=<你的代码桶> LambdaCodeKey=lambda.zip `
  --region us-east-1
```

等栈 `CREATE_COMPLETE` 后取面板地址：

```powershell
aws cloudformation describe-stacks --stack-name bedrock-dashboard `
  --query "Stacks[0].Outputs[?OutputKey=='DashboardUrl'].OutputValue" --output text
```

完成后输出：

- **Dashboard**: `https://<api-id>.execute-api.<region>.amazonaws.com/` —— 打开即是面板，页面与 API 同源，**无需任何配置**。

> 若你的组织 SCP 同时禁止了公开的 API Gateway 端点，可把 `AWS::ApiGatewayV2::Api` 加上
> `DisableExecuteApiEndpoint: true` 并自接自定义域名/私有集成；一般组织只限制 Lambda Function URL。

删除所有资源（连密钥都不会留下，因为服务端从不保存）：

```bash
aws cloudformation delete-stack --stack-name bedrock-dashboard --region us-east-1
```

## 修改前端 / Lambda 后重新部署

```bash
python deploy/build-template.py        # 重新生成 deploy/lambda.zip
aws s3 cp deploy/lambda.zip s3://<你的代码桶>/lambda.zip
# 若函数已存在，刷新代码（同一 S3 key 不会触发栈更新）：
aws lambda update-function-code --function-name bedrock-dashboard `
  --s3-bucket <你的代码桶> --s3-key lambda.zip --region us-east-1
```

## 上传密钥所需的 IAM 权限

你（或同事）在面板里录入的**每一组 AWS 密钥**，只需以下只读权限（见 `deploy/iam-policy.json`）。建议为这些密钥创建**专用 IAM 用户/角色**，并优先使用带 `Session Token` 的**临时密钥**：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockDashboardRead",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricData",
        "cloudwatch:ListMetrics",
        "ce:GetCostAndUsage",
        "servicequotas:GetServiceQuota",
        "sts:GetCallerIdentity",
        "cloudshell:ListEnvironments"
      ],
      "Resource": "*"
    }
  ]
}
```

> 多账户组织场景：Cost Explorer 在「成员账户」只能看到该账户自身费用；如需看合并账单总成本，请用**管理/付款账户**的密钥，或在该账户开启 Cost Explorer。

## 使用

1. 打开部署输出的 Dashboard 地址（无需设置 API 地址——同源自动生效）。
2. 点「+ 添加账户」→ 录入密钥、区域（多区域用逗号分隔，如 `us-east-1,us-west-2`）。**无需填写账户名称**——首次查询后自动用 STS 读出的 Account ID 命名。
   - 勾选「保存到本机浏览器」：密钥存入 localStorage，下次打开自动加载。
   - 不勾选：仅本次会话有效（账户标签显示"临时"），关闭页面即从内存清除。
   - 单个账户可随时「×」删除；「清除已存密钥」按钮一键删除本机保存的全部密钥。
3. 面板自动加载并每 15 分钟刷新；可用下拉框按账户筛选，或用「手动刷新」。

## 安全说明

- 密钥默认存于浏览器 `localStorage`（可关闭持久化），每次请求经 HTTPS 发往 Lambda 临时使用，**服务端不落盘**。
- API Gateway 端点为公开（无鉴权）。任何知道 URL 的人都能打开**页面**，但查到数据需要有效的 AWS 密钥。
- Lambda 执行角色只有写 CloudWatch Logs 的权限，无任何数据面权限（查询全部用调用方密钥）。
- 如在公网使用，强烈建议：① 用临时密钥（STS）；② 给上传密钥遵循最小权限。

## 排错

- **DashboardUrl 取不到**：检查 `aws cloudformation describe-stacks` 是否 `CREATE_COMPLETE`；确认 `LambdaCodeBucket` 与部署区域同区域且含 `lambda.zip`。
- **页面打不开 / 500**：`LambdaCodeBucket`/`LambdaCodeKey` 指向的 `lambda.zip` 不存在或区域不符；CloudWatch Logs `/aws/lambda/bedrock-dashboard` 看错误。
- **图表空白 / 无数据**：确认窗口内有 Bedrock 调用（模型指标仅在产生调用时才有）；确认区域填的是实际调用 Bedrock 的区域。
- **成本为 0 或报错**：该账户未启用 Cost Explorer；或成员账户看不到合并账单（用管理账户密钥）。
- **凭证无效**：检查 Access Key / Secret / Session Token 是否匹配、区域是否正确、以及是否具备上面的最小权限。
- **重新部署未生效**：确认先跑了 `python deploy/build-template.py` 重新生成 `deploy/lambda.zip` 并上传（或用 `update-function-code`）。

## 限制

- CloudWatch `SEARCH` 单查询返回时间序数量有上限（通常数百），绝大多数账户足够；超大规模模型矩阵可改为显式枚举 ModelId。
- Cost Explorer 数据有时间延迟（小时级），且免费额度下调用频率受限；多账户高频刷新时留意节流。
- Lambda 以「代理」方式使用调用方密钥，因此每次刷新都会用真实密钥签名请求——这是「自助上传密钥」方案的固有取舍，权衡了零服务端存储与易部署性。
- 页面内嵌在函数代码中（约 25 KB），每次打开页面都是一次 Lambda 调用（免费额度内可忽略）；修改前端需重新构建部署。

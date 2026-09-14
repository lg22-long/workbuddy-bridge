# workbuddy-bridge

[English](README.md) · **中文**

把**本机已登录的 CodeBuddy / WorkBuddy 桌面端会话**（腾讯代码助手），暴露成本地
**OpenAI 兼容端点**，让任何支持自定义 base URL 的客户端复用你自己的订阅，而不用另买 API key。

```
你的客户端（DeepSeek Harness / Cherry Studio / Open WebUI / 任意 OpenAI SDK）
      │  POST http://127.0.0.1:8790/v1/chat/completions
      ▼
workbuddy-bridge.mjs        （只监听 127.0.0.1）
      │  1. 读取本机桌面端登录态
      │  2. 注入鉴权 / 追踪请求头
      │  3. 保证流式
      ▼
copilot.tencent.com/v2/chat/completions     （后端本身就是 OpenAI 协议）
```

## 为什么需要这层桥

上游后端的三条行为（均在真实服务上实测确认）决定了必须有这层代理：

| 后端行为 | 后果 |
|---|---|
| 没有公开的 OpenAI 兼容端点，鉴权方式是桌面端 OAuth 会话 | 必须有人读登录态并注入鉴权头 |
| `POST /v2/chat/completions` 拒绝非流式请求（`400 code 11101 Non-stream chat request is currently not supported`） | 非流式客户端请求必须内部转成流式再聚合 |
| access token 约 60 天有效（refresh token 约 90 天） | 必须自动刷新并回写登录态，否则几天后全是 401 |

后端原生支持 `tools` / `tool_calls` / SSE / `usage`，所以本桥**不做协议翻译**——只做鉴权注入和流式保证。

## 环境要求

- Node.js 18+（无任何 npm 依赖，只用 Node 内置模块）
- **CodeBuddy / WorkBuddy 桌面端已安装并登录**
- Windows / macOS / Linux 均可——登录文件按各平台标准位置自动探测，也可用 `WORKBUDDY_AUTH_FILE` 覆盖

## 快速开始

```bash
# 只预检，不启动：打印登录文件路径、账号、端点、token 到期时间
node workbuddy-bridge.mjs --check

# 前台运行（Ctrl+C 停止）
node workbuddy-bridge.mjs

# 或用启动脚本
./start-workbuddy-bridge.sh --background          # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\start-workbuddy-bridge.ps1 -Background   # Windows
```

验证：

```bash
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/v1/models

# 端到端自检：流式、工具调用、非流式聚合、多轮 tool 结果回传
node verify-bridge.mjs
```

停止：

```bash
# macOS / Linux —— 启动脚本会打印 pid
kill <pid>

# Windows
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8790 -State Listen).OwningProcess
```

## 端点

| 端点 | 说明 |
|---|---|
| `GET /health` | 登录态、token 到期时间、实际读取的登录文件、已挂载模型 |
| `GET /v1/models` | 精选模型列表 |
| `GET /v1/models?all=1` | 账号可用的全部模型，含上下文窗口与图像支持 |
| `POST /v1/chat/completions` | 标准 OpenAI chat completions，支持 `stream` 与 `tools` |

## 从 DeepSeek Harness 使用

在 `~/.dsh/settings.yaml` 里加一个 provider：

```yaml
llm-pi-ai:
  providers:
    workbuddy:
      displayName: WorkBuddy
      apiKeyEnv: WORKBUDDY_BRIDGE_KEY    # 占位凭据，见下方说明
      api: openai-completions
      baseURL: http://127.0.0.1:8790/v1
      models:
        - id: deepseek-v4-pro            # 必须与上游模型 id 完全一致
          name: DeepSeek-V4-Pro
          contextWindow: 1000000
          maxTokens: 50000
          input: [text, image]
```

并在 `~/.dsh/.credentials.yaml` 里加占位凭据：

```yaml
refs:
  WORKBUDDY_BRIDGE_KEY: wb-local-bridge
```

**为什么需要占位凭据**：pi-ai 的 OpenAI 兼容实现强制要求一个 API key 或 `Authorization` 头，即使服务端不校验。
本桥只监听回环地址，默认不校验；设 `WORKBUDDY_LOCAL_TOKEN` 可要求校验。

想让它成为新会话的默认模型：

```yaml
agent-default-model:
  provider: workbuddy
  model: deepseek-v4-pro
  reasoningEffort: high
```

## 从其他 OpenAI 客户端使用

把客户端的 base URL 指向 `http://127.0.0.1:8790/v1`，API key 留空（或用 `WORKBUDDY_LOCAL_TOKEN` 的值），
模型名从 `/v1/models?all=1` 里选任意一个。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `WORKBUDDY_PORT` | `8790` | 监听端口 |
| `WORKBUDDY_HOST` | `127.0.0.1` | 绑定地址。**不要**用 `0.0.0.0`，那等于把订阅额度暴露给整个网络 |
| `WORKBUDDY_LOCAL_TOKEN` | 空 | 设了之后，本地端点要求携带同名 Bearer token |
| `CODEBUDDY_API_KEY` | 空 | 改用 API key，而不是桌面端登录态 |
| `CODEBUDDY_ENDPOINT` | 自动 | 覆盖上游 base URL |
| `WORKBUDDY_AUTH_FILE` | 自动探测 | 覆盖桌面端登录文件路径 |
| `WORKBUDDY_LOG` | 空 | `=1` 打印每请求的模型名、消息数、工具数 |
| `WORKBUDDY_SHAPE` | 空 | `=1` 额外打印请求**形状**（body 键、各角色消息数、字符数、工具名、请求头名、UA）。**绝不记录对话正文** |
| `WORKBUDDY_TIMEOUT_MS` | `0` | 上游超时；`0` 表示不限（长回答需要） |

## 鉴权与刷新

- 读取桌面端登录文件（按平台自动探测，文件名形如 `workbuddy-desktop.info`）
- access token 距过期 < 5 分钟时，调 `POST /v2/plugin/auth/token/refresh` 刷新
- 刷新结果**原子回写**（临时文件 + rename），带跨进程锁和"别人刚刷过就跳过"判断，不会与桌面端互相覆盖
- 上游返回 401/403 时刷新一次并重发（15 秒冷却防抖）
- 上游偶发 `400 code 11133`（网关把瞬时故障包装成 400）时按退避幂等重发

## 兼容性说明

1. **上游不接受 `role: "developer"`**。后端对 OpenAI 新规范的 `developer` 角色直接返回
   `400 code 11128 Illegal API invocation from an unapproved channel`，而官方客户端只用 `system`。
   本桥会在转发前就地改写这些消息，并打印 `normalize: rewrote N developer message(s) -> system`。
2. **网关会检查客户端身份**。部分 `User-Agent` 会被拒（`code 11128 request illegal`）。
   因此本桥发送官方客户端的 `User-Agent`，而不是自己的。
3. **非流式请求**会被内部转成流式，再聚合回单个 `chat.completion` 响应，
   保留 `content`、`reasoning_content`、`tool_calls`、`finish_reason` 和 `usage`。
4. **`reasoningEffort`** 只是请求侧提示；实际思考档位由后端每个模型的 `supportedEfforts` 决定。
5. **偶发瞬时拒绝**。即使请求完全合法，网关也可能短时返回 `11128`，通常几分钟内自行恢复。避免高频重试。

## 排障

查看日志（`--background` 时在 `bridge.log`，前台则直接看输出）：

```powershell
# Windows PowerShell 5.1 默认按 ANSI 读文件，而日志是 UTF-8
Get-Content .\bridge.log -Encoding UTF8 -Tail 40 -Wait
```

| 现象 | 含义 |
|---|---|
| `normalize: rewrote ... developer ... -> system` | 角色兼容修复已生效（正常） |
| `upstream error 400 {"code":11128,...Illegal API invocation from an unapproved channel}` | 负载被拒——通常是 `developer` 角色没被改写 |
| `upstream error 400 {"code":11128,...request illegal}` | 请求头被拒——通常是 UA 命中黑名单 |
| `401` / `403` | 桌面端会话已过期，重新登录桌面端 |
| `/health` 返回 `503` | 读不到登录文件——看它打印的路径对不对 |

需要详细比对时，用 `WORKBUDDY_SHAPE=1` 启动，把日志里的请求形状与已知可用的形状做 diff。

## 文件说明

| 文件 | 作用 |
|---|---|
| `workbuddy-bridge.mjs` | 代理主体（无依赖，Node 18+） |
| `start-workbuddy-bridge.ps1` | Windows 启动脚本（预检 / 前台 / 后台） |
| `start-workbuddy-bridge.sh` | macOS / Linux 启动脚本 |
| `verify-bridge.mjs` | 端到端自检：health、models、流式、工具调用、非流式聚合、多轮 tool 结果回传 |
| `verify-fix.mjs` | 专项自检：`developer` → `system` 角色改写 |

两个 verify 脚本都会发出**真实请求**，因此会消耗少量订阅额度。

## 安全

- 只绑定回环地址。绑 `0.0.0.0` 会让所有能访问该端口的机器都用到你的订阅。
- 从不记录、不落盘 token，也从不记录对话正文。`WORKBUDDY_SHAPE=1` 只记录结构（数量、大小、名称）。
- 它读取的登录文件里含有可用的 OAuth token。请保留 `.gitignore`，不要提交 `*.info`、日志或凭据文件。

## 免责声明

本项目与腾讯、CodeBuddy、WorkBuddy 无任何关联，未获其认可或支持。
这是一个互操作性适配层，用途是让**你自己合法持有**的订阅，能在**你自己选择**的客户端里使用。
请仅在遵守你账号适用服务条款的前提下使用，风险自负。上游网关可能随时变更或阻断此方式。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

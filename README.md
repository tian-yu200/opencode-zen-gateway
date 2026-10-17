# opencode-zen-gateway

把 **OpenCode Zen 免费档**模型封装成 **OpenAI 兼容 API**，任何客户端都能用。

不需要 new-api，不需要 Resin 代理池，不需要装 opencode CLI，不需要机场订阅。一个 Node 容器搞定。

```bash
curl -X POST http://127.0.0.1:8791/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"beam-free","messages":[{"role":"user","content":"hi"}]}'
```

## 来源与致谢

> **核心指纹逻辑移植自 [jcleng/opencode-free-provider](https://github.com/jcleng/opencode-free-provider)（MIT）。**
>
> 那份项目的 `src/fingerprint.js` 通过消融实验定位出了上游 gate 的判定规则（尤其是 `counter <= 63` 这一条），本项目的 `zen-gateway/fingerprint.js` 是其逻辑的移植重写版本。
>
> 本项目的增量部分：
> - 独立的 OpenAI 兼容网关（`server.js`）：SSE → 非流式聚合、`tool_calls` 增量合并、`reasoning_content` 透传
> - `tools.json`：从真实 opencode CLI 抓包提取的 11 个工具定义
> - `User-Agent` 取自实际客户端抓包（`opencode/1.18.32 ...`），非猜测
> - Docker 编排与部署说明

同类项目还有 [jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api)（Go 实现，带 WebUI）和 [TiaraBasori/OpenCode2API](https://github.com/TiaraBasori/OpenCode2API)。

## 上游校验的三道闸门

裸请求会被拒：`403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`。

gate 实际校验三件事，缺一即 403：

| # | 条件 | 说明 |
|---|---|---|
| 1 | `User-Agent` | 必须 `opencode/<ver> ...`，版本 ≥ 1.18（低于则 `426`） |
| 2 | `x-opencode-session` | opencode 真实 ID 格式，**counter 必须 ≤ 63** |
| 3 | 请求体带齐官方 tools 清单 + `stream: true` | 少一个工具或 `stream:false` 都 403 |

第 3 条容易被忽略。消融实验：

```
tools + stream:true    → 200 OK
tools + stream:false   → 403 FreeTier   ← 只差这一个字段
no tools + stream:true → 403 FreeTier
```

所以任何 `stream:false` 的请求必挂。本网关在内部**强制转成流式**，再把 SSE 聚合成非流式返回给调用方 —— 调用方想怎么用都行。

### session id 的结构

`ses_` + 12 位小写 hex + 14 位 base62，共 26 字符（不含前缀）。hex 部分是 opencode 的 descending identifier：

```
~(Date.now() * 0x1000 + counter) & 0xffffffffffff
```

`counter` 低 12 位里，只有 `counter <= 63` 能过闸。本项目在超过 63 时自动推进到下一毫秒，而不是发出会被拒的 ID。

## 快速开始

```bash
git clone https://github.com/<you>/opencode-zen-gateway.git
cd opencode-zen-gateway
docker compose up -d
```

验证：

```bash
curl http://127.0.0.1:8791/health
curl http://127.0.0.1:8791/v1/models
```

不用 Docker 也行：

```bash
cd zen-gateway && node server.js
```

## 客户端配置

| 项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8791/v1` |
| API Key | 随便填（除非设了 `GATEWAY_KEY`） |
| Model | `beam-free` / `longcat-2.5-preview-free` / `deepseek-v4.1-flash-free` … |

流式、非流式、function calling 都支持。

## 模型清单

`GET /v1/models` 是权威来源。写死的一份参考：

```
beam-free
mimo-v2.6-flash-free
nemotron-3.5-super-vl-free
nemotron-3.5-lightning-free
longcat-2.5-preview-free
deepseek-v4.1-flash-free
glm-5.3-flash-free
space-bunny-free
```

名单会变（`muse-spark-1.3` 已转付费）。上游加了新免费模型但本仓库还没更新时，改 `fingerprint.js` 里的 `ZEN_MODELS` 即可。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8791` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（Docker 内设 `0.0.0.0`） |
| `GATEWAY_KEY` | 空 | 设置后客户端必须带 `Authorization: Bearer <key>` |
| `OPENCODE_UA` | `opencode/1.18.32 ...` | 上游抬高版本要求时改这里 |
| `ZEN_BASE` | `https://opencode.ai/inference/openai/v1` | 上游地址，走代理时改这里 |

## 目录结构

```
.
├── docker-compose.yml          网关容器编排
└── zen-gateway/
    ├── server.js               OpenAI 兼容网关主体
    ├── fingerprint.js          ID/UA 指纹生成器 + 模型清单
    ├── tools.json              11 个官方工具定义（抓包提取）
    ├── tools.js                工具集加载
    └── package.json
```

## 注意事项

- **免费额度按出口 IP 计**。用完了上游返回 `429 FreeUsageLimitError` + `retry-after`（小时级）。换 IP 可重置，但那是另一套东西（代理池），本项目不含。
- 免费档条款允许上游将数据用于训练。**别喂密码、密钥、隐私、公司内部资料。**
- 这个 gate 随时可能再变。真挂了就先抓一次真实 CLI 请求体，再更新 `tools.json` 和 `OPENCODE_UA`。
- 仅供学习研究，请遵守 OpenCode 的服务条款。

## License

MIT —— 见 [LICENSE](LICENSE)。第三方代码归属见 [NOTICE](NOTICE)。

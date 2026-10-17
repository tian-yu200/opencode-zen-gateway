import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  newSessionId,
  newMessageId,
  fingerprintHeaders,
  ZEN_MODELS,
} from "./fingerprint.js";
import { zenTools } from "./tools.js";

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM = process.env.ZEN_BASE || "https://opencode.ai/inference/openai/v1";
const API_KEY = process.env.GATEWAY_KEY || ""; // 空 = 不校验

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function authed(req) {
  if (!API_KEY) return true;
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${API_KEY}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 把调用方请求体改造成能过 gate 的形态
function buildUpstreamBody(callerBody, model) {
  const body = { ...callerBody };
  body.model = model;

  // 关键点 1：必须带齐官方工具集（调用方没带或带不全 → 补齐）
  body.tools = zenTools;
  body.tool_choice = body.tool_choice || "auto";

  // 关键点 2：必须流式（stream:false 一律 403）
  body.stream = true;
  body.stream_options = { include_usage: true };

  return body;
}

async function callUpstream(body) {
  const headers = {
    ...fingerprintHeaders(),
    "content-type": "application/json",
  };

  const res = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return res;
}

// 把上游 SSE 转成非流式响应（调用方要 stream:false 时）
async function collectStream(upstreamRes) {
  const text = await upstreamRes.text();
  const content = [];
  const reasoning = [];
  const toolCalls = new Map();
  let usage = null;
  let id = randomUUID();
  let model = "";

  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (obj.id) id = obj.id;
    if (obj.model) model = obj.model;
    if (obj.usage) usage = obj.usage;
    for (const ch of obj.choices || []) {
      const d = ch.delta || {};
      if (d.content) content.push(d.content);
      if (d.reasoning_content) reasoning.push(d.reasoning_content);
      for (const tc of d.tool_calls || []) {
        const idx = tc.index ?? 0;
        const cur = toolCalls.get(idx) || {
          id: tc.id || `call_${randomUUID().slice(0, 8)}`,
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        toolCalls.set(idx, cur);
      }
    }
  }

  const message = { role: "assistant", content: content.join("") };
  if (reasoning.length) message.reasoning_content = reasoning.join("");
  if (toolCalls.size) message.tool_calls = [...toolCalls.values()];

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.size ? "tool_calls" : "stop",
      },
    ],
    usage,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 健康检查
  if (url.pathname === "/health") {
    return json(res, 200, { ok: true, upstream: UPSTREAM, models: ZEN_MODELS.length });
  }

  if (url.pathname === "/v1/models") {
    if (!authed(req)) return json(res, 401, { error: { message: "unauthorized" } });
    return json(res, 200, {
      object: "list",
      data: ZEN_MODELS.map((m) => ({
        id: m,
        object: "model",
        created: 0,
        owned_by: "opencode-zen-free",
      })),
    });
  }

  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    if (!authed(req)) return json(res, 401, { error: { message: "unauthorized" } });

    let caller;
    try {
      caller = JSON.parse((await readBody(req)).toString() || "{}");
    } catch {
      return json(res, 400, { error: { message: "invalid json" } });
    }

    const wantStream = caller.stream === true;
    const model = caller.model || ZEN_MODELS[0];
    const upstreamBody = buildUpstreamBody(caller, model);

    let upstream;
    try {
      upstream = await callUpstream(upstreamBody);
    } catch (e) {
      return json(res, 502, { error: { message: `upstream error: ${e.message}` } });
    }

    if (!upstream.ok) {
      const errText = await upstream.text();
      // 透传上游错误（含 429 配额、403 指纹、400 协议）
      const code =
        upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
      res.writeHead(code, { "content-type": "application/json" });
      return res.end(errText);
    }

    if (wantStream) {
      // 透传 SSE
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // 代理模式下没有 ReadableStream，直接把已缓存的 SSE 文本推给调用方
      if (!upstream.body) {
        res.write(await upstream.text());
        return res.end();
      }
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(dec.decode(value, { stream: true }));
      }
      return res.end();
    }

    // 调用方要非流式 → 收集后返回
    const obj = await collectStream(upstream);
    return json(res, 200, obj);
  }

  json(res, 404, { error: { message: `not found: ${url.pathname}` } });
});

server.listen(PORT, HOST, () => {
  console.log(`zen-free-gateway listening on http://${HOST}:${PORT}`);
  console.log(`upstream: ${UPSTREAM}`);
  console.log(`models: ${ZEN_MODELS.join(", ")}`);
  console.log(`auth: ${API_KEY ? "enabled" : "disabled (open)"}`);
});

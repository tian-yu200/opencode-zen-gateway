// OpenCode Zen 免费档指纹生成器
//
// 上游 gate 校验三件事，缺一即 403 FreeTierError：
//   1. User-Agent 形如 opencode/<version> ...（版本 >= 1.18，否则 426）
//   2. x-opencode-session 是 opencode 的真实 ID 格式（counter 必须 <= 63）
//   3. 请求体必须带完整的官方 tools 清单 + stream: true
//
// 本文件只负责 (1)(2)；(3) 在 server.js 里拼装。
//
// 来源：本文件的 ID 生成逻辑移植自 jcleng/opencode-free-provider 的
// src/fingerprint.js（MIT License）。上游 gate 的判定规则（尤其是
// counter <= 63 这一条）由那个项目通过消融实验定位，本项目只做了
// 移植重写与本地复验，不是独立逆向的成果。
// https://github.com/jcleng/opencode-free-provider

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TAIL_LENGTH = 14; // opencode id 总长 26 = 12 hex + 14 base62
const MASK_48 = (1n << 48n) - 1n;
const COUNTER_SPAN = 0x1000n;
// 实测边界：counter <= 63 通过，>= 64 被拒
const MAX_COUNTER = 63;

let lastTs = 0;
let counter = 0;

function randomTail(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = "";
  for (let i = 0; i < n; i++) out += CHARS[bytes[i] % 62];
  return out;
}

/**
 * 复刻 opencode 的 ascending() / descending()。
 * descending 用于 session id，ascending 用于 message id。
 */
export function encodeIdentifier(now = Date.now(), { descending = false } = {}) {
  if (now !== lastTs) {
    lastTs = now;
    counter = 0;
  } else {
    counter++;
    // 同一毫秒内超出上限就推进到下一毫秒，避免发出会被拒的 counter
    if (counter > MAX_COUNTER) {
      lastTs = now + 1;
      counter = 0;
    }
  }
  const cur = (BigInt(lastTs) << 12n) + BigInt(counter);
  const v = (descending ? ~cur : cur) & MASK_48;
  const hex12 = v.toString(16).padStart(12, "0");
  return hex12 + randomTail(TAIL_LENGTH);
}

export function newSessionId() {
  return `ses_${encodeIdentifier(Date.now(), { descending: true })}`;
}

export function newMessageId() {
  return `msg_${encodeIdentifier(Date.now(), { descending: false })}`;
}

// 官方客户端 UA。版本号不能低于 1.18（老版本会被 426 拒绝）。
export const OPENCODE_UA =
  process.env.OPENCODE_UA ||
  "opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

// 上游地址。直连即可，走代理时换成代理 URL。
export const ZEN_BASE =
  process.env.ZEN_BASE || "https://opencode.ai/inference/openai/v1";

/**
 * 生成一套完整的伪装请求头。
 * 三个必需项：UA、x-opencode-client、x-opencode-session。
 */
export function fingerprintHeaders({ session, message } = {}) {
  return {
    Authorization: "Bearer public",
    "Content-Type": "application/json",
    "User-Agent": OPENCODE_UA,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-request": message || newMessageId(),
    "x-opencode-session": session || newSessionId(),
  };
}

// 2026-10 实测可用的免费模型。
// jev-1.13-free 走 systemone 协议，不适合本网关，已排除。
export const ZEN_MODELS = [
  "beam-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-super-vl-free",
  "nemotron-3.5-lightning-free",
  "longcat-2.5-preview-free",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "space-bunny-free",
];

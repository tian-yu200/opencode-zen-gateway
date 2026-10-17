// 官方工具指纹 —— 上游免费档要求请求体里必须带齐这些工具定义。
// 直接从真实 opencode CLI 抓包提取（opencode 1.18.32，11 个工具）。
// 提取方式见 README「上游校验的三道闸门」；这部分是本项目自行抓包所得。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 官方完整工具清单（11 个）。上游只认这份，缺一个就 403。 */
export const zenTools = JSON.parse(
  fs.readFileSync(path.join(here, "tools.json"), "utf8"),
);

/**
 * 把调用方自己的 tools 合并进官方清单。
 * 上游要求「包含」官方工具，所以做法是：以官方清单为基底，
 * 再追加调用方有而官方没有的工具。
 */
export function ensureTools(callerTools) {
  const list = zenTools.map((t) => t);
  if (!Array.isArray(callerTools)) return list;

  const have = new Set(list.map((t) => t?.function?.name ?? t?.name));
  for (const t of callerTools) {
    const name = t?.function?.name ?? t?.name;
    if (name && !have.has(name)) {
      list.push(t);
      have.add(name);
    }
  }
  return list;
}

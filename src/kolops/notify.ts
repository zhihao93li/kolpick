import { readFileSync } from "node:fs";
import type { Config } from "./config.js";

/** Feishu custom bots reject long messages; the daily summary stays well under this. */
const MAX_CHARS = 4000;

/**
 * `kol notify --file summary.txt`: posts a text message to the project's Feishu group bot (设置.飞书群机器人).
 * The text always starts with "KOL", so a bot guarded by the custom keyword KOL accepts it.
 */
export async function notifyGroup(cfg: Config, o: { file: string; dryRun: boolean; fetchImpl?: typeof fetch }) {
  if (!cfg.webhook) return { 发送: false, 原因: "「设置」里没填飞书群机器人，跳过" };
  const body = readFileSync(o.file, "utf8").trim();
  if (!body) throw new Error(`${o.file} 是空的`);
  const head = body.startsWith("KOL") ? "" : `KOL｜${cfg.project}\n`;
  const message = `${head}${body}`.slice(0, MAX_CHARS);
  if (o.dryRun) return { 发送: false, 试跑: true, 内容: message };
  const res = await (o.fetchImpl ?? fetch)(cfg.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text: message } }),
  });
  const data: any = await res.json().catch(() => ({}));
  // Feishu answers 200 with a non-zero code when it refuses (bad keyword, signature required, wrong URL).
  const code = data.code ?? data.StatusCode ?? (res.ok ? 0 : res.status);
  if (code !== 0) throw new Error(`飞书群机器人拒收（${code}：${data.msg ?? data.StatusMessage ?? res.statusText}）。如果开了安全设置，选「自定义关键词」并填 KOL，不要选签名校验`);
  return { 发送: true, 字数: message.length };
}

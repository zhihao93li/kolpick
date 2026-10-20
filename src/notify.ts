// Feishu group bot (custom bot webhook). Only sends text; no Feishu app needed.
// If the bot uses keyword security, add "KOL" as its keyword: every message starts with it.

export async function notifyFeishu(webhook: string, text: string): Promise<void> {
  if (!webhook) return;
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text: `KOL 平台：${text}` } }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (!res.ok || (body.code ?? 0) !== 0) console.warn("feishu notify failed", res.status, body.msg ?? "");
  } catch (err) {
    // A notification failing must never fail the job it reports on.
    console.warn("feishu notify failed", err);
  }
}

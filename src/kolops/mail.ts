import { cellTime } from "./base.js";
import type { Lark } from "./lark.js";

export interface MailSummary {
  message_id: string;
  thread_id: string;
  subject: string;
  from: string;
  date: string;
}

export interface SentMail {
  messageId: string;
  threadId: string;
}

export class MailBlocked extends Error {}

/** Feishu mail through lark-cli, always as the signed-in user, always from a named mailbox. */
export class Mail {
  constructor(private lark: Lark) {}

  async list(mailbox: string, filter: object, max = 400): Promise<MailSummary[]> {
    const data = await this.lark.json(["mail", "+triage", "--mailbox", mailbox, "--filter", JSON.stringify(filter),
      "--max", String(max), "--format", "json", "--as", "user"]);
    return (data?.messages ?? []).filter((m: any) => m.message_id && !m.error);
  }

  /** The newest message this address sent to the mailbox, to reply in the same thread. */
  async latestFrom(mailbox: string, address: string): Promise<MailSummary | undefined> {
    const list = await this.list(mailbox, { from: [address] }, 5);
    return list.sort((a, b) => (cellTime(b.date) ?? 0) - (cellTime(a.date) ?? 0))[0];
  }

  async send(o: { mailbox: string; to: string; subject: string; body: string; replyTo?: string }): Promise<SentMail> {
    const args = o.replyTo
      ? ["mail", "+reply", "--message-id", o.replyTo]
      : ["mail", "+send", "--to", o.to, "--subject", o.subject];
    args.push("--mailbox", o.mailbox, "--body", o.body, "--confirm-send", "--as", "user");
    if (o.replyTo && o.subject) args.push("--subject", o.subject);
    const data = await this.lark.json(args);
    // A mailbox setting can stop automated sending; the mail then stays a draft.
    if (data?.automation_send_disable_reason) {
      throw new MailBlocked(`邮箱设置拦截了自动发信：${data.automation_send_disable_reason} ${data.automation_send_disable_reference ?? ""}`.trim());
    }
    if (!data?.message_id) throw new Error(`发信没有返回 message_id：${JSON.stringify(data).slice(0, 300)}`);
    return { messageId: String(data.message_id), threadId: String(data.thread_id ?? "") };
  }

  /** Per-recipient delivery codes: 1 投递中, 2 重试, 3 退信, 4 成功, 5 待审批, 6 审批拒绝. */
  async status(mailbox: string, messageId: string): Promise<number[]> {
    const data = await this.lark.json(["mail", "user_mailbox.messages", "send_status",
      "--params", JSON.stringify({ user_mailbox_id: mailbox, message_id: messageId }), "--as", "user"]);
    const codes: number[] = [];
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        if (typeof v.status === "number") codes.push(v.status);
        Object.values(v).forEach(walk);
      }
    };
    walk(data);
    return codes;
  }
}

export const STATUS_NAMES: Record<number, string> = { 1: "投递中", 2: "投递失败重试", 3: "退信", 4: "投递成功", 5: "待审批", 6: "审批拒绝" };

export function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** Plain text drafts become simple HTML paragraphs so line breaks survive. */
export function toHtml(body: string): string {
  if (/<(p|div|br|ul|ol|table)\b/i.test(body)) return body;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const links = (s: string) => s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return body.trim().split(/\n{2,}/).map((para) => `<p>${links(esc(para)).replace(/\n/g, "<br>")}</p>`).join("\n");
}

/** A draft may start with a 主题：… line; the rest is the body. */
export function splitDraft(draft: string): { subject: string; body: string } {
  const m = draft.match(/^\s*(?:主题|主旨|Subject)\s*[:：]\s*(.+)\n/i);
  return m ? { subject: m[1].trim(), body: draft.slice(m[0].length).trim() } : { subject: "", body: draft.trim() };
}

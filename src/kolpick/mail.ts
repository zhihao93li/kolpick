/**
 * Feishu mail through lark-cli, always as the signed-in user, always from a named mailbox. The send and reply
 * shapes are the ones verified live on 2026-10-24: a reply with subject "Re: <original>" stays in its thread.
 */
import type { Lark } from "./lark.js";

export interface MailSummary {
  message_id: string;
  thread_id: string;
  subject: string;
  from: string;
  date: string;
}

export interface FullMail {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  to: string[];
  at: string;
  body: string;
  folder: string;
}

/** A mailbox setting stopped automated sending; the mail stayed a draft, so nothing went out. */
export class MailBlocked extends Error {}

export class Mail {
  constructor(private lark: Lark) {}

  /** Mail in one folder since a moment ("YYYY-MM-DDTHH:mm:ss+08:00" is the only form Feishu takes), newest first. */
  async since(mailbox: string, folder: "INBOX" | "SENT", startTime: string): Promise<MailSummary[]> {
    const out: MailSummary[] = [];
    let token = "";
    // Every page, so a busy stretch (more than one page since the cursor) loses nothing.
    for (let page = 0; page < 50; page++) {
      const args = ["mail", "+triage", "--mailbox", mailbox, "--filter", JSON.stringify({ folder_id: folder, time_range: { start_time: startTime } }),
        "--max", "400", "--format", "json", "--as", "user"];
      if (token) args.push("--page-token", token);
      const data = await this.lark.json(args);
      out.push(...(data?.messages ?? []).filter((m: any) => m.message_id && !m.error));
      token = data?.has_more ? String(data.page_token ?? "") : "";
      if (!token) return out;
    }
    throw new Error(`${mailbox} 这段时间的邮件太多，读不完；先不挪收信位置`);
  }

  /** The newest message this address sent to the mailbox, to reply in the same thread. */
  async latestFrom(mailbox: string, address: string): Promise<MailSummary | undefined> {
    const data = await this.lark.json(["mail", "+triage", "--mailbox", mailbox, "--filter", JSON.stringify({ from: [address] }),
      "--max", "5", "--format", "json", "--as", "user"]);
    const list: MailSummary[] = (data?.messages ?? []).filter((m: any) => m.message_id);
    return list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
  }

  /** Full plain-text mails, 20 per call as lark-cli batches them. */
  async read(mailbox: string, ids: string[]): Promise<FullMail[]> {
    const out: FullMail[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const data = await this.lark.json(["mail", "+messages", "--mailbox", mailbox, "--message-ids", ids.slice(i, i + 20).join(","),
        "--html=false", "--format", "json", "--as", "user"]);
      for (const m of data?.messages ?? []) {
        out.push({
          messageId: String(m.message_id),
          threadId: String(m.thread_id ?? ""),
          subject: String(m.subject ?? ""),
          from: String(m.head_from?.mail_address ?? "").toLowerCase(),
          fromName: String(m.head_from?.name ?? ""),
          to: (m.to ?? []).map((t: any) => String(t.mail_address ?? "").toLowerCase()),
          at: m.internal_date ? new Date(Number(m.internal_date)).toISOString() : new Date().toISOString(),
          body: String(m.body_plain_text ?? ""),
          folder: String(m.folder_id ?? ""),
        });
      }
    }
    return out;
  }

  async send(o: { mailbox: string; to: string; subject: string; body: string; replyTo?: string }): Promise<{ messageId: string; threadId: string }> {
    const args = o.replyTo
      ? ["mail", "+reply", "--message-id", o.replyTo]
      : ["mail", "+send", "--to", o.to, "--subject", o.subject];
    args.push("--mailbox", o.mailbox, "--body", toHtml(o.body), "--confirm-send", "--as", "user");
    if (o.replyTo && o.subject) args.push("--subject", o.subject);
    const data = await this.lark.json(args);
    if (data?.automation_send_disable_reason) {
      throw new MailBlocked(`邮箱设置拦截了自动发信：${data.automation_send_disable_reason} ${data.automation_send_disable_reference ?? ""}`.trim());
    }
    if (!data?.message_id) throw new Error(`发信没有返回 message_id：${JSON.stringify(data).slice(0, 300)}`);
    return { messageId: String(data.message_id), threadId: String(data.thread_id ?? "") };
  }
}

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

/** "Re: " plus the subject with any reply prefixes taken off; Feishu keeps such a reply in the thread. */
export function replySubject(subject: string): string {
  const prefix = /^\s*(re|aw|sv|回复|回覆|答复)\s*[:：]\s*/i;
  let s = subject;
  while (prefix.test(s)) s = s.replace(prefix, "");
  return `Re: ${s.trim()}`;
}

/** Feishu's mail filters only take this form: YYYY-MM-DDTHH:mm:ss+08:00. */
export function feishuTime(ms: number, tz = "+08:00"): string {
  const sign = tz.startsWith("-") ? -1 : 1;
  const [h, m] = tz.slice(1).split(":").map(Number);
  const local = new Date(ms + sign * (h * 60 + m) * 60_000).toISOString().slice(0, 19);
  return `${local}${tz}`;
}

const QUOTE_MARKERS = [
  /(<[^>\s]+>\s*)?於\s*\d{4}\s*年.{0,40}?(寫道|写道)\s*[:：]/,
  /(<[^>\s]+>\s*)?在\s*\d{4}\s*年.{0,40}?(写道|寫道)\s*[:：]/,
  /On .{5,120}? wrote:/,
  /(^|\s)(发件人|寄件者|From)\s*[:：]/,
  /-{2,}\s*(原始邮件|原始郵件|Original Message)/i,
  /\n\s*>/,
];

/** Header lines the old importer put at the top of a body ("主旨：… / 寄件人：…"). */
const IMPORT_HEADER = /^(?:(?:主旨|寄件人|收件人|日期|Subject|From|To|Date)\s*[:：][^\n]*\n)+\s*/;

/** Where the quoted history starts: the first quote marker, pulled back to its line when it opens one. */
function quoteStart(body: string): number {
  let cut = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(body);
    if (!m || m.index >= cut) continue;
    const line = body.lastIndexOf("\n", m.index);
    const lead = line >= 0 ? body.slice(line, m.index) : "";
    cut = line >= 0 && lead.length <= 40 && !/[。！？!?，,]/.test(lead) ? line : m.index;
  }
  return cut;
}

/** Quoted history laid out to read: one line per quoted line and header, without the ">" marks. */
function layQuote(q: string): string {
  return q
    .replace(/\u00a0/g, " ")
    // Imported mail lost its line breaks, leaving "a > b > > c"; each ">" run was a line start.
    .replace(/[ \t]*(?:^|\s)(?:>[ \t]?)+/gm, "\n")
    .replace(/\s*((?:<[^>\s]+>\s*)?(?:於|在)\s*\d{4}\s*年.{0,40}?(?:寫道|写道)\s*[:：]|On .{5,120}? wrote:)/g, "\n\n$1\n")
    .replace(/\s*((?:发件人|寄件者|From)\s*[:：])/g, "\n\n$1")
    .replace(/\s*((?:时间|時間|主题|主旨|收件人|Sent|Subject|To|Date)\s*[:：])/g, "\n$1")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A mail split into the sender's own words and the quoted history under them. */
export function splitMail(body: string): { own: string; quoted: string } {
  const b = body.replace(IMPORT_HEADER, "");
  const cut = quoteStart(b);
  return { own: b.slice(0, cut).trim(), quoted: layQuote(b.slice(cut)) };
}

/** The sender's own words: the mail cut at its first quoted-history marker. */
export function ownWords(body: string, max = 4000): string {
  return splitMail(body).own.slice(0, max);
}

/** Mail the mail system sends back when delivery failed. */
export function isBounce(from: string, subject: string): boolean {
  return /mailer-daemon|postmaster|mail delivery (sub)?system/i.test(from)
    || /undeliver|delivery status notification|returned mail|delivery failure|退信|未能送达|無法傳遞|无法投递/i.test(subject);
}

/** Senders whose mail never needs an answer: reports, notifications, our own mailboxes. */
export function isAutomated(from: string): boolean {
  return /^[^@]*(no-?reply|do-?not-?reply|notifications?|dmarc|postmaster|mailer-daemon)[^@]*@/i.test(from) || /@(tafu\.me)$/i.test(from);
}

/** Replies a mail system writes on its own: out-of-office, auto-acknowledgements. */
export function isAutoReply(subject: string): boolean {
  return /^\s*(自动回复|自動回覆|自动答复|Auto(matic)?[ -]?reply|Out of (the )?office|休假)/i.test(subject);
}

/** A subject without its reply and forward prefixes, to tell whether a mail answers one we sent. */
export const BASE_SUBJECT_SQL = (col: string) => `lower(regexp_replace(${col}, '^\\s*((re|fw|fwd|回复|回覆|答复|轉寄|转发)\\s*[:：﹕]\\s*)+', '', 'i'))`;

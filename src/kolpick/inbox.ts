/**
 * Incoming mail. Each mailbox is caught up from where it last left off (minus a small overlap), then watched live
 * with `lark-cli mail +watch`. A mail is recorded once by its message id; reading it again changes nothing.
 * Human mail from a known KOL gets a reply drafted by the agent; unknown senders and bounces go to the agent to judge.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { addLog, type Ctx, type Project } from "./ctx.js";
import { one } from "./db/db.js";
import { BASE_SUBJECT_SQL, feishuTime, isAutoReply, isAutomated, isBounce, ownWords, type FullMail } from "./mail.js";
import { supersedeOpenMail } from "./proposals.js";

const OVERLAP_MS = 15 * 60_000;
/** First catch-up of a mailbox with no cursor looks back this far. */
const FIRST_LOOK_MS = 3 * 86_400_000;

export interface CatchUp {
  mailbox: string;
  seen: number;
  recorded: number;
  replies: number;
  unmatched: number;
  bounces: number;
  sent: number;
}

/** Reads every mailbox of the project (enabled or not: mail still arrives) since its cursor. */
export async function catchUp(ctx: Ctx, p: Project, opts: { since?: string } = {}): Promise<CatchUp[]> {
  const boxes = await ctx.db.query<{ address: string }>("select address from mailboxes where project_id = $1 order by id", [p.id]);
  const out: CatchUp[] = [];
  for (const b of boxes) out.push(await catchUpMailbox(ctx, p, b.address, opts.since));
  return out;
}

export async function catchUpMailbox(ctx: Ctx, p: Project, mailbox: string, since?: string): Promise<CatchUp> {
  const key = `inbox:${mailbox}`;
  const cursor = await one<{ value: any }>(ctx.db, "select value from state where project_id = $1 and key = $2", [p.id, key]);
  const startedAt = ctx.now();
  const from = since ? Date.parse(since) : cursor ? Date.parse(cursor.value.at) - OVERLAP_MS : startedAt - FIRST_LOOK_MS;
  const r: CatchUp = { mailbox, seen: 0, recorded: 0, replies: 0, unmatched: 0, bounces: 0, sent: 0 };
  const start = feishuTime(from, p.settings.timezone);
  let incomplete = false;
  for (const folder of ["INBOX", "SENT"] as const) {
    const list = await ctx.mail.since(mailbox, folder, start);
    r.seen += list.length;
    const known = new Set((await ctx.db.query<{ message_id: string }>(
      "select message_id from messages where project_id = $1 and message_id = any($2::text[])", [p.id, list.map((m) => m.message_id)])).map((m) => m.message_id));
    const fresh = list.filter((m) => !known.has(m.message_id)).reverse();
    if (!fresh.length) continue;
    const full = await ctx.mail.read(mailbox, fresh.map((x) => x.message_id));
    // A mail listed but not read back is read next time: the cursor stays where it was.
    if (full.length < fresh.length) incomplete = true;
    for (const m of full) {
      const res = folder === "INBOX" ? await recordIncoming(ctx, p, mailbox, m) : await recordManualSend(ctx, p, mailbox, m);
      if (res === "skip") continue;
      r.recorded++;
      if (res === "sent") r.sent++;
      else if (res === "reply") r.replies++;
      else if (res === "unmatched") r.unmatched++;
      else if (res === "bounce") r.bounces++;
    }
  }
  if (!incomplete) await ctx.db.query(
    `insert into state (project_id, key, value, updated_at) values ($1, $2, $3, now())
     on conflict (project_id, key) do update set value = excluded.value, updated_at = now()`,
    [p.id, key, JSON.stringify({ at: new Date(startedAt).toISOString() })]);
  if (r.recorded) await addLog(ctx, p, { kind: "inbox", who: "tool", summary: `${mailbox} 补收：新记 ${r.recorded} 封（回信 ${r.replies}，对不上人 ${r.unmatched}，退信 ${r.bounces}，手动发出 ${r.sent}）` });
  return r;
}

export type Recorded = "skip" | "reply" | "note" | "unmatched" | "bounce" | "sent";

/** Finds the KOL a sender belongs to: their address, preferring the one last written to from this mailbox. */
async function kolFor(ctx: Ctx, p: Project, address: string, mailbox: string): Promise<any | undefined> {
  const rows = await ctx.db.query<any>(
    `select k.* from kols k where k.project_id = $1 and (lower(k.email) = $2 or $2 = any(regexp_split_to_array(lower(coalesce(k.other_emails, '')), '[\s,，、;；]+')))
     order by (k.mailbox = $3) desc, k.last_contact_at desc nulls last, k.id limit 1`, [p.id, address, mailbox]);
  return rows[0];
}

/** Records one incoming mail. Already recorded → "skip", nothing else changes. */
export async function recordIncoming(ctx: Ctx, p: Project, mailbox: string, m: FullMail): Promise<Recorded> {
  const bounce = isBounce(m.from, m.subject);
  if (!bounce && (isAutomated(m.from) || isAutoReply(m.subject))) return "skip";
  const kol = bounce ? await bouncedKol(ctx, p, m) : await kolFor(ctx, p, m.from, mailbox);
  const words = ownWords(m.body);
  // Recording the mail and everything it sets off happen together: a crash in between would leave a mail that
  // later reads skip as known, with no reply drafted and an outdated approval still standing.
  return ctx.db.tx(async (q) => {
    const c: Ctx = { ...ctx, db: q };
    const ins = await q.query<{ id: number }>(
      `insert into messages (project_id, kol_id, direction, mailbox, message_id, thread_id, subject, from_addr, to_addr, body, summary, at, pending, bounce)
       values ($1, $2, 'in', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict do nothing returning id`,
      [p.id, kol?.id ?? null, mailbox, m.messageId, m.threadId || null, m.subject, m.from, bounce ? kol?.bouncedTo ?? null : mailbox, m.body,
        words.slice(0, 300), m.at, true, bounce]);
    if (!ins.length) return "skip";
    const id = ins[0].id;
    if (bounce) {
      await queue(c, p, "bounce", { kolId: kol?.id ?? null, messageId: id });
      await addLog(c, p, { kind: "inbox", who: "tool", kolId: kol?.id ?? null, summary: `退信：${m.subject}${kol ? `（${kol.name} ${kol.bouncedTo}）` : ""}` });
      return "bounce";
    }
    if (!kol) {
      // Only an answer to mail we sent can be a KOL writing from another address; the rest (platforms, other business) is just kept.
      const ours = await one(q, `select 1 from messages where project_id = $1 and direction = 'out'
        and ((thread_id is not null and thread_id = $2) or ${BASE_SUBJECT_SQL("subject")} = ${BASE_SUBJECT_SQL("$3")}) limit 1`, [p.id, m.threadId || null, m.subject]);
      if (!ours) {
        await q.query("update messages set pending = false where id = $1", [id]);
        await addLog(c, p, { kind: "inbox", who: "tool", summary: `不是回我们的信，只记下：${m.from}「${m.subject}」` });
        return "unmatched";
      }
      await queue(c, p, "unmatched", { messageId: id });
      await addLog(c, p, { kind: "inbox", who: "tool", summary: `对不上人的来信：${m.from}「${m.subject}」` });
      return "unmatched";
    }
    await q.query(
      `update kols set last_inbound_at = greatest(last_inbound_at, $2::timestamptz), whose_turn = 'us', next_followup_at = null,
         stage = case when stage in ('new', 'invited', 'on_hold') then 'replied' when stage = 'closed' and close_reason = '无回应' then 'replied' else stage end,
         updated_at = now() where id = $1`, [kol.id, m.at]);
    const old = await supersedeOpenMail(c, p, kol.id);
    await queue(c, p, "reply", { kolId: kol.id, messageId: id, replaces: old });
    await addLog(c, p, { kind: "inbox", who: "tool", kolId: kol.id, summary: `${kol.name} 来信：${m.subject}` });
    return "reply";
  });
}

/** A bounce names the address it couldn't deliver to; find the KOL we last wrote to at that address. */
async function bouncedKol(ctx: Ctx, p: Project, m: FullMail): Promise<any | undefined> {
  const addrs = [...new Set((m.body.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []).map((a) => a.toLowerCase()))].filter((a) => !isAutomated(a));
  for (const a of addrs) {
    const k = await one<any>(ctx.db,
      "select k.*, $2::text as \"bouncedTo\" from messages ms join kols k on k.id = ms.kol_id where ms.project_id = $1 and ms.direction = 'out' and lower(ms.to_addr) = $2 order by ms.at desc limit 1",
      [p.id, a]);
    if (k) return k;
  }
  return undefined;
}

/** A mail sent by hand from the Feishu mailbox to a KOL: recorded so the history is complete. */
async function recordManualSend(ctx: Ctx, p: Project, mailbox: string, m: FullMail): Promise<Recorded> {
  for (const to of m.to) {
    const kol = await kolFor(ctx, p, to, mailbox);
    if (!kol) continue;
    const ins = await ctx.db.query(
      `insert into messages (project_id, kol_id, direction, mailbox, message_id, thread_id, subject, from_addr, to_addr, body, at)
       values ($1, $2, 'out', $3, $4, $5, $6, $3, $7, $8, $9) on conflict do nothing returning id`,
      [p.id, kol.id, mailbox, m.messageId, m.threadId || null, m.subject, to, m.body, m.at]);
    if (!ins.length) return "skip";
    await ctx.db.query("update kols set last_contact_at = greatest(last_contact_at, $2::timestamptz), whose_turn = 'kol', updated_at = now() where id = $1", [kol.id, m.at]);
    await addLog(ctx, p, { kind: "sent", who: "operator", kolId: kol.id, summary: `在飞书邮箱手动发给 ${kol.name}：${m.subject}` });
    return "sent";
  }
  return "skip";
}

async function queue(ctx: Ctx, p: Project, kind: string, o: { kolId?: number | null; messageId: number; replaces?: number | null }): Promise<void> {
  await ctx.db.query("insert into agent_jobs (project_id, kind, kol_id, message_id, input) values ($1, $2, $3, $4, $5)",
    [p.id, kind, o.kolId ?? null, o.messageId, JSON.stringify(o.replaces ? { replaces: o.replaces } : {})]);
}

/**
 * Live watch of one mailbox. Each event names a message; it is read and recorded like a catch-up. If the stream
 * dies, it restarts after a pause; `onDown` lets the caller fall back to frequent catch-ups meanwhile.
 */
export class Watcher {
  private child?: ChildProcess;
  private stopped = false;
  up = false;
  lastError = "";

  constructor(private ctx: Ctx, private p: Project, readonly mailbox: string, private onMail: (messageId: string) => Promise<void>,
    private bin = process.env.KOLPICK_LARK_CLI || "lark-cli") {}

  start(): void {
    if (this.stopped) return;
    const child = spawn(this.bin, ["mail", "+watch", "--mailbox", this.mailbox, "--format", "data", "--msg-format", "minimal", "--as", "user"], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.on("error", (e) => (this.lastError = `启动 lark-cli 失败：${e.message}`));
    let errText = "";
    child.stderr!.on("data", (d) => (errText = (errText + d).slice(-2000)));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      this.up = true;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev?.ok === false) {
        this.lastError = JSON.stringify(ev.error ?? ev).slice(0, 400);
        return;
      }
      const id = ev?.message_id ?? ev?.data?.message_id ?? ev?.message?.message_id;
      if (id) this.onMail(String(id)).catch((e) => (this.lastError = String(e?.message ?? e)));
    });
    child.on("exit", (code) => {
      this.up = false;
      if (this.stopped) return;
      this.lastError = `监听退出（${code}）：${errText.trim().slice(-400)}`;
      setTimeout(() => this.start(), 60_000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }
}

/** Reads one message the watcher announced and records it. */
export async function recordOne(ctx: Ctx, p: Project, mailbox: string, messageId: string): Promise<Recorded> {
  const exists = await one(ctx.db, "select 1 from messages where project_id = $1 and message_id = $2", [p.id, messageId]);
  if (exists) return "skip";
  const [m] = await ctx.mail.read(mailbox, [messageId]);
  if (!m) return "skip";
  if (m.folder === "SENT") return recordManualSend(ctx, p, mailbox, m);
  if (m.folder && m.folder !== "INBOX") return "skip";
  return recordIncoming(ctx, p, mailbox, m);
}

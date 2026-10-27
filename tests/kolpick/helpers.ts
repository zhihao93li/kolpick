import { PGlite } from "@electric-sql/pglite";
import { loadConfig, type LocalConfig } from "../../src/kolpick/config.js";
import { makeCtx, project, type Ctx, type Project } from "../../src/kolpick/ctx.js";
import { migrate, one, type Db } from "../../src/kolpick/db/db.js";
import { LarkError } from "../../src/kolpick/lark.js";
import type { FullMail, Mail, MailSummary } from "../../src/kolpick/mail.js";
import { DEFAULTS } from "../../src/kolpick/settings.js";
import { Refused, type CodeInfo, type TafuApi } from "../../src/kolpick/tafu.js";

export function pglite(): Db {
  const pg = new PGlite();
  const wrap = (q: any, top: boolean): Db => ({
    query: async (text, params = []) => (await q.query(text, params)).rows,
    tx: (fn) => (top ? pg.transaction((t) => fn(wrap(t, false))) : fn(wrap(q, false))),
    exec: async (text) => void (await q.exec(text)),
    end: () => pg.close(),
  });
  return wrap(pg, true);
}

/** Mail that never leaves the test: sends are recorded, the inbox is whatever the test puts in it. */
export class FakeMail {
  sent: { mailbox: string; to: string; subject: string; body: string; replyTo?: string }[] = [];
  inbox = new Map<string, FullMail[]>();
  /** Set to make the next send fail: "definite" (Feishu said no) or "timeout" (nobody knows). */
  failNext: "" | "definite" | "timeout" = "";

  async since(mailbox: string, folder: "INBOX" | "SENT", start: string): Promise<MailSummary[]> {
    return (this.inbox.get(mailbox) ?? []).filter((m) => (m.folder || "INBOX") === folder && m.at >= new Date(start).toISOString())
      .map((m) => ({ message_id: m.messageId, thread_id: m.threadId, subject: m.subject, from: m.from, date: m.at }));
  }
  async latestFrom(mailbox: string, address: string): Promise<MailSummary | undefined> {
    const m = (this.inbox.get(mailbox) ?? []).filter((x) => x.from === address).at(-1);
    return m && { message_id: m.messageId, thread_id: m.threadId, subject: m.subject, from: m.from, date: m.at };
  }
  async read(mailbox: string, ids: string[]): Promise<FullMail[]> {
    return (this.inbox.get(mailbox) ?? []).filter((m) => ids.includes(m.messageId));
  }
  async send(o: { mailbox: string; to: string; subject: string; body: string; replyTo?: string }) {
    const fail = this.failNext;
    this.failNext = "";
    if (fail === "definite") throw new LarkError("飞书拒绝了", true);
    if (fail === "timeout") throw new LarkError("超时了", false);
    this.sent.push(o);
    return { messageId: `sent-${this.sent.length}`, threadId: `t-${this.sent.length}` };
  }
  deliver(mailbox: string, m: Partial<FullMail> & { from: string; body: string }): FullMail {
    const list = this.inbox.get(mailbox) ?? [];
    const full: FullMail = { messageId: `in-${Math.random().toString(36).slice(2)}`, threadId: "", subject: "Re: 邀請", fromName: "", to: [mailbox],
      at: new Date().toISOString(), folder: "INBOX", ...m };
    list.push(full);
    this.inbox.set(mailbox, list);
    return full;
  }
}

/** The project API, in memory. */
export class FakeTafu {
  codes = new Map<string, CodeInfo>();
  calls: string[] = [];
  failNext: "" | "refuse" | "timeout" = "";

  private fail(): void {
    const f = this.failNext;
    this.failNext = "";
    if (f === "refuse") throw new Refused("CODE_TAKEN", "码名被占用了");
    if (f === "timeout") throw new Error("fetch failed");
  }
  async lookup(codes: string[]) {
    const out = new Map<string, CodeInfo>();
    for (const c of codes) for (const kind of ["trial", "partner"]) {
      const i = this.codes.get(`${kind}:${c.toLowerCase()}`);
      if (i) out.set(`${kind}:${c.toLowerCase()}`, i);
    }
    return out;
  }
  async createTrial(b: { code: string; maxUses: number; days: number }) {
    this.calls.push(`create ${b.code}`);
    this.fail();
    const key = `trial:${b.code.toLowerCase()}`;
    const existing = this.codes.get(key);
    if (existing) return { created: false, code: existing };
    const code: CodeInfo = { code: b.code, found: true, kind: "trial", active: true, maxUses: b.maxUses, used: 0, expiresAt: new Date(Date.now() + b.days * 86_400_000).toISOString() };
    this.codes.set(key, code);
    return { created: true, code };
  }
  async extendTrial(code: string, b: { days: number }) {
    this.calls.push(`extend ${code}`);
    this.fail();
    const c = this.codes.get(`trial:${code.toLowerCase()}`);
    if (!c) throw new Refused("NOT_A_TRIAL_CODE", "没有这个码");
    c.expiresAt = new Date(Math.max(Date.now(), Date.parse(c.expiresAt!)) + b.days * 86_400_000).toISOString();
    return { code: c };
  }
  async createPartner(b: { code: string; percentOff: number }) {
    this.calls.push(`partner ${b.code}`);
    this.fail();
    const code: CodeInfo = { code: b.code, found: true, kind: "partner", active: true, refLink: `https://tafu.me/p/${b.code}`, ledgerLink: `https://tafu.me/l/${b.code}`, percentOff: b.percentOff };
    this.codes.set(`partner:${b.code.toLowerCase()}`, code);
    return { created: true, code };
  }
}

export interface World {
  db: Db;
  ctx: Ctx;
  p: Project;
  mail: FakeMail;
  tafu: FakeTafu;
}

/** A migrated database with project "t", two mailboxes (hello enabled), and the fakes wired in. */
export async function world(o: { paused?: boolean; settings?: Record<string, unknown> } = {}): Promise<World> {
  const db = pglite();
  await migrate(db);
  await db.query("insert into projects (name, settings, paused) values ('t', $1, $2)", [JSON.stringify({ ...DEFAULTS, dataApiUrl: "https://x", ...(o.settings ?? {}) }), o.paused ?? false]);
  await db.query("insert into mailboxes (project_id, address, enabled, daily_limit) values (1, 'hello@tafu.me', true, 50), (1, 'mei@tafu.me', false, 50)");
  const mail = new FakeMail();
  const tafu = new FakeTafu();
  const cfg: LocalConfig = { ...loadConfig(), project: "t", env: "test" };
  const ctx = makeCtx(db, { cfg, mail: mail as unknown as Mail, tafu: () => tafu as unknown as TafuApi, sleep: async () => {}, lark: { json: async () => ({}) } });
  return { db, ctx, p: await project(ctx, "t"), mail, tafu };
}

export async function addKol(w: World, o: Record<string, unknown> = {}): Promise<number> {
  const row = { name: "小鹿", email: `deer${Math.random().toString(36).slice(2, 7)}@gmail.com`, handle: "deer_jay", stage: "invited", mailbox: "hello@tafu.me", ...o };
  const keys = Object.keys(row);
  const r = await one<{ id: number }>(w.db, `insert into kols (project_id, ${keys.join(", ")}) values (1, ${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row));
  return r!.id;
}

export async function card(w: World, id: number): Promise<any> {
  return one(w.db, "select * from proposals where id = $1", [id]);
}

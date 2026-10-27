/**
 * Carries out approved mail cards, one external action at a time: build the code if the card asks for one, fill
 * it into the mail, send, record. Every external action is written to `actions` before it starts; one that ends
 * without a clear answer is 'unknown' and is never redone on its own (docs/design.md §4).
 */
import { addLog, type Ctx, type Project } from "./ctx.js";
import { one } from "./db/db.js";
import { LarkError } from "./lark.js";
import { MailBlocked } from "./mail.js";
import { applyAfter, contentHash, type CodeAction, type ProposalAction } from "./proposals.js";
import { sendBlock } from "./rules.js";
import { discountWords, Refused } from "./tafu.js";

/** The external action may have happened; nobody knows. */
export class Unknown extends Error {}

let chain: Promise<unknown> = Promise.resolve();
/** External actions run one at a time across the whole process. */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/**
 * Runs one external action for a proposal at most once. A succeeded one hands back its earlier response; a
 * started or unknown one refuses.
 */
export async function once<T>(ctx: Ctx, p: Project, proposalId: number, kind: string, request: object, fn: () => Promise<T>): Promise<T> {
  const prior = await one<any>(ctx.db, "select * from actions where proposal_id = $1 and kind = $2 and status <> 'failed'", [proposalId, kind]);
  if (prior?.status === "succeeded") return prior.response as T;
  if (prior) throw new Unknown(`上次${KIND_NAMES[kind]}结果不明，不会自动重做`);
  const row = await one<{ id: number }>(ctx.db,
    "insert into actions (project_id, proposal_id, kind, status, mailbox, to_addr, request) values ($1, $2, $3, 'started', $4, $5, $6) returning id",
    [p.id, proposalId, kind, (request as any).mailbox ?? null, (request as any).to ?? null, JSON.stringify(request)]);
  try {
    const res = await fn();
    await ctx.db.query("update actions set status='succeeded', response=$2, finished_at=now() where id=$1", [row!.id, JSON.stringify(res ?? {})]);
    return res;
  } catch (err: any) {
    const definite = err instanceof Refused || err instanceof MailBlocked || (err instanceof LarkError && err.definite);
    await ctx.db.query("update actions set status=$2, error=$3, finished_at=now() where id=$1", [row!.id, definite ? "failed" : "unknown", String(err?.message ?? err)]);
    if (definite) throw err;
    throw new Unknown(`${KIND_NAMES[kind]}结果不明（${err?.message ?? err}），不会自动重做`);
  }
}

const KIND_NAMES: Record<string, string> = { send: "发信", trial_create: "建体验码", trial_extend: "体验码延期", partner_create: "开活动码" };

/** After a crash: actions left 'started' and cards left 'running' are unknown until the operator says. */
export async function recoverAfterCrash(ctx: Ctx): Promise<number> {
  const a = await ctx.db.query("update actions set status='unknown', error='程序中断，结果不明', finished_at=now() where status='started' returning proposal_id");
  await ctx.db.query("update proposals set status='unknown', result='程序中断，结果不明，请确认' where status='running'");
  return a.length;
}

/** Reasons that clear up by themselves (pause lifted, tomorrow's quota): the card stays approved and waits. */
const WAITS = /暂停|额度|上限|停用了/;

export interface RunReport {
  done: number;
  waiting: number;
  failed: number;
  unknown: number;
}

/** Works through every approved mail card of a project, oldest approval first. */
export function runApproved(ctx: Ctx, p: Project, opts: { limit?: number } = {}): Promise<RunReport> {
  return serial(async () => {
    const report: RunReport = { done: 0, waiting: 0, failed: 0, unknown: 0 };
    const cards = await ctx.db.query<any>(
      "select * from proposals where project_id = $1 and status = 'approved' and to_addr is not null order by approved_at, id limit $2", [p.id, opts.limit ?? 500]);
    const gap = Math.ceil(60_000 / Math.max(1, p.settings.perMinute));
    let sentAny = false;
    for (const card of cards) {
      if (sentAny) await ctx.sleep(gap);
      const outcome = await executeOne(ctx, p, card);
      report[outcome]++;
      if (outcome === "done") sentAny = true;
      // Pausing stops the run midway: what is left waits.
      if (outcome === "waiting" && /暂停所有发送/.test((await one<any>(ctx.db, "select result from proposals where id=$1", [card.id]))?.result ?? "")) {
        report.waiting += cards.length - cards.indexOf(card) - 1;
        break;
      }
    }
    return report;
  });
}

async function setStatus(ctx: Ctx, id: number, status: string, result: string): Promise<void> {
  await ctx.db.query(`update proposals set status=$2, result=$3, updated_at=now()${status === "done" ? ", done_at=now()" : ""} where id=$1`, [id, status, result]);
}

export async function executeOne(ctx: Ctx, p: Project, card: any): Promise<keyof RunReport> {
  if (card.approved_hash !== contentHash(card) || card.approved_hash !== card.content_hash) {
    await ctx.db.query("update proposals set status='pending', approved_hash=null, approved_at=null, result='批准后内容变了，要重新批准' where id=$1", [card.id]);
    return "waiting";
  }
  const action: ProposalAction = card.action ?? {};
  const kol = await one<any>(ctx.db, "select * from kols where id = $1", [card.kol_id]);
  const blocked = await sendBlock(ctx, p, { kolId: card.kol_id, to: card.to_addr, mailbox: card.mailbox, invite: action.step === "invite" });
  if (blocked) {
    if (WAITS.test(blocked)) {
      await ctx.db.query("update proposals set result=$2 where id=$1", [card.id, `等着发：${blocked}`]);
      return "waiting";
    }
    await setStatus(ctx, card.id, "failed", blocked);
    await addLog(ctx, p, { kind: "send_failed", who: "tool", kolId: card.kol_id, proposalId: card.id, summary: `没发给 ${kol?.name}：${blocked}` });
    return "failed";
  }
  await setStatus(ctx, card.id, "running", "正在做");
  try {
    let subject: string = card.subject;
    let body: string = card.body;
    if (action.code) {
      const values = await doCode(ctx, p, card, kol, action.code);
      for (const [k, v] of Object.entries(values)) {
        subject = subject.split(k).join(v);
        body = body.split(k).join(v);
      }
    }
    let replyTo: string | undefined;
    if (card.in_reply_to) {
      const m = await one<any>(ctx.db, "select message_id, mailbox from messages where id = $1", [card.in_reply_to]);
      if (m?.message_id && m.mailbox === card.mailbox) replyTo = m.message_id;
    } else if (card.kind !== "invite") {
      // Follow-ups and new mails stay in the thread with the KOL when there is one.
      const latest = await ctx.mail.latestFrom(card.mailbox, card.to_addr).catch(() => undefined);
      if (latest) replyTo = latest.message_id;
    }
    const request = { mailbox: card.mailbox, to: card.to_addr, subject, body, replyTo };
    const sent = await once(ctx, p, card.id, "send", request, () => ctx.mail.send(request));
    await recordSent(ctx, p, card, subject, body, sent);
    await setStatus(ctx, card.id, "done", `已发出 ${new Date(ctx.now()).toISOString()}`);
    return "done";
  } catch (err: any) {
    if (err instanceof Unknown) {
      await setStatus(ctx, card.id, "unknown", `${err.message}。请到邮箱「已发送」或项目后台看一眼，再点「确认已经做了」或「确认没做成」`);
      await addLog(ctx, p, { kind: "unknown", who: "tool", kolId: card.kol_id, proposalId: card.id, summary: `${kol?.name}：${err.message}` });
      return "unknown";
    }
    await setStatus(ctx, card.id, "failed", String(err?.message ?? err));
    await addLog(ctx, p, { kind: "send_failed", who: "tool", kolId: card.kol_id, proposalId: card.id, summary: `${kol?.name}：${err?.message ?? err}` });
    return "failed";
  }
}

/** Builds or extends the code, stores it on the KOL, and returns the placeholder values for the mail. */
async function doCode(ctx: Ctx, p: Project, card: any, kol: any, code: CodeAction): Promise<Record<string, string>> {
  const api = ctx.tafu(p);
  const operator = "kolpick";
  const kolRef = `kol-${kol.id}`;
  if (code.type === "trial_create") {
    const r = await once(ctx, p, card.id, "trial_create", code, () =>
      api.createTrial({ code: code.code, maxUses: code.maxUses, days: code.days, kolName: kol.name, followupId: kolRef, operator }));
    const c = r.code;
    await ctx.db.query(
      `insert into codes (project_id, kol_id, kind, code, max_uses, used, expires_at, active, synced_at) values ($1, $2, 'trial', $3, $4, $5, $6, $7, now())
       on conflict (project_id, kind, code) do update set kol_id = excluded.kol_id, max_uses = excluded.max_uses, expires_at = excluded.expires_at, synced_at = now()`,
      [p.id, kol.id, c.code, c.maxUses ?? code.maxUses, c.used ?? 0, c.expiresAt ?? null, c.active ?? true]);
    await ctx.db.query("update kols set stage = case when stage in ('new','invited','replied') then 'trial' else stage end, updated_at = now() where id = $1", [kol.id]);
    return trialValues(c.code, c.maxUses ?? code.maxUses, c.expiresAt ?? null, p.settings.timezone);
  }
  if (code.type === "trial_extend") {
    const r = await once(ctx, p, card.id, "trial_extend", code, () => api.extendTrial(code.code, { days: code.days, operator }));
    const c = r.code;
    await ctx.db.query("update codes set expires_at = $3, active = coalesce($4, active), synced_at = now() where project_id = $1 and kind = 'trial' and lower(code) = lower($2)",
      [p.id, code.code, c.expiresAt ?? null, c.active ?? null]);
    return trialValues(c.code, c.maxUses ?? 0, c.expiresAt ?? null, p.settings.timezone);
  }
  const r = await once(ctx, p, card.id, "partner_create", code, () =>
    api.createPartner({ code: code.code, partnerName: code.partnerName, contact: code.contact, market: code.market, percentOff: code.percentOff, followupId: kolRef, operator }));
  const c = r.code;
  if (!c?.refLink) throw new Refused("NO_LINK", "活动码开好了，但接口没给专属连结；信先不发，请到项目后台看");
  await ctx.db.query(
    `insert into codes (project_id, kol_id, kind, code, ref_link, ledger_link, partner_id, active, synced_at) values ($1, $2, 'partner', $3, $4, $5, $6, true, now())
     on conflict (project_id, kind, code) do update set kol_id = excluded.kol_id, ref_link = excluded.ref_link, ledger_link = excluded.ledger_link, partner_id = excluded.partner_id`,
    [p.id, kol.id, c.code, c.refLink, c.ledgerLink ?? null, c.partnerId ?? c.id ?? null]);
  await ctx.db.query("update kols set stage = 'partner', updated_at = now() where id = $1", [kol.id]);
  const off = c.percentOff ?? code.percentOff;
  return {
    "{活動碼}": c.code, "{活动码}": c.code, "{專屬連結}": c.refLink, "{专属连结}": c.refLink, "{帳本連結}": c.ledgerLink ?? "", "{账本连结}": c.ledgerLink ?? "",
    "{粉絲折扣}": discountWords(off), "{粉丝折扣}": discountWords(off),
  };
}

/** 「2026 年 11 月 8 日 10:23」 in the project's zone: the code stops working at that minute. */
export function expiryWords(iso: string, tz: string): string {
  const sign = tz.startsWith("-") ? -1 : 1;
  const [h, m] = tz.slice(1).split(":").map(Number);
  const d = new Date(Date.parse(iso) + sign * (h * 60 + m) * 60_000).toISOString();
  return `${d.slice(0, 4)} 年 ${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日 ${d.slice(11, 16)}`;
}

function trialValues(code: string, uses: number, expiresAt: string | null, tz: string): Record<string, string> {
  const until = expiresAt ? expiryWords(expiresAt, tz) : "";
  return { "{體驗碼}": code, "{体验码}": code, "{次數}": String(uses), "{次数}": String(uses), "{到期日}": until };
}

/** Writes the sent mail and what it changes on the KOL. Safe to run twice for one card. */
export async function recordSent(ctx: Ctx, p: Project, card: any, subject: string, body: string, sent: { messageId?: string; threadId?: string }): Promise<void> {
  const at = new Date(ctx.now()).toISOString();
  const action: ProposalAction = card.action ?? {};
  await ctx.db.tx(async (q) => {
    const r = await q.query(
      `insert into messages (project_id, kol_id, direction, mailbox, message_id, thread_id, subject, from_addr, to_addr, body, at, proposal_id)
       values ($1, $2, 'out', $3, $4, $5, $6, $3, $7, $8, $9, $10) on conflict do nothing returning id`,
      [p.id, card.kol_id, card.mailbox, sent.messageId || null, sent.threadId || null, subject, card.to_addr, body, at, card.id]);
    if (!r.length) return;
    const invite = action.step === "invite";
    await q.query(
      `update kols set last_contact_at = $2, mailbox = $3, whose_turn = 'kol',
         stage = case when stage = 'new' then 'invited' else stage end,
         first_invited_at = coalesce(first_invited_at, case when $4 then $2::timestamptz end),
         invite_batch = coalesce(invite_batch, $5), updated_at = now()
       where id = $1`, [card.kol_id, at, card.mailbox, invite, invite ? (action.batch ?? null) : null]);
    if (card.in_reply_to) await q.query("update messages set pending = false where id = $1", [card.in_reply_to]);
    await applyAfter(q, card.kol_id, action.after ?? (invite ? { next_followup_days: p.settings.followup1Days } : {}), ctx.now());
  });
  const kol = await one<any>(ctx.db, "select name from kols where id = $1", [card.kol_id]);
  await addLog(ctx, p, { kind: "sent", who: "tool", kolId: card.kol_id, proposalId: card.id, summary: `发给 ${kol?.name}（${card.to_addr}，${card.mailbox}）：${subject}` });
}

/**
 * The operator looked and says whether an unknown action happened. Yes: it counts as done and the card goes on
 * (the mail is recorded, or the remaining steps run). No: it counts as not done and the card waits for a fresh approval.
 */
export async function resolveUnknown(ctx: Ctx, p: Project, id: number, happened: boolean): Promise<void> {
  const card = await one<any>(ctx.db, "select * from proposals where id = $1 and project_id = $2", [id, p.id]);
  if (!card || card.status !== "unknown") throw new Error("这张卡片不是结果不明");
  const acts = await ctx.db.query<any>("select * from actions where proposal_id = $1 and status in ('unknown','started')", [id]);
  if (!happened) {
    await ctx.db.query("update actions set status='failed', error=coalesce(error,'') || '；运营确认没做成', finished_at=now() where id = any($1::int[])", [acts.map((a) => a.id)]);
    await ctx.db.query("update proposals set status='pending', approved_hash=null, approved_at=null, result='运营确认没做成，要重新批准' where id=$1", [id]);
  } else {
    for (const a of acts) {
      if (a.kind === "send") {
        await ctx.db.query("update actions set status='succeeded', response='{}', error=coalesce(error,'') || '；运营确认已发出', finished_at=now() where id=$1", [a.id]);
        await recordSent(ctx, p, card, a.request.subject, a.request.body, {});
        await setStatus(ctx, id, "done", "运营确认已发出");
      } else if (a.kind === "trial_extend") {
        // The extension went through: read the new expiry back so the mail can say it.
        const info = (await ctx.tafu(p).lookup([a.request.code])).get(`trial:${String(a.request.code).toLowerCase()}`);
        if (!info) throw new Error(`项目后台查不到码 ${a.request.code}`);
        await ctx.db.query("update actions set status='succeeded', response=$2, error=coalesce(error,'') || '；运营确认已延期', finished_at=now() where id=$1", [a.id, JSON.stringify({ code: info })]);
        await ctx.db.query("update proposals set status='approved', result='运营确认已延期，接着发信' where id=$1", [id]);
      } else {
        // Creating a code or a campaign may simply be asked again: the API hands back the one made the first time.
        await ctx.db.query("update actions set status='failed', error=coalesce(error,'') || '；运营确认已建，重新取回', finished_at=now() where id=$1", [a.id]);
        await ctx.db.query("update proposals set status='approved', result='运营确认已建码，接着发信' where id=$1", [id]);
      }
    }
  }
  await addLog(ctx, p, { kind: "resolve", kolId: card.kol_id, proposalId: id, summary: happened ? "确认结果不明的动作已做" : "确认结果不明的动作没做成" });
}

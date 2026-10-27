/**
 * Cards waiting for the operator (待你决定). The agent and the tools create them; only the console approves them.
 * An approval is for exactly the content the card showed (content_hash); edits after approval, or a new mail from
 * the KOL, take the approval back.
 */
import { createHash } from "node:crypto";
import { addLog, type Ctx, type Project } from "./ctx.js";
import { one } from "./db/db.js";
import { replySubject } from "./mail.js";
import { CODE_RULE, TRIAL_LIMITS } from "./tafu.js";

export type CodeAction =
  | { type: "trial_create"; code: string; maxUses: number; days: number }
  | { type: "trial_extend"; code: string; days: number }
  | { type: "partner_create"; code: string; market: string; percentOff: number; partnerName: string; contact: string };

/** What happens to the KOL once the proposal is carried out. */
export interface After {
  stage?: string;
  whose_turn?: "kol" | "us" | "none";
  close_reason?: string;
  never_contact?: boolean;
  never_reason?: string;
  /** Days from the send until the next follow-up. */
  next_followup_days?: number;
  next_step?: string;
  publish_due_at?: string;
}

export interface ProposalAction {
  code?: CodeAction;
  after?: After;
  /** unmatched mail: attach it to this KOL. */
  match_kol_id?: number;
  /** bounce: mark the address bad and close the KOL, or just clear the block. */
  bounce?: "close" | "clear";
  /** template card: the draft that replaces its active version. */
  template_id?: number;
  /** discovery card: people to add when approved. */
  candidates?: Candidate[];
  batch?: string;
  /** invite / follow-up: which step this is. */
  step?: "invite" | "followup1" | "followup2" | "close" | "checkin";
}

export interface Candidate {
  platform: string;
  handle: string;
  name: string;
  url: string;
  followers: number | null;
  email: string;
  other_emails: string[];
  bio: string;
  note: string;
}

export const MAIL_KINDS = new Set(["reply", "mail", "invite", "followup", "code_expiry", "checkin"]);
export const STAGES = ["new", "invited", "replied", "trial", "report_seen", "publish_agreed", "published", "partner", "on_hold", "closed"];
export const STAGE_NAMES: Record<string, string> = {
  new: "未联系", invited: "已邀约", replied: "已回复", trial: "体验中", report_seen: "已看报告", publish_agreed: "已约发布",
  published: "已发布", partner: "合作中", on_hold: "暂缓", closed: "结案",
};
export const CLOSE_REASONS = ["无回应", "题材不符", "只接固定费", "宗教信仰", "隐私", "档期", "拒绝", "回复后失联", "退信或邮箱无效", "作废", "其他"];

/** JSON with object keys sorted, so a value read back from jsonb (which reorders keys) hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => (v as any)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export function contentHash(p: { to_addr?: string | null; mailbox?: string | null; subject?: string | null; body?: string | null; action?: unknown }): string {
  return createHash("sha256").update(canonical([p.to_addr ?? null, p.mailbox ?? null, p.subject ?? null, p.body ?? null, p.action ?? {}])).digest("hex").slice(0, 16);
}

/** Placeholders a code action fills; the draft must use the ones that carry what it promises. */
export function placeholderProblem(code: CodeAction | undefined, body: string): string {
  if (!code) {
    const left = body.match(/\{(體驗碼|体验码|次數|次数|到期日|活動碼|活动码|專屬連結|专属连结|帳本連結|账本连结|粉絲折扣|粉丝折扣)\}/);
    return left ? `信里有 ${left[0]}，但这张卡没有建码或开活动码，填不进去` : "";
  }
  if (code.type === "trial_create" && !/\{(體驗碼|体验码)\}/.test(body)) return "建体验码的信里要有 {體驗碼}，码建好后填进去";
  if (code.type === "trial_extend" && !body.includes("{到期日}")) return "延期的信里要有 {到期日}，延期后填进去";
  if (code.type === "partner_create" && !/\{(專屬連結|专属连结)\}/.test(body)) return "开活动码的信里要有 {專屬連結}";
  return "";
}

export function codeProblem(code: CodeAction | undefined): string {
  if (!code) return "";
  if (!CODE_RULE.test(code.code)) return `码名「${code.code}」只能用字母、数字、_ 和 -，2 到 64 个字`;
  if (code.type === "trial_create") {
    if (code.maxUses < 1 || code.maxUses > TRIAL_LIMITS.maxUses) return `体验次数要在 1–${TRIAL_LIMITS.maxUses}`;
    if (code.days < 1 || code.days > TRIAL_LIMITS.days) return `体验天数要在 1–${TRIAL_LIMITS.days}`;
  }
  if (code.type === "trial_extend" && (code.days < 1 || code.days > TRIAL_LIMITS.days)) return `延期天数要在 1–${TRIAL_LIMITS.days}`;
  if (code.type === "partner_create") {
    if (code.percentOff < 10 || code.percentOff > 20) return "粉丝折扣要在 10–20";
    if (!code.contact.includes("@")) return "开活动码要写这位 KOL 的联系邮箱";
  }
  return "";
}

/** {稱呼} and friends, filled when the card is made so the operator sees the real text. */
export function fillName(text: string, kol: { salutation?: string | null; name: string }): string {
  const who = kol.salutation?.trim() || kol.name;
  return text.split("{稱呼}").join(who).split("{称呼}").join(who);
}

export interface MailDraft {
  kind: string;
  kolId: number;
  title?: string;
  why?: string;
  mailbox?: string;
  to?: string;
  subject?: string;
  body: string;
  inReplyTo?: number;
  action?: ProposalAction;
  parentId?: number;
  who?: string;
  /** Fill an existing 'drafting' card (the agent finishing a job) instead of making a new one. */
  proposalId?: number;
}

/** Makes (or fills) a mail card. Throws a message for the agent when the card can't be made. */
export async function proposeMail(ctx: Ctx, p: Project, d: MailDraft): Promise<{ id: number }> {
  if (!MAIL_KINDS.has(d.kind)) throw new Error(`信的种类只能是 ${[...MAIL_KINDS].join("、")}`);
  const kol = await one<any>(ctx.db, "select * from kols where id = $1 and project_id = $2", [d.kolId, p.id]);
  if (!kol) throw new Error(`没有编号 ${d.kolId} 的 KOL`);
  if (kol.never_contact) throw new Error(`${kol.name} 是永不联系，不能给 TA 写信`);
  let subject = d.subject ?? "";
  let to = d.to?.trim().toLowerCase() || "";
  let mailbox = d.mailbox ?? "";
  if (d.inReplyTo) {
    const m = await one<any>(ctx.db, "select * from messages where id = $1 and project_id = $2", [d.inReplyTo, p.id]);
    if (!m) throw new Error(`没有编号 ${d.inReplyTo} 的来信`);
    to ||= m.from_addr ?? "";
    mailbox ||= m.mailbox ?? "";
    subject ||= m.subject ? replySubject(m.subject) : "";
  }
  to ||= kol.email ?? "";
  if (!to) throw new Error(`${kol.name} 没有邮箱`);
  const boxes = await ctx.db.query<{ address: string; enabled: boolean }>("select address, enabled from mailboxes where project_id = $1 order by enabled desc, id", [p.id]);
  if (!mailbox) mailbox = boxes.find((b) => b.address === kol.mailbox)?.address ?? boxes[0]?.address ?? "";
  if (!boxes.some((b) => b.address === mailbox)) throw new Error(`${mailbox || "（没写）"} 不是这个项目的发信邮箱：${boxes.map((b) => b.address).join("、")}`);
  if (!subject && !d.inReplyTo) {
    const last = await one<any>(ctx.db, "select subject from messages where kol_id = $1 and subject is not null order by at desc limit 1", [kol.id]);
    if (last?.subject) subject = replySubject(last.subject);
  }
  if (!subject) throw new Error("新邮件要写主题");
  const action = d.action ?? {};
  subject = fillName(subject, kol);
  const body = fillName(d.body, kol);
  const problem = codeProblem(action.code) || placeholderProblem(action.code, body);
  if (problem) throw new Error(problem);
  if (!body.trim()) throw new Error("正文是空的");
  const hash = contentHash({ to_addr: to, mailbox, subject, body, action });
  const title = d.title ?? `${kol.name}`;
  try {
    if (d.proposalId) {
      const r = await ctx.db.query(
        `update proposals set kind=$3, title=$4, why=$5, mailbox=$6, to_addr=$7, subject=$8, body=$9, action=$10, content_hash=$11,
           status='pending', approved_hash=null, approved_at=null, updated_at=now()
         where id = $1 and project_id = $2 and kol_id = $12 and status in ('drafting', 'pending') returning id`,
        [d.proposalId, p.id, d.kind, title, d.why ?? null, mailbox, to, subject, body, JSON.stringify(action), hash, kol.id]);
      if (!r.length) throw new Error(`卡片 ${d.proposalId} 不是这位 KOL 的待写草稿（可能已经处理过）`);
      return { id: d.proposalId };
    }
    const r = await one<{ id: number }>(ctx.db,
      `insert into proposals (project_id, parent_id, kind, status, kol_id, title, why, mailbox, to_addr, subject, body, in_reply_to, action, content_hash)
       values ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [p.id, d.parentId ?? null, d.kind, kol.id, title, d.why ?? null, mailbox, to, subject, body, d.inReplyTo ?? null, JSON.stringify(action), hash]);
    await addLog(ctx, p, { kind: "proposal", who: d.who ?? "agent", kolId: kol.id, proposalId: r!.id, summary: `起草「${title}」待审核` });
    return r!;
  } catch (err: any) {
    if (String(err?.message).includes("proposals_one_pending_mail")) {
      const open = await one<{ id: number; status: string }>(ctx.db,
        "select id, status from proposals where project_id = $1 and kol_id = $2 and to_addr is not null and status in ('drafting','pending','approved','running','unknown')", [p.id, kol.id]);
      throw new Error(`${kol.name} 已经有一封待发的信（卡片 ${open?.id}，${open?.status}）。一位 KOL 同时只能有一封；要改就改那一封（draft_update），或在决策台把它撤掉`);
    }
    throw err;
  }
}

/** A card without a mail: a decision for the operator (unmatched sender, bounce, template, discovery, close…). */
export async function proposeDecision(ctx: Ctx, p: Project, d: { kind: string; title: string; why?: string; kolId?: number | null; action: ProposalAction; parentId?: number; inReplyTo?: number; who?: string }): Promise<{ id: number }> {
  const hash = contentHash({ action: d.action });
  const r = await one<{ id: number }>(ctx.db,
    `insert into proposals (project_id, parent_id, kind, status, kol_id, title, why, in_reply_to, action, content_hash)
     values ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9) returning id`,
    [p.id, d.parentId ?? null, d.kind, d.kolId ?? null, d.title, d.why ?? null, d.inReplyTo ?? null, JSON.stringify(d.action), hash]);
  await addLog(ctx, p, { kind: "proposal", who: d.who ?? "agent", kolId: d.kolId ?? null, proposalId: r!.id, summary: `提出「${d.title}」待决定` });
  return r!;
}

/** A group card (invite batch, follow-up group); items are added with parentId. */
export async function proposeGroup(ctx: Ctx, p: Project, d: { kind: string; title: string; why?: string; who?: string }): Promise<{ id: number }> {
  const r = await one<{ id: number }>(ctx.db,
    "insert into proposals (project_id, kind, status, title, why, content_hash) values ($1, $2, 'drafting', $3, $4, '') returning id",
    [p.id, d.kind, d.title, d.why ?? null]);
  return r!;
}

/** Group cards show once all items are in. */
export async function openGroup(ctx: Ctx, p: Project, id: number): Promise<number> {
  const items = await ctx.db.query("select id from proposals where parent_id = $1 and status = 'pending'", [id]);
  if (!items.length) {
    await ctx.db.query("update proposals set status = 'dropped', result = '没有要做的', done_at = now() where id = $1", [id]);
    return 0;
  }
  await ctx.db.query("update proposals set status = 'pending', updated_at = now() where id = $1", [id]);
  await addLog(ctx, p, { kind: "proposal", who: "agent", proposalId: id, summary: `排好一组（${items.length} 项）待审核` });
  return items.length;
}

/** Operator edits a card in the console. An approved card goes back to waiting. */
export async function editProposal(ctx: Ctx, p: Project, id: number, e: { subject?: string; body?: string; to?: string; mailbox?: string; action?: ProposalAction }): Promise<void> {
  const cur = await one<any>(ctx.db, "select * from proposals where id = $1 and project_id = $2", [id, p.id]);
  if (!cur) throw new Error("没有这张卡片");
  if (!["pending", "approved"].includes(cur.status)) throw new Error("这张卡片现在不能改");
  const next = { to_addr: e.to ?? cur.to_addr, mailbox: e.mailbox ?? cur.mailbox, subject: e.subject ?? cur.subject, body: e.body ?? cur.body, action: e.action ?? cur.action };
  if (next.body != null) {
    const problem = codeProblem(next.action?.code) || placeholderProblem(next.action?.code, next.body);
    if (problem) throw new Error(problem);
  }
  await ctx.db.query(
    `update proposals set to_addr=$3, mailbox=$4, subject=$5, body=$6, action=$7, content_hash=$8, status='pending',
       approved_hash=null, approved_at=null, updated_at=now() where id=$1 and project_id=$2`,
    [id, p.id, next.to_addr, next.mailbox, next.subject, next.body, JSON.stringify(next.action ?? {}), contentHash(next)]);
}

export class Stale extends Error {}

/**
 * Approves a card at the version the operator saw (hash). Group cards approve every item still in, except the
 * ones dropped. Mail cards then wait for the executor; the rest are done here.
 */
export async function approve(ctx: Ctx, p: Project, id: number, hash: string, drop: number[] = []): Promise<{ approved: number[] }> {
  const card = await one<any>(ctx.db, "select * from proposals where id = $1 and project_id = $2", [id, p.id]);
  if (!card) throw new Error("没有这张卡片");
  if (card.status !== "pending") throw new Stale(`这张卡片已经是「${card.status}」，刷新后再看`);
  const items = await ctx.db.query<any>("select * from proposals where parent_id = $1 and status = 'pending' order by id", [id]);
  const isGroup = items.length > 0 || !card.content_hash;
  if (isGroup) {
    if (hash !== groupHash(items)) throw new Stale("这组的内容刚变过，刷新后再看");
    const keep = items.filter((i) => !drop.includes(i.id));
    await ctx.db.query("update proposals set status='dropped', result='审核时剔掉', done_at=now(), updated_at=now() where id = any($1::int[]) and parent_id = $2", [drop, id]);
    for (const i of keep) await approveOne(ctx, p, i);
    await ctx.db.query("update proposals set status='done', approved_at=now(), done_at=now(), result=$2, updated_at=now() where id=$1", [id, `同意 ${keep.length} 项${drop.length ? `，剔掉 ${drop.length} 项` : ""}`]);
    await addLog(ctx, p, { kind: "approve", proposalId: id, summary: `同意「${card.title}」${keep.length} 项${drop.length ? `，剔掉 ${drop.length} 项` : ""}` });
    return { approved: keep.map((i) => i.id) };
  }
  if (hash !== card.content_hash) throw new Stale("这张卡片的内容刚变过，刷新后再看");
  await approveOne(ctx, p, card);
  await addLog(ctx, p, { kind: "approve", kolId: card.kol_id, proposalId: id, summary: `同意「${card.title}」` });
  return { approved: [id] };
}

export function groupHash(items: { id: number; content_hash: string }[]): string {
  return createHash("sha256").update(items.map((i) => `${i.id}:${i.content_hash}`).join(",")).digest("hex").slice(0, 16);
}

async function approveOne(ctx: Ctx, p: Project, card: any): Promise<void> {
  const r = await ctx.db.query("update proposals set status='approved', approved_hash=content_hash, approved_at=now(), updated_at=now() where id=$1 and status='pending' returning id", [card.id]);
  if (!r.length) throw new Stale("卡片刚被别处处理了");
  if (!card.to_addr) await applyDecision(ctx, p, card);
}

/** Cards that change only our own data are done at once. */
async function applyDecision(ctx: Ctx, p: Project, card: any): Promise<void> {
  const a: ProposalAction = card.action ?? {};
  let result = "已完成";
  await ctx.db.tx(async (q) => {
    if (card.kind === "unmatched" && a.match_kol_id && card.in_reply_to) {
      await q.query("update messages set kol_id = $2, pending = false, resolved_at = now() where id = $1", [card.in_reply_to, a.match_kol_id]);
      await q.query("update kols set last_inbound_at = greatest(last_inbound_at, (select at from messages where id = $1)), whose_turn = 'us', updated_at = now() where id = $2", [card.in_reply_to, a.match_kol_id]);
      result = "已关联到 KOL";
    } else if (card.kind === "unmatched" && card.in_reply_to) {
      await q.query("update messages set pending = false, resolved_at = now() where id = $1", [card.in_reply_to]);
      result = "不用处理";
    } else if (card.kind === "no_reply" && card.in_reply_to) {
      await q.query("update messages set pending = false, resolved_at = now() where id = $1", [card.in_reply_to]);
      if (card.kol_id) await q.query("update kols set whose_turn = 'kol', updated_at = now() where id = $1 and whose_turn = 'us'", [card.kol_id]);
      result = "不用回";
    } else if (card.kind === "bounce" && card.in_reply_to) {
      await q.query("update messages set pending = false, resolved_at = now() where id = $1", [card.in_reply_to]);
      result = a.bounce === "close" ? "已标退信并结案" : "已解除退信拦截";
    } else if (card.kind === "template" && a.template_id) {
      const draft = await one<any>(q, "select * from templates where id = $1 and project_id = $2", [a.template_id, p.id]);
      if (!draft) throw new Error("模板草稿不见了");
      if (draft.draft_of) {
        await q.query("update templates set subject=$2, body=$3, language=$4, purpose=$5, approved_at=now(), updated_at=now(), status='active' where id=$1",
          [draft.draft_of, draft.subject, draft.body, draft.language, draft.purpose]);
        await q.query("delete from templates where id = $1", [draft.id]);
      } else {
        await q.query("update templates set status='active', approved_at=now(), updated_at=now() where id=$1", [draft.id]);
      }
      result = "新版模板已启用";
    } else if (card.kind === "discovery" && a.candidates) {
      const n = await addCandidates(q, p, a.candidates, a.batch ?? `agent ${new Date(ctx.now()).toISOString().slice(0, 10)}`);
      result = `入库 ${n} 人`;
    }
    if (card.kol_id && a.after) await applyAfter(q, card.kol_id, a.after, ctx.now());
    await q.query("update proposals set status='done', result=$2, done_at=now(), updated_at=now() where id=$1", [card.id, result]);
  });
}

/** Adds people found by discovery; skips anyone whose handle or email is already in the project. */
export async function addCandidates(q: { query: (t: string, p?: unknown[]) => Promise<any[]> }, p: Project, list: Candidate[], batch: string): Promise<number> {
  let added = 0;
  for (const c of list) {
    const email = c.email?.toLowerCase() || null;
    const dup = await q.query(
      `select 1 from kols where project_id = $1 and ((lower(handle) = lower($2) and platform = $3) or ($4::text is not null and lower(email) = $4)) limit 1`,
      [p.id, c.handle, c.platform, email]);
    if (dup.length) continue;
    await q.query(
      `insert into kols (project_id, name, handle, platform, platforms, url, followers, email, other_emails, source_batch, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [p.id, c.name || c.handle, c.handle, c.platform, [c.platform], c.url, c.followers, email, c.other_emails?.join(", ") || null, batch,
        [c.note, c.bio && `简介：${c.bio}`].filter(Boolean).join("\n") || null]);
    added++;
  }
  return added;
}

export async function applyAfter(q: { query: (t: string, p?: unknown[]) => Promise<any[]> }, kolId: number, a: After, now: number): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [kolId];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (a.close_reason) {
    set("stage", "closed");
    set("close_reason", a.close_reason);
    set("whose_turn", "none");
    set("next_followup_at", null);
  } else if (a.stage) set("stage", a.stage);
  if (a.whose_turn && !a.close_reason) set("whose_turn", a.whose_turn);
  if (a.never_contact) {
    set("never_contact", true);
    set("never_reason", a.never_reason ?? a.close_reason ?? "对方要求");
  }
  if (a.next_followup_days != null && !a.close_reason) set("next_followup_at", new Date(now + a.next_followup_days * 86_400_000).toISOString());
  if (a.next_step) set("next_step", a.next_step);
  if (a.publish_due_at) set("publish_due_at", a.publish_due_at);
  if (!sets.length) return;
  await q.query(`update kols set ${sets.join(", ")}, updated_at = now() where id = $1`, vals);
}

/** 不做了: the card is withdrawn; an open mail slot frees up. */
export async function reject(ctx: Ctx, p: Project, id: number, note?: string): Promise<void> {
  const card = await one<any>(ctx.db, "select * from proposals where id = $1 and project_id = $2", [id, p.id]);
  if (!card) throw new Error("没有这张卡片");
  if (!["pending", "drafting", "approved", "failed"].includes(card.status)) throw new Error(`这张卡片已经是「${card.status}」`);
  await ctx.db.query("update proposals set status='rejected', result=$2, done_at=now(), updated_at=now() where (id=$1 or parent_id=$1) and status in ('pending','drafting','approved','failed')", [id, note ?? "不做了"]);
  // An unmatched mail or bounce the operator dropped no longer waits.
  if (card.in_reply_to && ["unmatched", "bounce"].includes(card.kind)) await ctx.db.query("update messages set pending=false where id=$1", [card.in_reply_to]);
  await addLog(ctx, p, { kind: "reject", kolId: card.kol_id, proposalId: id, summary: `不做「${card.title}」${note ? `：${note}` : ""}` });
}

/** Undo within a few seconds of approving or rejecting, as long as nothing has been done yet. */
export async function undo(ctx: Ctx, p: Project, id: number): Promise<void> {
  const r = await ctx.db.query(
    `update proposals set status='pending', approved_hash=null, approved_at=null, done_at=null, result=null, updated_at=now()
     where project_id=$2 and (id=$1 or parent_id=$1) and (status='approved' or (status in ('rejected','dropped') and done_at > now() - interval '30 seconds'))
       and not exists (select 1 from actions a where a.proposal_id = proposals.id) returning id`, [id, p.id]);
  if (!r.length) throw new Error("已经开始做了，撤不回来");
  await ctx.db.query("update proposals set status='pending', done_at=null, result=null where id=$1 and status='done' and parent_id is null and content_hash = ''", [id]);
  await addLog(ctx, p, { kind: "undo", proposalId: id, summary: "撤回了刚才的决定" });
}

/** 让它改: the card goes back to the agent with the operator's words. */
export async function requestRevision(ctx: Ctx, p: Project, id: number, feedback: string): Promise<void> {
  if (!feedback.trim()) throw new Error("写一句要怎么改");
  const r = await ctx.db.query("update proposals set status='drafting', feedback=$3, approved_hash=null, approved_at=null, updated_at=now() where id=$1 and project_id=$2 and status in ('pending','approved') returning kol_id", [id, p.id, feedback]);
  if (!r.length) throw new Error("这张卡片现在不能改");
  await ctx.db.query("insert into agent_jobs (project_id, kind, proposal_id, kol_id, input) values ($1, 'revise', $2, $3, $4)", [p.id, id, r[0].kol_id, JSON.stringify({ feedback })]);
  await addLog(ctx, p, { kind: "revise", kolId: r[0].kol_id, proposalId: id, summary: `让它改：${feedback}` });
}

/** A new mail from the KOL makes any open draft for them out of date; the agent rewrites it covering both. */
export async function supersedeOpenMail(ctx: Ctx, p: Project, kolId: number): Promise<number | null> {
  const r = await ctx.db.query<{ id: number }>(
    "update proposals set status='superseded', result='对方又来信，重新起草', done_at=now(), updated_at=now() where project_id=$1 and kol_id=$2 and to_addr is not null and status in ('pending','approved') returning id",
    [p.id, kolId]);
  return r[0]?.id ?? null;
}

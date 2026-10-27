/**
 * Every tool, once: the MCP server registers them for the agent, the CLI runs them by name, the console calls the
 * same functions. Inputs are zod shapes; handlers return plain JSON.
 */
import { z } from "zod";
import { addLog, dayOf, dayStart, project, type Ctx, type Project } from "./ctx.js";
import { one } from "./db/db.js";
import { findPeople } from "./discover.js";
import { GUIDE } from "./guide.js";
import { catchUp } from "./inbox.js";
import { prepareInvites, scanFollowups } from "./outreach.js";
import { findPosts, postMetrics, syncCodes } from "./posts.js";
import { CLOSE_REASONS, proposeDecision, proposeMail, STAGES } from "./proposals.js";
import { cleanSetting, LABELS, type Settings } from "./settings.js";
import { suggestCode } from "./tafu.js";
import { draftTemplate, listTemplates, PURPOSES } from "./templates.js";

export interface ToolCall {
  ctx: Ctx;
  p: Project;
  /** Who is calling: "operator", "agent", "agent-job-12". */
  who: string;
}

export interface Tool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  run(args: any, call: ToolCall): Promise<unknown>;
}

const after = z.object({
  stage: z.enum(STAGES as [string, ...string[]]).optional(),
  whose_turn: z.enum(["kol", "us", "none"]).optional(),
  close_reason: z.enum(CLOSE_REASONS as [string, ...string[]]).optional(),
  never_contact: z.boolean().optional(),
  never_reason: z.string().optional(),
  next_followup_days: z.number().optional(),
  next_step: z.string().optional(),
  publish_due_at: z.string().optional().describe("ISO 日期"),
}).optional().describe("发出后对这位 KOL 做的改动");

const code = z.union([
  z.object({ type: z.literal("trial_create"), code: z.string(), maxUses: z.number(), days: z.number() }),
  z.object({ type: z.literal("trial_extend"), code: z.string(), days: z.number() }),
  z.object({ type: z.literal("partner_create"), code: z.string(), market: z.string(), percentOff: z.number(), partnerName: z.string(), contact: z.string() }),
]).optional().describe("发信前先做的码动作");

/** Columns a KOL edit may touch. */
const KOL_FIELDS = ["name", "handle", "salutation", "platform", "url", "email", "other_emails", "followers", "market", "language", "content_type",
  "invite_angle", "requirements", "notes", "never_contact", "never_reason", "stage", "whose_turn", "level", "demand", "mailbox", "next_followup_at",
  "publish_due_at", "next_step", "close_reason", "deliverables", "tags", "other_accounts"] as const;

export async function kolDetail(ctx: Ctx, p: Project, id: number) {
  const kol = await one<any>(ctx.db, "select * from kols where id = $1 and project_id = $2", [id, p.id]);
  if (!kol) throw new Error(`没有编号 ${id} 的 KOL`);
  const [messages, codes, posts, cards] = await Promise.all([
    ctx.db.query("select id, direction, mailbox, subject, from_addr, to_addr, at, left(body, 3000) as body, summary, pending, bounce from messages where kol_id = $1 order by at desc limit 30", [id]),
    ctx.db.query("select * from codes where kol_id = $1 order by created_at", [id]),
    ctx.db.query("select * from posts where kol_id = $1 order by published_at", [id]),
    ctx.db.query("select id, kind, status, title, subject, left(body, 2000) as body, action, result, created_at from proposals where kol_id = $1 order by id desc limit 10", [id]),
  ]);
  return { kol, suggested_code: suggestCode(kol.handle, kol.name), messages, codes, posts, cards };
}

export async function today(ctx: Ctx, p: Project, date?: string) {
  const start = date ? new Date(`${date}T00:00:00${p.settings.timezone}`).toISOString() : dayStart(ctx.now(), p.settings.timezone);
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const log = await ctx.db.query("select at, kind, who, summary, kol_id, proposal_id from log where project_id = $1 and at >= $2 and at < $3 order by at", [p.id, start, end]);
  const count = (k: string) => log.filter((l: any) => l.kind === k).length;
  const waiting = await one<{ n: number }>(ctx.db, "select count(*)::int as n from proposals where project_id = $1 and status = 'pending' and parent_id is null", [p.id]);
  return { day: date ?? dayOf(ctx.now(), p.settings.timezone), sent: count("sent"), approved: count("approve"), incoming: log.filter((l: any) => l.kind === "inbox").length, waitingForOperator: waiting?.n ?? 0, log };
}

export const TOOLS: Tool[] = [
  {
    name: "guide",
    description: "kolpick 的规则和起草要求。开始干活前先读。",
    input: {},
    run: async () => GUIDE,
  },
  {
    name: "today",
    description: "某一天（默认今天）运营和 agent 做了什么：发了哪些信、批了什么、来了哪些信，以及还有几张卡片等运营决定。",
    input: { date: z.string().optional().describe("YYYY-MM-DD") },
    run: async (a, c) => today(c.ctx, c.p, a.date),
  },
  {
    name: "query",
    description: "只读 SQL（select / with），用来做分析。最多返回 500 行。记得按 project_id 过滤。",
    input: { sql: z.string() },
    run: async (a, c) => {
      if (!/^\s*(select|with)\b/i.test(a.sql) || /;\s*\S/.test(a.sql)) throw new Error("只能是一条 select 或 with 查询");
      return c.ctx.db.tx(async (q) => {
        await q.exec("set transaction read only");
        const rows = await q.query(`select * from (${a.sql.replace(/;\s*$/, "")}) as q limit 500`);
        return { project_id: c.p.id, rows };
      });
    },
  },
  {
    name: "kol_search",
    description: "按名字、账号、邮箱搜 KOL，可按阶段筛。",
    input: { q: z.string().optional(), stage: z.string().optional(), limit: z.number().optional() },
    run: async (a, c) => c.ctx.db.query(
      `select id, name, handle, platform, email, stage, whose_turn, mailbox, last_contact_at, last_inbound_at, never_contact from kols
       where project_id = $1 and ($2::text is null or name ilike '%' || $2 || '%' or handle ilike '%' || $2 || '%' or email ilike '%' || $2 || '%' or other_emails ilike '%' || $2 || '%')
         and ($3::text is null or stage = $3) order by coalesce(last_contact_at, created_at) desc limit $4`,
      [c.p.id, a.q || null, a.stage || null, Math.min(a.limit ?? 30, 200)]),
  },
  {
    name: "kol_get",
    description: "一位 KOL 的全部资料：档案、最近 30 封来往、码、帖子、卡片，以及建议的码名。",
    input: { id: z.number() },
    run: async (a, c) => kolDetail(c.ctx, c.p, a.id),
  },
  {
    name: "kol_update",
    description: `改一位 KOL 的资料或状态。可改：${KOL_FIELDS.join("、")}。`,
    input: { id: z.number(), fields: z.record(z.string(), z.any()) },
    run: async (a, c) => {
      const keys = Object.keys(a.fields);
      const bad = keys.filter((k) => !(KOL_FIELDS as readonly string[]).includes(k));
      if (bad.length) throw new Error(`不能改：${bad.join("、")}`);
      if (a.fields.stage && !STAGES.includes(a.fields.stage)) throw new Error(`阶段只能是 ${STAGES.join("、")}`);
      if (!keys.length) return { changed: 0 };
      const vals = keys.map((k) => a.fields[k]);
      const r = await c.ctx.db.query(`update kols set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")}, updated_at = now() where id = $1 and project_id = $2 returning name`,
        [a.id, c.p.id, ...vals]);
      if (!r.length) throw new Error(`没有编号 ${a.id} 的 KOL`);
      await addLog(c.ctx, c.p, { kind: "edit", who: c.who, kolId: a.id, summary: `改了 ${r[0].name}：${keys.map((k) => `${k}=${JSON.stringify(a.fields[k])}`).join("，").slice(0, 300)}` });
      return { changed: keys.length };
    },
  },
  {
    name: "kol_add",
    description: "手动加一位 KOL。",
    input: { name: z.string(), email: z.string().optional(), platform: z.string().optional(), handle: z.string().optional(), url: z.string().optional(),
      followers: z.number().optional(), notes: z.string().optional(), invite_angle: z.string().optional(), source_batch: z.string().optional() },
    run: async (a, c) => {
      const r = await one<{ id: number }>(c.ctx.db,
        `insert into kols (project_id, name, email, platform, platforms, handle, url, followers, notes, invite_angle, source_batch)
         values ($1, $2, lower($3), $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [c.p.id, a.name, a.email ?? null, a.platform ?? null, a.platform ? [a.platform] : [], a.handle ?? null, a.url ?? null, a.followers ?? null, a.notes ?? null,
          a.invite_angle ?? null, a.source_batch ?? "手动添加"]);
      await addLog(c.ctx, c.p, { kind: "edit", who: c.who, kolId: r!.id, summary: `加了 KOL ${a.name}` });
      return r;
    },
  },
  {
    name: "proposals",
    description: "卡片列表（默认等运营决定的）。status：drafting/pending/approved/running/done/failed/unknown/rejected。",
    input: { status: z.string().optional(), kind: z.string().optional(), limit: z.number().optional() },
    run: async (a, c) => c.ctx.db.query(
      `select id, parent_id, kind, status, kol_id, title, why, to_addr, subject, left(body, 600) as body, action, result, created_at from proposals
       where project_id = $1 and status = $2 and ($3::text is null or kind = $3) order by id desc limit $4`,
      [c.p.id, a.status ?? "pending", a.kind ?? null, Math.min(a.limit ?? 50, 300)]),
  },
  {
    name: "draft_mail",
    description: "起草一封信放进决策台等运营审核（不会直接发）。kind：reply 回信 / mail 主动写信 / followup 催信 / code_expiry 码到期 / checkin 问发布。"
      + "改已有的草稿或填后台给你的待写卡片时带 proposal_id。回信带 in_reply_to（来信编号），主题自动用 Re:。",
    input: {
      kol_id: z.number(), kind: z.enum(["reply", "mail", "followup", "code_expiry", "checkin"]), body: z.string(),
      subject: z.string().optional(), to: z.string().optional(), mailbox: z.string().optional(), in_reply_to: z.number().optional(),
      proposal_id: z.number().optional(), title: z.string().optional(), why: z.string().optional(), code, after,
    },
    run: async (a, c) => proposeMail(c.ctx, c.p, {
      kind: a.kind, kolId: a.kol_id, body: a.body, subject: a.subject, to: a.to, mailbox: a.mailbox, inReplyTo: a.in_reply_to,
      proposalId: a.proposal_id, title: a.title, why: a.why, action: { code: a.code, after: a.after }, who: c.who,
    }),
  },
  {
    name: "draft_decision",
    description: "提一个不发信的决定给运营：unmatched 对不上人的来信（match_kol_id 写是谁，不写=不用处理）、bounce 退信（bounce: close 结案 / clear 只解除拦截）、"
      + "no_reply 这封来信不用回、close 结案（after.close_reason）、other 其他。",
    input: {
      kind: z.enum(["unmatched", "bounce", "no_reply", "close", "other"]), title: z.string(), why: z.string().optional(),
      kol_id: z.number().optional(), message_id: z.number().optional(), match_kol_id: z.number().optional(),
      bounce: z.enum(["close", "clear"]).optional(), after,
    },
    run: async (a, c) => {
      const action: any = { after: a.after };
      if (a.match_kol_id) action.match_kol_id = a.match_kol_id;
      if (a.bounce) {
        action.bounce = a.bounce;
        if (a.bounce === "close") action.after = { close_reason: "退信或邮箱无效", ...(a.after ?? {}) };
      }
      return proposeDecision(c.ctx, c.p, { kind: a.kind, title: a.title, why: a.why, kolId: a.kol_id ?? null, inReplyTo: a.message_id, action, who: c.who });
    },
  },
  {
    name: "draft_template",
    description: `起草模板新版或新模板，进决策台对比新旧后由运营批准。用途：${PURPOSES.join("、")}。正文可用 {稱呼}{體驗碼}{次數}{到期日}{活動碼}{專屬連結}{帳本連結}{粉絲折扣}。`,
    input: { template_id: z.number().optional(), name: z.string(), purpose: z.string(), language: z.string().optional(), subject: z.string().optional(),
      body: z.string(), why: z.string().optional() },
    run: async (a, c) => draftTemplate(c.ctx, c.p, { templateId: a.template_id, name: a.name, purpose: a.purpose, language: a.language, subject: a.subject, body: a.body, why: a.why, who: c.who }),
  },
  {
    name: "templates",
    description: "所有模板（在用、草稿、停用）。",
    input: {},
    run: async (_a, c) => listTemplates(c.ctx, c.p),
  },
  {
    name: "find_people",
    description: "用 Apify 找人并查公开邮箱，结果变成一张「这批要不要入库」卡片。instagram 可给 seeds（相似账号扩量）和 keywords；youtube、tiktok 给 keywords；"
      + "handles 是直接查这些账号的邮箱。会花钱：budget 是美元上限（默认 5）。",
    input: { platform: z.enum(["instagram", "youtube", "tiktok"]), keywords: z.array(z.string()).optional(), seeds: z.array(z.string()).optional(),
      handles: z.array(z.string()).optional(), target: z.number().optional(), minFollowers: z.number().optional(), maxFollowers: z.number().optional(),
      youtubeHidden: z.boolean().optional(), budget: z.number().optional(), batch: z.string().optional() },
    run: async (a, c) => findPeople(c.ctx, c.p, a, { direct: false, who: c.who }),
  },
  {
    name: "invite_prepare",
    description: "把有邮箱、还没联系过的人排成一批邀约卡片（按今天各邮箱剩余额度），运营点一下就发。",
    input: { limit: z.number().optional(), batch: z.string().optional() },
    run: async (a, c) => prepareInvites(c.ctx, c.p, a),
  },
  {
    name: "followups_scan",
    description: "找出该催信、该无回应结案的人，排成一组卡片。",
    input: {},
    run: async (_a, c) => scanFollowups(c.ctx, c.p),
  },
  {
    name: "inbox_sync",
    description: "马上补收各发信邮箱的新邮件（来信会自动交给后台 agent 起草回复）。",
    input: { since: z.string().optional().describe("ISO 时间，默认从上次收到的地方") },
    run: async (a, c) => catchUp(c.ctx, c.p, a),
  },
  {
    name: "codes_sync",
    description: "从项目后台同步所有码的用量、到期和订单数。",
    input: {},
    run: async (_a, c) => syncCodes(c.ctx, c.p),
  },
  {
    name: "code_check",
    description: "查一个码名在项目后台是否已被占用。",
    input: { code: z.string() },
    run: async (a, c) => {
      const info = await c.ctx.tafu(c.p).lookup([a.code]);
      return { code: a.code, trialTaken: info.has(`trial:${a.code.toLowerCase()}`), partnerTaken: info.has(`partner:${a.code.toLowerCase()}`) };
    },
  },
  {
    name: "posts_find",
    description: "抓约好发布、合作中、已发布的 KOL 最近的帖子，提到项目的记进帖子表。花 Apify 的钱（budget 美元，默认 3）。",
    input: { budget: z.number().optional() },
    run: async (a, c) => findPosts(c.ctx, c.p, a),
  },
  {
    name: "posts_metrics",
    description: "给到了第 1/3/7/30 天的帖子抓播放和互动。",
    input: { budget: z.number().optional() },
    run: async (a, c) => postMetrics(c.ctx, c.p, a),
  },
  {
    name: "settings_get",
    description: "项目设置（规则）和发信邮箱。",
    input: {},
    run: async (_a, c) => ({
      paused: (await one<any>(c.ctx.db, "select paused from projects where id = $1", [c.p.id]))?.paused,
      settings: c.p.settings, labels: LABELS,
      mailboxes: await c.ctx.db.query("select address, enabled, daily_limit, warmup_from, warmup_start, warmup_step, note from mailboxes where project_id = $1 order by id", [c.p.id]),
    }),
  },
  {
    name: "settings_set",
    description: "改一项设置。key 见 settings_get 的 labels。",
    input: { key: z.string(), value: z.any() },
    run: async (a, c) => {
      const value = cleanSetting(a.key as keyof Settings, a.value);
      await c.ctx.db.query("update projects set settings = settings || jsonb_build_object($2::text, $3::jsonb) where id = $1", [c.p.id, a.key, JSON.stringify(value)]);
      await addLog(c.ctx, c.p, { kind: "settings", who: c.who, summary: `设置「${LABELS[a.key as keyof Settings]}」改成 ${JSON.stringify(value)}` });
      return { [a.key]: value };
    },
  },
  {
    name: "mailbox_set",
    description: "加或改一个发信邮箱：启用、每日上限、预热。",
    input: { address: z.string(), enabled: z.boolean().optional(), daily_limit: z.number().optional(), warmup_from: z.string().optional(),
      warmup_start: z.number().optional(), warmup_step: z.number().optional(), note: z.string().optional() },
    run: async (a, c) => {
      await c.ctx.db.query(
        `insert into mailboxes (project_id, address, enabled, daily_limit, warmup_from, warmup_start, warmup_step, note) values ($1, lower($2), coalesce($3, false), coalesce($4, 50), $5, $6, $7, $8)
         on conflict (project_id, address) do update set enabled = coalesce($3, mailboxes.enabled), daily_limit = coalesce($4, mailboxes.daily_limit),
           warmup_from = coalesce($5, mailboxes.warmup_from), warmup_start = coalesce($6, mailboxes.warmup_start), warmup_step = coalesce($7, mailboxes.warmup_step), note = coalesce($8, mailboxes.note)`,
        [c.p.id, a.address, a.enabled ?? null, a.daily_limit ?? null, a.warmup_from ?? null, a.warmup_start ?? null, a.warmup_step ?? null, a.note ?? null]);
      await addLog(c.ctx, c.p, { kind: "settings", who: c.who, summary: `发信邮箱 ${a.address}：${JSON.stringify({ ...a, address: undefined })}` });
      return { ok: true };
    },
  },
  {
    name: "pause_sending",
    description: "打开或关闭「暂停所有发送」。开着时不发信、不建码，收信照常。",
    input: { on: z.boolean() },
    run: async (a, c) => {
      await c.ctx.db.query("update projects set paused = $2 where id = $1", [c.p.id, a.on]);
      await addLog(c.ctx, c.p, { kind: "settings", who: c.who, summary: a.on ? "打开了「暂停所有发送」" : "关闭了「暂停所有发送」" });
      return { paused: a.on };
    },
  },
  {
    name: "job_done",
    description: "后台任务用：说明这个任务做完了（卡片已交）或不需要做什么。",
    input: { job_id: z.number(), note: z.string().optional() },
    run: async (a, c) => {
      const r = await c.ctx.db.query("update agent_jobs set status='done', output=coalesce($3, output), finished_at=now() where id=$1 and project_id=$2 and status in ('queued','running') returning id", [a.job_id, c.p.id, a.note ?? null]);
      return { ok: r.length > 0 };
    },
  },
  {
    name: "job_stuck",
    description: "后台任务用：卡住了、需要运营看一下，写清原因。",
    input: { job_id: z.number(), reason: z.string() },
    run: async (a, c) => {
      const r = await c.ctx.db.query("update agent_jobs set status='stuck', error=$3, finished_at=now() where id=$1 and project_id=$2 and status in ('queued','running') returning id", [a.job_id, c.p.id, a.reason]);
      return { ok: r.length > 0 };
    },
  },
];

/** Runs a tool by name with checked arguments. */
export async function callTool(ctx: Ctx, name: string, args: unknown, who: string, projectName?: string): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`没有工具 ${name}。有：${TOOLS.map((t) => t.name).join("、")}`);
  const parsed = z.object(tool.input).parse(args ?? {});
  const p = await project(ctx, projectName);
  return tool.run(parsed, { ctx, p, who });
}

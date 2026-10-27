/**
 * Loads a snapshot made by export.ts into the kolpick tables for one project. Running it again on the same
 * snapshot changes nothing: every row keeps its Feishu record id (legacy_*) and is matched on it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Db, one } from "../db/db.js";
import { DEFAULTS, type Settings } from "../settings.js";

type Row = Record<string, any> & { record_id: string };

export interface ImportOptions {
  project: string;
  /** Test databases: every mailbox is imported switched off. */
  disableMailboxes: boolean;
  log?: (line: string) => void;
}

export interface ImportCounts {
  kols: number;
  followups: number;
  messages: number;
  codes: number;
  posts: number;
  proposals: number;
  log: number;
  templates: number;
  mailboxes: number;
}

const STAGES: Record<string, string> = {
  已邀约: "invited", 已回复: "replied", 体验中: "trial", 已看报告: "report_seen", 已约发布: "publish_agreed",
  已发布: "published", 合作中: "partner", 暂缓: "on_hold", 结案: "closed",
};
const TURNS: Record<string, string> = { KOL: "kol", 我们: "us", 等你审核: "us", 无需动作: "none" };
const DIRECTIONS: Record<string, string> = { 发出: "out", 收到: "in", 存档: "note" };
const REVIEW_STATUS: Record<string, string> = { 已执行: "done", 已撤回: "dropped", 待执行: "pending", 待你审核: "pending", 执行失败: "failed" };
const TEMPLATE_STATUS: Record<string, string> = { 已批准: "active", 草稿: "draft", 待审核: "draft", 停用: "retired" };

export function readSnapshot(dir: string, table: string): Row[] {
  return JSON.parse(readFileSync(path.join(dir, `${table}.json`), "utf8")).rows;
}

const first = (v: any): string | null => (Array.isArray(v) ? (v[0] ?? null) : v ?? null);
const list = (v: any): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
const text = (v: any): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
};
const num = (v: any): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const linkId = (v: any): string | null => (Array.isArray(v) && v[0]?.id) || null;
/** Feishu gives URL cells as "[url](url)". */
export function plainUrl(v: any): string | null {
  const s = text(v);
  if (!s) return null;
  const m = s.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
  return m ? m[2] || m[1] : s;
}
const email = (v: any): string | null => text(v)?.toLowerCase() ?? null;

/** "主旨：…\n寄件人：…\n收件人：…" heads the body of mails the old plugin recorded. */
export function mailHeader(body: string | null): { subject?: string; from?: string; to?: string } {
  const out: { subject?: string; from?: string; to?: string } = {};
  for (const line of (body ?? "").split("\n").slice(0, 5)) {
    const m = line.match(/^(主旨|寄件人|收件人)：(.*)$/);
    if (m) out[m[1] === "主旨" ? "subject" : m[1] === "寄件人" ? "from" : "to"] = m[2].trim();
  }
  return out;
}

/**
 * Inserts many rows in one statement per 500: rows go in as one JSON array and come out through jsonb_to_recordset.
 * Columns typed "text[]" travel as JSON arrays.
 */
async function insertMany(q: Db, table: string, cols: [string, string][], rows: unknown[][], tail: string, returning = ""): Promise<any[]> {
  const out: any[] = [];
  const names = cols.map(([c]) => c).join(", ");
  const decl = cols.map(([c, ty]) => `${c} ${ty === "text[]" ? "jsonb" : ty}`).join(", ");
  const pick = cols.map(([c, ty]) => (ty === "text[]" ? `coalesce(array(select jsonb_array_elements_text(x.${c})), '{}')` : `x.${c}`)).join(", ");
  for (let i = 0; i < rows.length; i += 500) {
    const json = rows.slice(i, i + 500).map((r) => Object.fromEntries(cols.map(([c], j) => [c, r[j] ?? null])));
    out.push(...(await q.query(`insert into ${table} (${names}) select ${pick} from jsonb_to_recordset($1::text::jsonb) as x(${decl}) ${tail} ${returning && `returning ${returning}`}`, [JSON.stringify(json)])));
  }
  return out;
}

export async function importSnapshot(db: Db, dir: string, opts: ImportOptions): Promise<ImportCounts> {
  const log = opts.log ?? (() => {});
  const counts: ImportCounts = { kols: 0, followups: 0, messages: 0, codes: 0, posts: 0, proposals: 0, log: 0, templates: 0, mailboxes: 0 };
  const t = (name: string) => readSnapshot(dir, name);

  return db.tx(async (q) => {
    // --- project and settings ---
    const s = t("设置")[0] ?? {};
    const settings: Partial<Settings> = {
      timezone: text(s["时区"]) ?? DEFAULTS.timezone,
      dailyLimit: num(s["全公司每日上限"]) ?? DEFAULTS.dailyLimit,
      perMinute: num(s["每分钟上限"]) ?? DEFAULTS.perMinute,
      bounceRate: num(s["退信率暂停线"]) ?? DEFAULTS.bounceRate,
      followup1Days: num(s["第一次催信天数"]) ?? DEFAULTS.followup1Days,
      followup2Days: num(s["第二次催信天数"]) ?? DEFAULTS.followup2Days,
      closeDays: num(s["结案天数"]) ?? DEFAULTS.closeDays,
      noFollowupLevels: list(text(s["不催级别"])?.split(/[、,，]/)).map((x) => x.trim()).filter(Boolean),
      noFollowupDemands: list(text(s["不催的对方要求"])?.split(/[、,，]/)).map((x) => x.trim()).filter(Boolean),
      noFollowupChannels: list(text(s["不催渠道"])?.split(/[、,，]/)).map((x) => x.trim()).filter(Boolean),
      cooldownDays: num(s["跨项目冷却天数"]) ?? DEFAULTS.cooldownDays,
      trialUses: num(s["体验码默认次数"]) ?? DEFAULTS.trialUses,
      trialDays: num(s["体验码默认天数"]) ?? DEFAULTS.trialDays,
      trialUnusedDays: num(s["体验未用提醒天数"]) ?? DEFAULTS.trialUnusedDays,
      trialExpiryDays: num(s["体验到期提醒天数"]) ?? DEFAULTS.trialExpiryDays,
      partnerDiscount: num(s["活动码粉丝折扣"]) ?? DEFAULTS.partnerDiscount,
      ...parseMarkets(text(s["活动码市场"])),
      postKeyword: text(s["发布识别词"]) ?? "",
      postLookbackDays: num(s["发布回看天数"]) ?? DEFAULTS.postLookbackDays,
      findCountry: text(s["找人国家"]) ?? "",
      findLanguage: text(s["找人语言"]) ?? "",
      dataApiUrl: text(s["业务数据接口"]) ?? "",
      feishuWebhook: text(s["飞书群机器人"]) ?? "",
    };
    const project = await one<{ id: number }>(q,
      `insert into projects (name, settings, paused) values ($1, $2, $3)
       on conflict (name) do update set settings = excluded.settings, paused = excluded.paused or projects.paused
       returning id`, [opts.project, settings, s["暂停所有发送"] === true]);
    const pid = project!.id;

    // --- mailboxes ---
    for (const m of t("发信邮箱")) {
      const address = email(m["邮箱"]);
      if (!address) continue;
      await q.query(
        `insert into mailboxes (project_id, address, enabled, daily_limit, warmup_from, warmup_start, warmup_step, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (project_id, address) do update set daily_limit = excluded.daily_limit,
           enabled = excluded.enabled and mailboxes.enabled, note = excluded.note`,
        [pid, address, !opts.disableMailboxes && m["启用"] === true, num(m["每日上限"]) ?? 50, m["启用日期"] ? m["启用日期"].slice(0, 10) : null,
          num(m["起步上限"]), num(m["每天增加"]), text(m["说明"])]);
      counts.mailboxes++;
    }

    // --- templates (matched by name) ---
    for (const tp of t("模板")) {
      const name = text(tp["名称"]);
      if (!name) continue;
      const status = TEMPLATE_STATUS[first(tp["状态"]) ?? ""] ?? "draft";
      const existing = await one<{ id: number }>(q, "select id from templates where project_id = $1 and name = $2 and draft_of is null", [pid, name]);
      const values = [first(tp["用途"]) ?? "其他", text(tp["语言"]), text(tp["主旨"]), text(tp["正文"]) ?? "", status, text(tp["备注"]), tp["审核时间"] ?? null];
      if (existing) await q.query("update templates set purpose=$2, language=$3, subject=$4, body=$5, status=$6, note=$7, approved_at=$8 where id=$1", [existing.id, ...values]);
      else await q.query("insert into templates (project_id, name, purpose, language, subject, body, status, note, approved_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [pid, name, ...values]);
      counts.templates++;
    }

    // --- KOLs: profile + its followup (at most one per profile) ---
    const followups = new Map<string, Row>();
    for (const f of t("KOL 跟进")) {
      const p = linkId(f["档案"]);
      if (p) followups.set(p, f);
    }
    const kolByFollowup = new Map<string, number>();
    const kolRows: unknown[][] = [];
    for (const p of t("KOL 档案")) {
      const f = followups.get(p.record_id);
      const notes = [text(p["备注"]), text(p["备选批次"]) && `备选批次：${text(p["备选批次"])}`, f && text(f["备注"]) && `跟进备注：${text(f["备注"])}`].filter(Boolean).join("\n\n") || null;
      const platforms = list(p["主要平台"]);
      kolRows.push([
        pid, text(p["账号名称"]) ?? text(p["账号"]) ?? "(无名)", text(p["账号"]), text(p["称呼"]), platforms[0] ?? null, platforms,
        plainUrl(p["主页链接"]), text(p["其他平台账号"]), email(p["公开邮箱"]), text(p["其他邮箱"]), num(p["粉丝数"]),
        first(p["市场"]), first(p["語言"]), first(p["内容类型"]), list(p["标签"]), first(p["合作邀约方向"]), first(p["入库批次"]),
        text(p["合作要求"]), notes, first(p["联系许可"]) === "永不联系", text(p["联系许可原因"]),
        f ? STAGES[first(f["阶段"]) ?? ""] ?? "invited" : "new", f ? TURNS[first(f["当前轮到谁"]) ?? ""] ?? null : null,
        f ? first(f["级别"]) : null, f ? first(f["对方要求"]) : null, f ? first(f["联系渠道"]) : null, f ? first(f["邀约批次"]) : null,
        f?.["首次邀约日期"] ?? null, f?.["最近联系日期"] ?? null, f?.["最后来信日期"] ?? null, f?.["下次跟进日期"] ?? null,
        f?.["约定发布日期"] ?? null, f ? text(f["下一步"]) : null, f ? first(f["结案原因"]) : null, f ? list(f["交付清单"]) : [],
        p.record_id, f?.record_id ?? null, p["录入时间"] ?? p["入库日期"] ?? new Date().toISOString(),
      ]);
    }
    const kolCols: [string, string][] = [["project_id", "int"], ["name", "text"], ["handle", "text"], ["salutation", "text"], ["platform", "text"],
      ["platforms", "text[]"], ["url", "text"], ["other_accounts", "text"], ["email", "text"], ["other_emails", "text"], ["followers", "int"],
      ["market", "text"], ["language", "text"], ["content_type", "text"], ["tags", "text[]"], ["invite_angle", "text"], ["source_batch", "text"],
      ["requirements", "text"], ["notes", "text"], ["never_contact", "boolean"], ["never_reason", "text"], ["stage", "text"], ["whose_turn", "text"],
      ["level", "text"], ["demand", "text"], ["mailbox", "text"], ["invite_batch", "text"], ["first_invited_at", "timestamptz"],
      ["last_contact_at", "timestamptz"], ["last_inbound_at", "timestamptz"], ["next_followup_at", "timestamptz"], ["publish_due_at", "timestamptz"],
      ["next_step", "text"], ["close_reason", "text"], ["deliverables", "text[]"], ["legacy_profile", "text"], ["legacy_followup", "text"], ["created_at", "timestamptz"]];
    const updatable = kolCols.map(([c]) => c).filter((c) => !["project_id", "legacy_profile", "created_at"].includes(c));
    const kols = await insertMany(q, "kols", kolCols, kolRows,
      `on conflict (legacy_profile) do update set ${updatable.map((c) => `${c} = excluded.${c}`).join(", ")}`, "id, legacy_followup");
    counts.kols = kols.length;
    for (const k of kols) if (k.legacy_followup) kolByFollowup.set(k.legacy_followup, k.id);
    counts.followups = kolByFollowup.size;
    const codeRows = [...followups.values()].filter((f) => kolByFollowup.has(f.record_id)).map((f) => ({ kol: kolByFollowup.get(f.record_id)!, f }));
    log(`KOL ${counts.kols}（其中有跟进的 ${counts.followups}）`);

    // --- codes ---
    const trialRows = codeRows.filter(({ f }) => text(f["体验码"])).map(({ kol, f }) =>
      [pid, kol, "trial", text(f["体验码"]), num(f["体验码上限"]), num(f["体验码已用"]), f["体验码到期"] ?? null, f["体验码最近使用"] ?? null, null, null]);
    const partnerRows = codeRows.filter(({ f }) => text(f["活动码"])).map(({ kol, f }) =>
      [pid, kol, "partner", text(f["活动码"]), null, null, null, null, plainUrl(f["专属连结"]), plainUrl(f["账本连结"])]);
    counts.codes = (await insertMany(q, "codes", [["project_id", "int"], ["kol_id", "int"], ["kind", "text"], ["code", "text"], ["max_uses", "int"],
      ["used", "int"], ["expires_at", "timestamptz"], ["last_used_at", "timestamptz"], ["ref_link", "text"], ["ledger_link", "text"]],
      [...new Map([...trialRows, ...partnerRows].map((r) => [`${r[2]}:${String(r[3]).toLowerCase()}`, r])).values()],
      `on conflict (project_id, kind, code) do update set kol_id = excluded.kol_id, max_uses = excluded.max_uses, used = excluded.used,
         expires_at = excluded.expires_at, last_used_at = excluded.last_used_at, ref_link = excluded.ref_link, ledger_link = excluded.ledger_link`, "id")).length;

    // --- messages ---
    const msgRows = t("接触记录").map((c) => {
      const body = text(c["内容"]);
      const h = mailHeader(body);
      const summary = [text(c["摘要"]), text(c["邮件链接"]) && `邮件链接：${text(c["邮件链接"])}`].filter(Boolean).join("\n") || null;
      return [pid, kolByFollowup.get(linkId(c["KOL"]) ?? "") ?? null, DIRECTIONS[first(c["方向"]) ?? ""] ?? "note", first(c["渠道"]), text(c["Message ID"]),
        h.subject ?? null, h.from ?? null, h.to ?? null, body, summary, c["日期"], c["待处理"] === true, c.record_id];
    });
    // Same mail recorded twice in Feishu: the first copy wins (messages_unique_mail).
    counts.messages = (await insertMany(q, "messages", [["project_id", "int"], ["kol_id", "int"], ["direction", "text"], ["mailbox", "text"],
      ["message_id", "text"], ["subject", "text"], ["from_addr", "text"], ["to_addr", "text"], ["body", "text"], ["summary", "text"],
      ["at", "timestamptz"], ["pending", "boolean"], ["legacy_id", "text"]], msgRows, "on conflict do nothing", "id")).length;
    log(`来往 ${counts.messages}`);

    // --- posts ---
    for (const p of t("发布内容")) {
      const kol = kolByFollowup.get(linkId(p["KOL"]) ?? "");
      const url = plainUrl(p["内容链接"]);
      if (!kol || !url) continue;
      const metrics: Record<string, { views: number | null; engagement: number | null }> = {};
      for (const d of [1, 3, 7, 30]) {
        const views = num(p[`第${d}天播放`]), engagement = num(p[`第${d}天互动`]);
        if (views != null || engagement != null) metrics[String(d)] = { views, engagement };
      }
      await q.query(
        `insert into posts (project_id, kol_id, url, platform, format, title, published_at, link_placed, metrics, notes, legacy_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (legacy_id) do update set url = excluded.url, metrics = excluded.metrics, notes = excluded.notes, title = excluded.title`,
        [pid, kol, url, first(p["平台"]), first(p["形式"]), text(p["内容标题"]), p["发布日期"] ?? null, p["链接已放置"] ?? null, metrics, text(p["备注"]), p.record_id]);
      counts.posts++;
    }

    // --- old review cards: kept as history; open ones stay open as "legacy" for the operator to close ---
    const raw = (r: Row, skip: string[]) => Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== "record_id" && !skip.includes(k) && v != null && v !== ""));
    const reviewRows = t("审核队列").map((r) => [pid, "legacy", REVIEW_STATUS[first(r["状态"]) ?? ""] ?? "done", kolByFollowup.get(linkId(r["KOL"]) ?? "") ?? null,
      text(r["审核项"]), text(r["要你定什么"]) ?? text(r["我的判断和建议"]), first(r["发送渠道"]), text(r["邮件草稿"]), text(r["你的意见"]),
      text(r["执行结果"]), r.record_id, raw(r, []), r["提出时间"] ?? new Date().toISOString(), r["执行时间"] ?? null]);
    counts.proposals = (await insertMany(q, "proposals", [["project_id", "int"], ["kind", "text"], ["status", "text"], ["kol_id", "int"], ["title", "text"],
      ["why", "text"], ["mailbox", "text"], ["body", "text"], ["feedback", "text"], ["result", "text"], ["legacy_id", "text"], ["legacy", "jsonb"],
      ["created_at", "timestamptz"], ["done_at", "timestamptz"]], reviewRows,
      "on conflict (legacy_id) do update set status = excluded.status, result = excluded.result, legacy = excluded.legacy", "id")).length;

    // --- old 运行记录 and 操作日志 ---
    const logRows = [
      ...t("运行记录").map((r) => [pid, r["开始时间"] ?? r["结束时间"] ?? new Date().toISOString(), "legacy_run", null,
        `${text(r["运行"]) ?? "运行"}（${first(r["结果"]) ?? ""}）`, raw(r, ["包含操作"]), r.record_id]),
      ...t("操作日志").map((r) => [pid, r["时间"], `legacy_${first(r["类型"]) ?? "操作"}`, kolByFollowup.get(linkId(r["KOL"]) ?? "") ?? null,
        [text(r["操作"]), text(r["说明"])].filter(Boolean).join("：") || "(无说明)", raw(r, ["KOL", "所属运行"]), r.record_id]),
    ];
    counts.log = (await insertMany(q, "log", [["project_id", "int"], ["at", "timestamptz"], ["kind", "text"], ["kol_id", "int"], ["summary", "text"],
      ["detail", "jsonb"], ["legacy_id", "text"], ["who", "text"]], logRows.map((r) => [...r, "legacy"]),
      "on conflict (legacy_id) do update set summary = excluded.summary, detail = excluded.detail", "id")).length;
    log(`审核单 ${counts.proposals}，日志 ${counts.log}`);
    return counts;
  });
}

/** "台湾=TW，大陆=CN，其他=GLOBAL" → partnerMarkets + partnerMarketDefault. */
export function parseMarkets(v: string | null): Pick<Settings, "partnerMarkets" | "partnerMarketDefault"> {
  const markets: Record<string, string> = {};
  let fallback = DEFAULTS.partnerMarketDefault;
  for (const part of (v ?? "").split(/[、,，]/)) {
    const [k, code] = part.split("=").map((x) => x.trim());
    if (!k || !code) continue;
    if (k === "其他") fallback = code;
    else markets[k] = code;
  }
  return { partnerMarkets: markets, partnerMarketDefault: fallback };
}

/** Row counts per table for a project, for the cutover check. */
export async function projectCounts(db: Db, project: string): Promise<Record<string, number>> {
  const p = await one<{ id: number }>(db, "select id from projects where name = $1", [project]);
  if (!p) return {};
  const out: Record<string, number> = {};
  for (const table of ["kols", "messages", "codes", "posts", "proposals", "log", "templates", "mailboxes"]) {
    out[table] = Number((await one<{ n: number }>(db, `select count(*)::int as n from ${table} where project_id = $1`, [p.id]))!.n);
  }
  out.followups = Number((await one<{ n: number }>(db, "select count(*)::int as n from kols where project_id = $1 and legacy_followup is not null", [p.id]))!.n);
  return out;
}

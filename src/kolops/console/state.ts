import { addDays, cellTime, day, daysBetween, emailsIn, linkIds, onOrAfter, option, text } from "../base.js";
import { mailboxFor, type Config } from "../config.js";
import type { Ctx } from "../ctx.js";
import { displayName, loadSnapshot, profileEmails, profileOf, type Snapshot } from "../data.js";
import { ownWords } from "../inbox.js";
import type { Row } from "../lark.js";
import { addressOf, splitDraft } from "../mail.js";
import { stamp, today } from "../ops.js";
import { executesOnApproval, reviewState } from "../reviews.js";
import { SENDING_TYPES } from "../send.js";

/**
 * What the decision console shows, built from the project's base. Everything here only reads: the console's
 * first version shows the work, and decisions are still made in the base and carried out by `kol send`.
 */

export interface Step {
  text: string;
  /** `field` names the 审核队列 field a reviewer may change from the card; `value` starting with 「（」 is a default shown only. */
  params?: { label: string; value: string; field?: string }[];
}

export interface Card {
  id: string;
  kind: "problem" | "overdue" | "reply" | "mail" | "unknown" | "batch" | "template" | "todo";
  group: string;
  tag: string;
  headline: string;
  who?: { id: string; name: string };
  meta: string;
  mail?: { label: string; text: string; when: string };
  suggest: string;
  steps: Step[];
  why: string;
  draft?: { label: string; subject: string; body: string };
}

export interface Cell {
  v: string;
  tone?: "warn" | "bad" | "ok" | "muted";
  badge?: boolean;
  /** "decide" links to the decision queue; any other string is an outside URL. */
  link?: string;
}

export interface PeopleRow {
  id: string;
  /** Profiles not yet contacted have no followup, so they have no detail page yet. */
  hasDetail: boolean;
  handle: string;
  sub: string;
  cells: Cell[];
}

export const VIEWS = {
  wait: { label: "等我们回", question: "先回谁？等得最久的在上面。", columns: ["现在的情况", "等了", "待你决定", "下次跟进"] },
  noreply: { label: "邀了没回", question: "邀约了还没回信的人。", columns: ["哪天邀的", "下次跟进", "邀约批次", "用哪个邮箱"] },
  trial: { label: "在试用", question: "发了体验码、还没谈合作的人。谁快到期、谁领了码还没用？", columns: ["用了几次", "哪天到期", "上次联系", "接下来"] },
  deal: { label: "谈合作", question: "试用过、想合作，但还没约好哪天发。卡在哪一步？", columns: ["现在的情况", "活动码", "上次联系", "接下来"] },
  post: { label: "约好要发布", question: "约好了日期、还没找到帖子的人。谁快该发了？", columns: ["约好哪天", "活动码", "接下来"] },
  posted: { label: "已发布", question: "发了什么、效果怎么样？", columns: ["帖子", "哪天发的", "播放（最新）", "活动码"] },
  pool: { label: "还没联系过", question: "有能用的邮箱、还没联系过的人。挑谁去邀约？", columns: ["内容", "粉丝", "市场", "哪一批找到的"] },
  all: { label: "全部在跟进的", question: "整体扫一眼。", columns: ["现在的情况", "到哪一步", "下次跟进"] },
} as const;
export type ViewKey = keyof typeof VIEWS;

export const STAGES = ["邀约", "回复", "试用", "合作", "约好发布", "已发布"];
const STAGE_STEP: Record<string, number> = { 已邀约: 0, 已回复: 1, 体验中: 2, 已看报告: 3, 合作中: 3, 已约发布: 4, 已发布: 5 };
/** How many days past the agreed date before a missing post becomes something to decide on. */
const OVERDUE_GRACE_DAYS = 2;
/** Failures older than this drop off the queue; they stay in the log. */
const PROBLEM_DAYS = 7;

const REVIEW_FIELDS = ["审核项", "类型", "状态", "处理", "审核结果", "KOL", "你的意见", "我的判断和建议", "要你定什么", "邮件草稿",
  "收件人", "发送渠道", "提出时间", "执行时间", "执行结果", "体验码动作", "体验码", "体验次数", "体验天数", "活动码", "粉丝折扣",
  "销售市场", "发后动作", "结案原因"];
const POST_FIELDS = ["KOL", "内容链接", "内容标题", "发布日期", "平台", "形式", "第1天播放", "第3天播放", "第7天播放", "第30天播放"];

/** Everything the console needs that is slow to read, kept between page loads and refreshed on demand. */
export class ConsoleData {
  snapshot!: Snapshot;
  reviews: Row[] = [];
  pendingMail: Row[] = [];
  posts: Row[] = [];
  loadedAt = 0;

  constructor(private ctx: Ctx) {}

  async refresh(): Promise<void> {
    const { base, cfg } = this.ctx;
    const t = cfg.tables;
    const since = addDays(today(cfg), -PROBLEM_DAYS);
    const [snapshot, open, failed, pendingMail, posts] = await Promise.all([
      loadSnapshot(base, cfg),
      base.records(t.reviews, { filter: { logic: "and", conditions: [["状态", "intersects", ["待你审核", "待执行"]]] }, fields: REVIEW_FIELDS }),
      base.records(t.reviews, { filter: { logic: "and", conditions: [["状态", "intersects", ["执行失败"]], onOrAfter("执行时间", since)] }, fields: REVIEW_FIELDS }),
      base.records(t.contacts, { filter: { logic: "and", conditions: [["待处理", "==", true], ["方向", "intersects", ["收到"]]] },
        fields: ["Message ID", "渠道", "摘要", "日期", "KOL", "待处理", "方向", "内容"] }),
      base.records(t.posts, { fields: POST_FIELDS }).catch(() => [] as Row[]),
    ]);
    this.snapshot = snapshot;
    this.reviews = [...open, ...failed];
    this.pendingMail = pendingMail;
    this.posts = posts;
    this.loadedAt = Date.now();
  }
}

// --- Small formatting helpers ---

export function fans(v: unknown): string {
  const n = Number(v);
  if (!v || Number.isNaN(n)) return "";
  return n >= 10_000 ? `${(n / 10_000).toFixed(1).replace(/\.0$/, "")} 万` : n.toLocaleString("en-US");
}

/** "今天", "昨天", "3 天前", or the date for anything older than a month. */
export function ago(dayStr: string, todayStr: string): string {
  if (!dayStr) return "";
  const n = daysBetween(dayStr, todayStr);
  if (n <= 0) return n === 0 ? "今天" : shortDay(dayStr);
  if (n === 1) return "昨天";
  return n <= 30 ? `${n} 天前` : shortDay(dayStr);
}

/** "今天", "明天", "3 天后", or the date. */
export function ahead(dayStr: string, todayStr: string): string {
  if (!dayStr) return "";
  const n = daysBetween(todayStr, dayStr);
  if (n === 0) return "今天";
  if (n === 1) return "明天";
  if (n > 1 && n <= 7) return `${n} 天后（${shortDay(dayStr)}）`;
  return shortDay(dayStr);
}

export function shortDay(dayStr: string): string {
  const [, m, d] = dayStr.split("-").map(Number);
  return m && d ? `${m} 月 ${d} 日` : dayStr;
}

function handleOf(s: Snapshot, f: Row): string {
  const p = profileOf(s, f);
  const h = text(p?.["账号"]);
  return h ? (h.startsWith("@") ? h : `@${h}`) : displayName(s, f);
}

function subOf(p: Row | undefined, name: string): string {
  const platform = text(p?.["主要平台"]).split(",")[0]?.trim();
  return [text(p?.["称呼"]) || name, [platform, fans(p?.["粉丝数"])].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

/** One plain sentence about where a followup stands. */
export function situationOf(f: Row, cfg: Config, todayStr: string): string {
  const tz = cfg.timezone;
  const stage = option(f["阶段"]);
  const turn = option(f["当前轮到谁"]);
  const code = text(f["活动码"]);
  switch (stage) {
    case "已邀约": return `邀约了还没回（${shortDay(day(f["首次邀约日期"], tz)) || "日期不详"}）`;
    case "已回复": return turn === "我们" || turn === "等你审核" ? "回信了，等我们回" : "回过信，在等对方";
    case "体验中": {
      const used = Number(f["体验码已用"]) || 0;
      const max = Number(f["体验码上限"]) || 0;
      const exp = day(f["体验码到期"], tz);
      return `在试用${max ? `，用了 ${used} / ${max} 次` : ""}${exp ? `，${ahead(exp, todayStr)}到期` : ""}`;
    }
    case "已看报告": return "试用过，看了报告";
    case "合作中": return code ? `在谈合作，活动码 ${code} 已开` : "在谈合作";
    case "已约发布": return `约好 ${shortDay(day(f["约定发布日期"], tz)) || "（日期没填）"} 发布`;
    case "已发布": return "已经发布";
    case "暂缓": return "暂缓";
    case "结案": return `已结案${option(f["结案原因"]) ? `（${option(f["结案原因"])}）` : ""}`;
    default: return text(f["下一步"]) || stage;
  }
}

// --- The decision queue ---

const GROUP_ORDER = ["出了问题", "发布", "回信", "来信", "邀约和决定", "模板", "其他"];

export function decisionCards(data: ConsoleData, cfg: Config, todayStr: string, mails: Map<string, MailText> = new Map()): { cards: Card[]; waitingClaude: number } {
  const s = data.snapshot;
  const tz = cfg.timezone;
  const cards: Card[] = [];
  const who = (fid: string) => {
    const f = s.followups.get(fid);
    return f ? { id: fid, name: `${handleOf(s, f)} ${text(profileOf(s, f)?.["称呼"]) || ""}`.trim() } : undefined;
  };
  const meta = (fid: string) => {
    const f = s.followups.get(fid);
    if (!f) return "";
    const p = profileOf(s, f);
    return [option(f["阶段"]), subOf(p, "").replace(/^ · /, "")].filter(Boolean).join(" · ");
  };

  for (const r of data.reviews.filter((r) => option(r["状态"]) === "执行失败")) {
    const fid = linkIds(r["KOL"])[0] ?? "";
    const w = who(fid);
    cards.push({
      id: r.record_id, kind: "problem", group: "出了问题", tag: "没做成", who: w,
      headline: `${w?.name ?? text(r["审核项"])}：${text(r["审核项"]) || "这件事"}没做成`,
      meta: `${stamp(cellTime(r["执行时间"], tz) ?? Date.now(), tz)} 执行`,
      suggest: "看一下原因，处理好以后在飞书审核队列里重新安排",
      steps: [], why: text(r["执行结果"]) || "没有写原因",
    });
  }

  for (const f of s.followups.values()) {
    if (option(f["阶段"]) !== "已约发布") continue;
    const due = day(f["约定发布日期"], tz);
    if (!due || daysBetween(due, todayStr) < OVERDUE_GRACE_DAYS) continue;
    const late = daysBetween(due, todayStr);
    const w = who(f.record_id);
    const code = text(f["活动码"]);
    cards.push({
      id: `overdue:${f.record_id}`, kind: "overdue", group: "发布", tag: "没按时发布", who: w,
      headline: `${w?.name ?? displayName(s, f)} 约好 ${shortDay(due)} 发布，过了 ${late} 天还没找到帖子`, meta: meta(f.record_id),
      suggest: "先去她的主页看一眼；还没发的话，写信问她一下",
      steps: [{ text: "已经发了的话，把帖子链接记进「发布内容」，之后会自动记播放和互动" }, { text: "还没发的话，在 Claude 里说「给她写一封确认发布时间的信」" }],
      why: `系统每天看她最近的帖子，没找到提到「${cfg.postWords.join("、") || "项目识别词"}」${code ? `或活动码 ${code}` : ""}的。可能还没发，也可能发了但没提，系统认不出来。`,
    });
  }

  const openByKol = new Set<string>();
  let waitingClaude = 0;
  for (const r of data.reviews.filter((r) => option(r["状态"]) !== "执行失败")) {
    const state = reviewState(r);
    const fid = linkIds(r["KOL"])[0] ?? "";
    if (fid) openByKol.add(fid);
    if (state === "revise") waitingClaude++;
    if (state !== "pending") continue;
    cards.push(reviewCard(r, s, cfg, who(fid), meta(fid), mails.get(fid)));
  }

  // One card per KOL: several unanswered mails from the same person are one conversation to answer.
  const byKol = new Map<string, Row[]>();
  for (const m of data.pendingMail) {
    const fid = linkIds(m["KOL"])[0] ?? "";
    if (fid && openByKol.has(fid)) continue;
    const key = fid || `contact:${m.record_id}`;
    byKol.set(key, [...(byKol.get(key) ?? []), m]);
  }
  for (const [key, ms] of byKol) {
    const fid = key.startsWith("contact:") ? "" : key;
    ms.sort((a, b) => (cellTime(a["日期"], tz) ?? 0) - (cellTime(b["日期"], tz) ?? 0));
    const first = cellTime(ms[0]["日期"], tz);
    const latest = ms[ms.length - 1];
    const w = who(fid);
    const body = mails.get(`msg:${text(latest["Message ID"])}`);
    const when = cellTime(latest["日期"], tz);
    const waited = first ? daysBetween(day(first, tz), todayStr) : 0;
    const ids = ms.map((m) => m.record_id).join(",");
    if (!fid) {
      const from = text(latest["内容"]).replace(/^发件人：/, "") || "陌生发件人";
      cards.push({
        id: `unknown:${ids}`, kind: "unknown", group: "来信", tag: "对不上人",
        headline: `${from} 来信，对不上任何 KOL`, meta: [when ? stamp(when, tz) : "", option(latest["渠道"]) ? `收件 ${option(latest["渠道"])}` : ""].filter(Boolean).join(" · "),
        mail: { label: `${from} 说 · ${text(latest["摘要"])}`, text: body?.text ?? "（正文没读到，可以去邮箱里看）", when: when ? stamp(when, tz) : "" },
        suggest: "说一下这是哪位 KOL 的；跟 KOL 无关就直接归档",
        steps: [{ text: "关联到 KOL 后，这个邮箱记进她的档案，以后的来信会自动对上；这封信会排回这里等你处理" }],
        why: "发件人的邮箱不在任何档案里。可能是她换了邮箱、经纪人代回，也可能是广告或系统邮件。",
      });
      continue;
    }
    const closed = option(data.snapshot.followups.get(fid)?.["阶段"]) === "结案";
    if (closed) {
      const reason = option(data.snapshot.followups.get(fid)?.["结案原因"]);
      cards.push({
        id: `mail:${ids}`, kind: "mail", group: "来信", tag: "之前已结案", who: w,
        headline: `${w?.name ?? "一位 KOL"} 又来信了（之前已结案${reason ? `：${reason}` : ""}）`,
        meta: [meta(fid), option(latest["渠道"]) ? `收件 ${option(latest["渠道"])}` : ""].filter(Boolean).join(" · "),
        mail: { label: `${w?.name ?? "对方"}说 · ${text(latest["摘要"])}`, text: body?.text ?? "（正文没读到，可以去邮箱里看）", when: when ? stamp(when, tz) : "" },
        suggest: "看看她说什么；想继续的话让 Claude 写回信，跟进会重新打开",
        steps: [{ text: "在 Claude 里说「处理来信」，写好的回信会排进这里等你看" }],
        why: "这位之前已经结束跟进了。她主动来信，多半值得再看一眼。",
      });
      continue;
    }
    cards.push({
      id: `mail:${ids}`, kind: "mail", group: "来信", tag: "还没草稿", who: w,
      headline: `${w?.name ?? "一位 KOL"} 来信${ms.length > 1 ? `（${ms.length} 封）` : ""}${waited >= 2 ? `，已经 ${waited} 天没人回了` : ""}`,
      meta: [meta(fid), option(latest["渠道"]) ? `收件 ${option(latest["渠道"])}` : ""].filter(Boolean).join(" · "),
      mail: { label: `${w?.name ?? "对方"}${ms.length > 1 ? "最近一封" : ""}说 · ${text(latest["摘要"])}`, text: body?.text ?? "（正文没读到，可以去邮箱里看）", when: when ? stamp(when, tz) : "" },
      suggest: "让 Claude 写一封回信",
      steps: [{ text: "在 Claude 里说「处理来信」，写好的回信会排进这里等你看" }],
      why: "这封信还没有草稿，多半是今天早上的例行跑完以后才收到的。",
    });
  }

  const at = (c: Card) => GROUP_ORDER.indexOf(c.group);
  cards.sort((a, b) => at(a) - at(b));
  return { cards, waitingClaude };
}

function reviewCard(r: Row, s: Snapshot, cfg: Config, w: Card["who"], meta: string, latest?: MailText): Card {
  const type = option(r["类型"]);
  const fid = linkIds(r["KOL"])[0] ?? "";
  const f = s.followups.get(fid);
  const kind: Card["kind"] = SENDING_TYPES.includes(type) ? "reply" : type === "决定" ? "batch" : type === "模板审批" ? "template" : "todo";
  const group = { reply: "回信", batch: "邀约和决定", template: "模板", todo: "其他" }[kind as "reply" | "batch" | "template" | "todo"];
  const steps: Step[] = [];

  const action = option(r["体验码动作"]);
  if (action === "发码") {
    steps.push({ text: "在 TAFU 后台建一个体验码", params: [
      { label: "码名", value: text(r["体验码"]) || "（用她的账号名）", field: "体验码" },
      { label: "能用几次", value: String(Number(r["体验次数"]) || cfg.trial.maxUses), field: "体验次数" },
      { label: "几天内有效", value: String(Number(r["体验天数"]) || cfg.trial.days), field: "体验天数" },
    ] });
  } else if (action === "延期") {
    steps.push({ text: `把体验码 ${text(r["体验码"]) || text(f?.["体验码"]) || ""} 延长 ${Number(r["体验天数"]) || cfg.trial.days} 天` });
  } else if (action === "开活动码") {
    steps.push({ text: "在 TAFU 后台开合作活动（粉丝通过她的连结购买有折扣，她拿分润）", params: [
      { label: "活动码", value: text(r["活动码"]) || "（用她的账号名）", field: "活动码" },
      { label: "粉丝减几 %", value: String(Number(r["粉丝折扣"]) || cfg.partner.percentOff), field: "粉丝折扣" },
      { label: "市场", value: text(r["销售市场"]) || "（按档案的市场）", field: "销售市场" },
    ] });
  }

  const channel = option(r["发送渠道"]) || option(f?.["联系渠道"]);
  const { subject, body } = splitDraft(text(r["邮件草稿"]));
  const recipient = emailsIn(r["收件人"])[0] ?? "";
  const sends = kind === "reply" && channel !== "不发邮件" && body.trim();
  if (sends) {
    const mb = mailboxFor(cfg, channel);
    steps.push({ text: mb ? `${action ? "成功后，" : ""}从 ${mb.address} 把下面这封信发给 ${recipient || "她"}` : `这封信要从「${channel}」发，系统发不了，要手动发` });
  }
  const after = option(r["发后动作"]);
  if (after) steps.push({ text: `${after === "永不联系" ? "标成永不联系，" : ""}结束跟进（原因：${option(r["结案原因"]) || "没写"}）` });
  if (kind === "batch") steps.push({ text: "记下你同意了。真正发出要在 Claude 里说「发这批邀约」，Claude 会按这个决定分批发" });
  if (kind === "template") steps.push({ text: "记下你同意了。还要到飞书「模板」表把这个模板的状态改成「已批准」，之后才会被用" });

  return {
    id: r.record_id, kind, group, tag: type || "待办", who: w, meta,
    headline: text(r["审核项"]) || w?.name || "一件待你决定的事",
    mail: latest ? { label: `${w?.name ?? "对方"}说`, text: latest.text, when: latest.when } : undefined,
    suggest: text(r["要你定什么"]) || text(r["审核项"]),
    steps, why: text(r["我的判断和建议"]),
    draft: body.trim() ? { label: sends ? `要发给 ${recipient || "她"} 的信` : kind === "template" ? "模板内容" : "草稿", subject, body } : undefined,
  };
}

// --- Reading mail text for the cards and the detail page ---

export interface MailText {
  text: string;
  when: string;
}

/**
 * The text of these inbound mails, read from the mailboxes that received them, 20 at a time. Anything that
 * can't be read is simply left out, so a mailbox the plugin can't open never stops the page from loading.
 */
export async function readBodies(ctx: Ctx, mails: { messageId: string; channel: string }[]): Promise<Map<string, string>> {
  const byMailbox = new Map<string, string[]>();
  for (const m of mails) {
    const mb = mailboxFor(ctx.cfg, m.channel);
    if (mb && m.messageId) byMailbox.set(mb.address, [...(byMailbox.get(mb.address) ?? []), m.messageId]);
  }
  const out = new Map<string, string>();
  for (const [mailbox, ids] of byMailbox) {
    for (let i = 0; i < ids.length; i += 20) {
      const data = await ctx.base.lark.json(["mail", "+messages", "--mailbox", mailbox, "--message-ids", ids.slice(i, i + 20).join(","),
        "--html=false", "--format", "json", "--as", "user"]).catch(() => null);
      for (const m of data?.messages ?? []) out.set(String(m.message_id), ownWords(String(m.body_plain_text ?? "")));
    }
  }
  return out;
}

/** The text of every pending mail, keyed `msg:<Message ID>`, and of each reviewed KOL's latest pending mail, keyed by followup. */
export async function cardMails(ctx: Ctx, data: ConsoleData): Promise<Map<string, MailText>> {
  const tz = ctx.cfg.timezone;
  const bodies = await readBodies(ctx, data.pendingMail.map((m) => ({ messageId: text(m["Message ID"]), channel: option(m["渠道"]) })));
  const out = new Map<string, MailText>();
  const sorted = [...data.pendingMail].sort((a, b) => (cellTime(a["日期"], tz) ?? 0) - (cellTime(b["日期"], tz) ?? 0));
  for (const m of sorted) {
    const id = text(m["Message ID"]);
    const t = bodies.get(id);
    if (!t) continue;
    const mt = { text: t, when: stamp(cellTime(m["日期"], tz) ?? Date.now(), tz) };
    out.set(`msg:${id}`, mt);
    for (const fid of linkIds(m["KOL"])) out.set(fid, mt);
  }
  return out;
}

// --- KOL views ---

export function peopleView(data: ConsoleData, cfg: Config, view: ViewKey, todayStr: string, q = ""): { rows: PeopleRow[]; total: number } {
  const s = data.snapshot;
  const tz = cfg.timezone;
  const decided = new Set(data.reviews.filter((r) => reviewState(r) === "pending" && option(r["状态"]) !== "执行失败").flatMap((r) => linkIds(r["KOL"])));
  const open = [...s.followups.values()].filter((f) => option(f["阶段"]) !== "结案");
  const stage = (f: Row) => option(f["阶段"]);
  const lastContact = (f: Row) => {
    const a = day(f["最近联系日期"], tz);
    const b = day(f["最后来信日期"], tz);
    return a > b ? a : b;
  };
  const muted = (v: string): Cell => ({ v, tone: "muted" });
  const nextUp = (f: Row): Cell => ({ v: text(f["下一步"]) || "" });
  const followupRow = (f: Row, cells: Cell[]): PeopleRow => ({
    id: f.record_id, hasDetail: true, handle: handleOf(s, f), sub: subOf(profileOf(s, f), displayName(s, f)), cells,
  });

  let rows: PeopleRow[] = [];
  let pick: Row[] = [];
  if (view === "wait") {
    pick = open.filter((f) => ["我们", "等你审核"].includes(option(f["当前轮到谁"])));
    const waited = (f: Row) => (day(f["最后来信日期"], tz) ? daysBetween(day(f["最后来信日期"], tz), todayStr) : 0);
    pick.sort((a, b) => waited(b) - waited(a));
    rows = pick.map((f) => {
      const w = waited(f);
      return followupRow(f, [
        { v: situationOf(f, cfg, todayStr) },
        { v: w <= 0 ? "今天" : `${w} 天`, tone: w >= 3 ? "warn" : undefined },
        decided.has(f.record_id) ? { v: "等你决定", badge: true, tone: "warn", link: "decide" } : { v: "" },
        { v: ahead(day(f["下次跟进日期"], tz), todayStr) },
      ]);
    });
  } else if (view === "noreply") {
    pick = open.filter((f) => stage(f) === "已邀约");
    pick.sort((a, b) => day(a["下次跟进日期"], tz).localeCompare(day(b["下次跟进日期"], tz)));
    rows = pick.map((f) => followupRow(f, [
      muted(shortDay(day(f["首次邀约日期"], tz))), { v: ahead(day(f["下次跟进日期"], tz), todayStr) },
      muted(option(f["邀约批次"])), muted(option(f["联系渠道"])),
    ]));
  } else if (view === "trial") {
    pick = open.filter((f) => stage(f) === "体验中");
    pick.sort((a, b) => (day(a["体验码到期"], tz) || "9").localeCompare(day(b["体验码到期"], tz) || "9"));
    rows = pick.map((f) => {
      const used = Number(f["体验码已用"]) || 0;
      const max = Number(f["体验码上限"]) || 0;
      const exp = day(f["体验码到期"], tz);
      const left = exp ? daysBetween(todayStr, exp) : 99;
      return followupRow(f, [
        { v: max ? `${used} / ${max}${used === 0 ? " · 还没用" : used >= max ? " · 用完了" : ""}` : "（没同步到）", tone: max && used === 0 ? "warn" : undefined },
        { v: exp ? (left < 0 ? `已过期（${shortDay(exp)}）` : ahead(exp, todayStr)) : "", tone: left <= 2 ? "warn" : undefined },
        muted(ago(lastContact(f), todayStr)), nextUp(f),
      ]);
    });
  } else if (view === "deal") {
    pick = open.filter((f) => ["已看报告", "合作中"].includes(stage(f)));
    rows = pick.map((f) => {
      const last = lastContact(f);
      return followupRow(f, [
        { v: situationOf(f, cfg, todayStr) }, text(f["活动码"]) ? { v: text(f["活动码"]) } : muted("还没开"),
        { v: ago(last, todayStr), tone: last && daysBetween(last, todayStr) >= 5 ? "warn" : "muted" }, nextUp(f),
      ]);
    });
  } else if (view === "post") {
    pick = open.filter((f) => stage(f) === "已约发布");
    pick.sort((a, b) => (day(a["约定发布日期"], tz) || "9").localeCompare(day(b["约定发布日期"], tz) || "9"));
    rows = pick.map((f) => {
      const due = day(f["约定发布日期"], tz);
      const late = due ? daysBetween(due, todayStr) : 0;
      const when: Cell = !due ? muted("没填日期") : late >= OVERDUE_GRACE_DAYS ? { v: `已过 ${late} 天（${shortDay(due)}），还没找到帖子`, tone: "bad", badge: true }
        : { v: late >= 0 ? `${shortDay(due)}（今天前后）` : ahead(due, todayStr), tone: late >= -3 ? "warn" : undefined };
      return followupRow(f, [when, text(f["活动码"]) ? { v: text(f["活动码"]) } : muted("还没开"), nextUp(f)]);
    });
  } else if (view === "posted") {
    const byKol = new Map<string, Row[]>();
    for (const p of data.posts) for (const id of linkIds(p["KOL"])) byKol.set(id, [...(byKol.get(id) ?? []), p]);
    pick = [...s.followups.values()].filter((f) => stage(f) === "已发布" || byKol.has(f.record_id));
    const latestPost = (f: Row) => (byKol.get(f.record_id) ?? []).sort((a, b) => (cellTime(b["发布日期"], tz) ?? 0) - (cellTime(a["发布日期"], tz) ?? 0))[0];
    pick.sort((a, b) => (cellTime(latestPost(b)?.["发布日期"], tz) ?? 0) - (cellTime(latestPost(a)?.["发布日期"], tz) ?? 0));
    rows = pick.map((f) => {
      const p = latestPost(f);
      const n = byKol.get(f.record_id)?.length ?? 0;
      const views = p ? [30, 7, 3, 1].map((d) => ({ d, v: Number(p[`第${d}天播放`]) })).find((x) => x.v > 0) : undefined;
      return followupRow(f, [
        p ? { v: `${text(p["内容标题"]) || option(p["形式"]) || "帖子"}${n > 1 ? ` · 共 ${n} 条` : ""}`, link: text(p["内容链接"]) || undefined } : muted("没记链接"),
        muted(p ? shortDay(day(p["发布日期"], tz)) : ""),
        views ? { v: `${views.v.toLocaleString("en-US")}（第 ${views.d} 天）` } : muted("还没数据"),
        text(f["活动码"]) ? { v: text(f["活动码"]) } : muted(""),
      ]);
    });
  } else if (view === "pool") {
    const profiles = [...s.profiles.values()].filter((p) => !linkIds(p["跟进记录"]).length && profileEmails(p).length && option(p["联系许可"]) !== "永不联系");
    const term = q.trim().toLowerCase();
    const hit = (p: Row) => !term || [text(p["账号"]), text(p["账号名称"]), text(p["称呼"]), ...profileEmails(p)].some((x) => x.toLowerCase().includes(term));
    const list = profiles.filter(hit);
    return {
      total: list.length,
      rows: list.slice(0, 300).map((p) => ({
        id: p.record_id, hasDetail: false,
        handle: text(p["账号"]) ? `@${text(p["账号"]).replace(/^@/, "")}` : text(p["账号名称"]),
        sub: subOf(p, text(p["账号名称"])),
        cells: [{ v: [option(p["内容类型"])].filter(Boolean).join(" · ") || "（还没补好资料）", tone: option(p["内容类型"]) ? undefined : "muted" },
          { v: fans(p["粉丝数"]) }, muted(option(p["市场"])), muted(option(p["入库批次"]))],
      })),
    };
  } else {
    pick = open;
    pick.sort((a, b) => lastContact(b).localeCompare(lastContact(a)));
    rows = pick.map((f) => followupRow(f, [{ v: situationOf(f, cfg, todayStr) }, { v: stage(f), badge: true }, { v: ahead(day(f["下次跟进日期"], tz), todayStr) }]));
  }

  const term = q.trim().toLowerCase();
  if (term) {
    rows = rows.filter((r) => {
      const f = s.followups.get(r.id);
      return [r.handle, r.sub, ...(f ? profileEmails(profileOf(s, f)) : [])].some((x) => x.toLowerCase().includes(term));
    });
  }
  return { rows: rows.slice(0, 500), total: rows.length };
}

export function viewCounts(data: ConsoleData, cfg: Config, todayStr: string): Record<ViewKey, number> {
  const out = {} as Record<ViewKey, number>;
  for (const k of Object.keys(VIEWS) as ViewKey[]) out[k] = peopleView(data, cfg, k, todayStr).total;
  return out;
}

// --- One KOL ---

export interface Bubble {
  side: "them" | "us" | "event";
  who: string;
  when: string;
  text: string;
  /** Only a summary was kept (old or hand-written records); the mail itself is in the mailbox. */
  summaryOnly?: boolean;
  /** An archive's full text, shown when opened. */
  full?: string;
}

/** Summaries the plugin writes for things that aren't a conversation: an auto-reply, a bounce. */
const EVENT_MARKS = /^\[(自动回复|退信)\]/;

export async function personDetail(ctx: Ctx, data: ConsoleData, fid: string, all = false) {
  const { base, cfg } = ctx;
  const t = cfg.tables;
  const tz = cfg.timezone;
  const todayStr = today(cfg);
  const s = data.snapshot;
  const f = s.followups.get(fid);
  if (!f) return null;
  const p = profileOf(s, f);
  const [links] = await base.get(t.followups, [fid], ["接触记录", "发布内容"]);
  const contacts = (await base.get(t.contacts, linkIds(links?.["接触记录"]), ["方向", "摘要", "内容", "日期", "渠道", "Message ID", "待处理"]))
    .sort((a, b) => (cellTime(a["日期"], tz) ?? 0) - (cellTime(b["日期"], tz) ?? 0));
  const posts = await base.get(t.posts, linkIds(links?.["发布内容"]), POST_FIELDS).catch(() => [] as Row[]);

  // Inbound mails are filed without their text; read the latest few from the mailbox.
  const recent = all ? contacts : contacts.slice(-12);
  const unread = recent.filter((c) => option(c["方向"]) === "收到" && !text(c["内容"]) && text(c["Message ID"]) && !EVENT_MARKS.test(text(c["摘要"])));
  const bodies = await readBodies(ctx, unread.map((c) => ({ messageId: text(c["Message ID"]), channel: option(c["渠道"]) })));
  const name = text(p?.["称呼"]) || displayName(s, f);
  const bubbles: Bubble[] = recent.map((c) => {
    const dir = option(c["方向"]);
    const when = stamp(cellTime(c["日期"], tz) ?? 0, tz);
    const summary = text(c["摘要"]);
    const content = text(c["内容"]);
    if (dir === "存档") return { side: "event", who: "", when, text: summary || "存档", ...(content ? { full: content } : {}) };
    if (EVENT_MARKS.test(summary)) return { side: "event", who: "", when, text: summary };
    const mark = summary.match(/^\[([^\]]+)\]/)?.[1];
    if (dir === "发出") {
      return { side: "us", who: `我们 · ${option(c["渠道"])}${content ? "" : ` · ${summary}`}`.slice(0, 120), when, text: content || summary, summaryOnly: !content };
    }
    const body = bodies.get(text(c["Message ID"])) || content;
    return { side: "them", who: `${name}${mark ? ` · ${mark}` : ""}`, when, text: body || summary, summaryOnly: !body };
  });

  const pending = data.reviews.filter((r) => linkIds(r["KOL"]).includes(fid) && reviewState(r) === "pending" && option(r["状态"]) !== "执行失败");
  const emails = profileEmails(p).map((e) => ({ address: e, blocked: s.doNotContact.has(e) }));
  return {
    id: fid,
    handle: handleOf(s, f),
    name,
    sub: subOf(p, displayName(s, f)),
    stage: option(f["阶段"]),
    stageStep: STAGE_STEP[option(f["阶段"])] ?? -1,
    stages: STAGES,
    situation: situationOf(f, cfg, todayStr),
    lastContact: ago(day(f["最近联系日期"], tz) > day(f["最后来信日期"], tz) ? day(f["最近联系日期"], tz) : day(f["最后来信日期"], tz), todayStr),
    turn: option(f["当前轮到谁"]),
    next: text(f["下一步"]),
    nextDate: ahead(day(f["下次跟进日期"], tz), todayStr),
    nextDateIso: day(f["下次跟进日期"], tz),
    pending: pending.map((r) => ({ id: r.record_id, title: text(r["审核项"]), ask: text(r["要你定什么"]) })),
    bubbles,
    olderCount: Math.max(0, contacts.length - recent.length),
    showingAll: all,
    trial: text(f["体验码"]) ? { code: text(f["体验码"]), used: Number(f["体验码已用"]) || 0, max: Number(f["体验码上限"]) || 0, expires: shortDay(day(f["体验码到期"], tz)) } : null,
    partner: text(f["活动码"]) ? { code: text(f["活动码"]), link: text(f["专属连结"]), ledger: text(f["账本连结"]) } : null,
    posts: posts.map((x) => ({
      title: text(x["内容标题"]) || option(x["形式"]) || "帖子", link: text(x["内容链接"]), platform: option(x["平台"]), date: shortDay(day(x["发布日期"], tz)),
      metrics: [1, 3, 7, 30].map((d) => ({ day: d, views: Number(x[`第${d}天播放`]) || null })),
    })),
    info: [
      ["怎么称呼", text(p?.["称呼"])], ["主页", text(p?.["主页链接"])], ["市场", option(p?.["市场"])], ["内容类型", option(p?.["内容类型"])],
      ["邀约批次", option(f["邀约批次"])], ["用哪个邮箱联系", option(f["联系渠道"])], ["重要程度", option(f["级别"])],
    ].filter(([, v]) => v).map(([k, v]) => ({ k, v })),
    emails,
    doNotContact: option(p?.["联系许可"]) === "永不联系",
  };
}

// --- What the background did ---

export async function activityLog(ctx: Ctx) {
  const { base, cfg } = ctx;
  const t = cfg.tables;
  const tz = cfg.timezone;
  const since = addDays(today(cfg), -3);
  const [runs, ops] = await Promise.all([
    base.records(t.runs, { filter: { logic: "and", conditions: [onOrAfter("开始时间", since)] },
      fields: ["运行", "方式", "结果", "开始时间", "结束时间", "处理来信", "发出邮件", "新增待审", "问题与备注"] }),
    base.records(t.oplog, { filter: { logic: "and", conditions: [onOrAfter("时间", since)] },
      fields: ["时间", "类型", "结果", "操作", "说明", "所属运行"] }),
  ]);
  const runById = new Map(runs.map((r) => [r.record_id, r]));
  const time = (r: Row, f: string) => cellTime(r[f], tz) ?? 0;
  return {
    runs: runs.sort((a, b) => time(b, "开始时间") - time(a, "开始时间")).slice(0, 30).map((r) => ({
      title: text(r["运行"]), how: option(r["方式"]), result: option(r["结果"]),
      start: stamp(time(r, "开始时间"), tz), end: time(r, "结束时间") ? stamp(time(r, "结束时间"), tz).slice(11) : "",
      counts: [["处理来信", r["处理来信"]], ["发出邮件", r["发出邮件"]], ["新增待审", r["新增待审"]]].filter(([, n]) => Number(n) > 0).map(([k, n]) => `${k} ${n}`).join(" · "),
      notes: text(r["问题与备注"]),
    })),
    ops: ops.sort((a, b) => time(b, "时间") - time(a, "时间")).slice(0, 300).map((o) => {
      const run = runById.get(linkIds(o["所属运行"])[0] ?? "");
      return {
        when: stamp(time(o, "时间"), tz), type: option(o["类型"]), result: option(o["结果"]), what: text(o["操作"]),
        note: text(o["说明"]).split("\n").filter((l) => !l.startsWith("执行人：")).join(" "),
        source: run ? `${option(run["方式"]) === "定时任务" ? "每天例行" : "在 Claude 里跑的"}` : "",
        by: (text(o["说明"]).match(/执行人：(.+)/) ?? [])[1] ?? "",
      };
    }),
  };
}

/** The top bar: anything that failed lately, and what is approved or running right now. */
export async function runStatus(ctx: Ctx, data: ConsoleData) {
  const { base, cfg } = ctx;
  const tz = cfg.timezone;
  const running = await base.records(cfg.tables.runs, { filter: { logic: "and", conditions: [["结果", "intersects", ["进行中"]]] }, fields: ["运行", "开始时间", "结果"] });
  const fresh = running.filter((r) => (cellTime(r["开始时间"], tz) ?? 0) > Date.now() - 2 * 3600_000);
  const s = data.snapshot;
  const name = (r: Row) => {
    const f = s.followups.get(linkIds(r["KOL"])[0] ?? "");
    return f ? displayName(s, f) : "";
  };
  const failed = data.reviews.filter((r) => option(r["状态"]) === "执行失败");
  // Only approvals the executor will carry out are waiting on it; an approved decision or template is simply done.
  const queued = data.reviews.filter((r) => option(r["状态"]) !== "执行失败" && reviewState(r) === "approved" && executesOnApproval(r));
  return {
    failed: failed.length,
    running: fresh.length + queued.length,
    items: [
      ...failed.map((r) => ({ st: "没做成", text: `${name(r)}：${text(r["审核项"])}`, note: text(r["执行结果"]).slice(0, 120), person: linkIds(r["KOL"])[0] ?? "" })),
      ...fresh.map((r) => ({ st: "进行中", text: text(r["运行"]), note: `${stamp(cellTime(r["开始时间"], tz) ?? 0, tz).slice(11)} 开始`, person: "" })),
      ...queued.map((r) => ({ st: "等发出", text: `${name(r)}：${text(r["审核项"])}`, note: "飞书里已批准，等下一次「发出已批准的信」", person: linkIds(r["KOL"])[0] ?? "" })),
    ],
  };
}

// --- What happened while the user was away ---

/**
 * Things worth knowing that need nothing from the user: mail sent and received, posts found, codes used, people
 * found. Read from 操作日志 and 发布内容 since `since` (the last time this browser looked).
 */
export async function newsSince(ctx: Ctx, data: ConsoleData, since: number) {
  const { base, cfg } = ctx;
  const tz = cfg.timezone;
  const sinceDay = day(since, tz);
  const ops = await base.records(cfg.tables.oplog, { filter: { logic: "and", conditions: [onOrAfter("时间", sinceDay)] }, fields: ["时间", "类型", "结果", "操作", "KOL"] });
  const at = (r: Row, f: string) => cellTime(r[f], tz) ?? 0;
  const fresh = ops.filter((o) => at(o, "时间") > since).sort((a, b) => at(b, "时间") - at(a, "时间"));
  const posts = data.posts.filter((p) => (cellTime(p["发布日期"], tz) ?? 0) > since);
  const count = (re: RegExp) => fresh.filter((o) => re.test(text(o["操作"]))).length;
  const chips = [
    { label: "新发布", n: posts.length, tone: "ok" },
    { label: "发出的信", n: fresh.filter((o) => option(o["类型"]) === "发出邮件" && option(o["结果"]) === "完成").length, tone: "" },
    { label: "收到来信", n: count(/^收到来信/), tone: "" },
    { label: "催信", n: count(/^催信|催信 \d/), tone: "" },
    { label: "找到新人", n: fresh.filter((o) => /^找人入库/.test(text(o["操作"]))).reduce((n, o) => n + (Number(text(o["操作"]).match(/(\d+) 人/)?.[1]) || 0), 0), tone: "ok" },
  ].filter((c) => c.n > 0);
  const name = (r: Row) => {
    const f = data.snapshot.followups.get(linkIds(r["KOL"])[0] ?? "");
    return f ? displayName(data.snapshot, f) : "";
  };
  const items = [
    ...posts.map((p) => ({ when: stamp(at(p, "发布日期"), tz), text: `${name(p) || "一位 KOL"} 发了${option(p["平台"]) ? ` ${option(p["平台"])} ` : ""}「${text(p["内容标题"]) || "新帖子"}」`, person: linkIds(p["KOL"])[0] ?? "", link: text(p["内容链接"]) })),
    ...fresh.slice(0, 40).map((o) => ({ when: stamp(at(o, "时间"), tz), text: text(o["操作"]) + (option(o["结果"]) && option(o["结果"]) !== "完成" ? `（${option(o["结果"])}）` : ""), person: linkIds(o["KOL"])[0] ?? "", link: "" })),
  ].sort((a, b) => b.when.localeCompare(a.when)).slice(0, 40);
  return { since: stamp(since, tz), chips, items };
}

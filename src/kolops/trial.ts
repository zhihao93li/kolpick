import { option, text } from "./base.js";
import { createTrialCodeRemote, extendTrialCodeRemote, TrialCodeRefused } from "./codes.js";
import type { Config } from "./config.js";
import type { Ctx } from "./ctx.js";
import type { Row } from "./lark.js";
import { stamp, today } from "./ops.js";
import { listProjects } from "./projects.js";
import { partnerPlan, type PartnerPlan } from "./partner.js";
import { TRIAL_ACTIONS } from "./schema.js";

/** The project API's own limits (tafu-nodejs lib/kol/trial-codes.ts); checked here too so a bad item fails before anything is sent. */
const MAX_USES = 10;
const MAX_DAYS = 60;
const CODE_RULE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

export interface TrialPlan {
  action: "发码" | "延期";
  code: string;
  maxUses: number;
  days: number;
}

/** A code name from the KOL's account, the way codes have been named by hand (linlincouple, yun_san1208). */
export function suggestTrialCode(profile: Row | undefined): string {
  const raw = text(profile?.["账号"]) || text(profile?.["账号名称"]);
  const name = raw.replace(/^@+/, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+/, "").slice(0, 64);
  return CODE_RULE.test(name) ? name : "";
}

/**
 * What a 审核队列 item asks for: null when it has no 体验码动作, a reason string when what it asks can't be done.
 * 发码 defaults the name to the KOL's account; 延期 defaults to the followup's current 体验码.
 */
export function trialPlan(cfg: Config, review: Row, followup: Row | undefined, profile: Row | undefined): TrialPlan | PartnerPlan | string | null {
  const action = option(review["体验码动作"]) as (typeof TRIAL_ACTIONS)[number];
  if (!action) return null;
  if (!TRIAL_ACTIONS.includes(action)) return `体验码动作「${action}」看不懂，只能是 ${TRIAL_ACTIONS.join("、")}`;
  if (action === "开活动码") {
    const name = text(followup?.["账号名称"]) || text(profile?.["账号名称"]) || text(profile?.["账号"]);
    return partnerPlan(cfg, review, followup, profile, suggestTrialCode(profile), name);
  }
  const code = text(review["体验码"]) || (action === "延期" ? text(followup?.["体验码"]) : suggestTrialCode(profile));
  if (!CODE_RULE.test(code)) return code ? `体验码「${code}」只能用字母、数字、_ 和 -，2 到 64 个字` : "没写体验码，也没法从账号推出一个";
  const maxUses = Number(review["体验次数"]) || cfg.trial.maxUses;
  const days = Number(review["体验天数"]) || cfg.trial.days;
  if (maxUses < 1 || maxUses > MAX_USES) return `体验次数 ${maxUses} 超出 1–${MAX_USES}`;
  if (days < 1 || days > MAX_DAYS) return `体验天数 ${days} 超出 1–${MAX_DAYS}`;
  return { action, code, maxUses, days };
}

/** 「11 月 8 日」 in the base's zone, for notes in the table. */
export function dateWords(iso: string, tz: string): string {
  const d = stamp(Date.parse(iso), tz);
  return `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`;
}

/** 「2026 年 11 月 8 日 10:23」 for the mail: the code stops working at that minute, as the hand-written mails said. */
export function expiryWords(iso: string, tz: string): string {
  const d = stamp(Date.parse(iso), tz);
  return `${d.slice(0, 4)} 年 ${dateWords(iso, tz)} ${d.slice(11, 16)}`;
}

const PLACEHOLDERS = (code: string, uses: number, until: string): Record<string, string> => ({
  "{體驗碼}": code, "{体验码}": code, "{次數}": String(uses), "{次数}": String(uses), "{到期日}": until,
});

/** The draft must name what it promises: a new code needs {體驗碼}, an extension needs {到期日}. */
export function missingPlaceholder(plan: TrialPlan | PartnerPlan, draft: string): string {
  if (plan.action === "开活动码") return /\{(專屬連結|专属连结)\}/.test(draft) ? "" : "草稿里没有 {專屬連結}，活动开好了连结也填不进信里";
  if (plan.action === "发码" && !/\{(體驗碼|体验码)\}/.test(draft)) return "草稿里没有 {體驗碼}，码建好了也填不进信里";
  if (plan.action === "延期" && !draft.includes("{到期日}")) return "草稿里没有 {到期日}，延期后的日期填不进信里";
  return "";
}

export function fillTrial(s: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((acc, [k, v]) => acc.split(k).join(v), s);
}

interface Prepared {
  code: string;
  maxUses: number;
  used: number;
  expiresAt: string;
}

/**
 * The step `deliver` runs right before sending: create or extend the code through the project's API, then hand
 * back the values for the draft's placeholders and the followup update. Its result is kept in the local journal, so a retry
 * after a failed send reuses it — extending twice would give the KOL more days than anyone approved.
 */
export function prepareTrial(ctx: Ctx, plan: TrialPlan, review: Row, kolName: string, followupId: string) {
  return async () => {
    const key = `trial:${review.record_id}`;
    let done = ctx.journal.get(key)?.data as Prepared | undefined;
    if (!done) {
      const project = listProjects().find((p) => p.name === ctx.cfg.project);
      if (!ctx.cfg.dataApi) throw new TrialCodeRefused("NO_API", "「设置」里没填业务数据接口，没法建体验码");
      if (!project?.trialKey) throw new TrialCodeRefused("NO_KEY", `这台电脑没有项目「${ctx.cfg.project}」的体验码写密钥，请运行 kol project set-trial-key`);
      const operator = ctx.me.name || ctx.me.id;
      const r = plan.action === "发码"
        ? await createTrialCodeRemote(ctx.cfg.dataApi, project.trialKey, { code: plan.code, maxUses: plan.maxUses, days: plan.days, kolName, followupId, operator })
        : await extendTrialCodeRemote(ctx.cfg.dataApi, project.trialKey, plan.code, { days: plan.days, operator });
      done = { code: r.code.code, maxUses: r.code.maxUses ?? plan.maxUses, used: r.code.used ?? 0, expiresAt: String(r.code.expiresAt) };
      ctx.journal.mark(key, "prepared", undefined, done);
    }
    const until = dateWords(done.expiresAt, ctx.cfg.timezone);
    const values = PLACEHOLDERS(done.code, done.maxUses, expiryWords(done.expiresAt, ctx.cfg.timezone));
    const day = today(ctx.cfg);
    const followup = plan.action === "发码"
      ? { 阶段: ["体验中"], 体验码: done.code, 体验码上限: done.maxUses, 体验码已用: done.used, 体验码到期: stamp(Date.parse(done.expiresAt), ctx.cfg.timezone),
          下一步: `${day} 发了体验码 ${done.code}（${done.maxUses} 次，${until}到期）` }
      : { 体验码到期: stamp(Date.parse(done.expiresAt), ctx.cfg.timezone), 下一步: `${day} 体验码 ${done.code} 延期到 ${until}` };
    return { values, followup };
  };
}

export function trialNote(plan: TrialPlan): string {
  return plan.action === "发码" ? `发码 ${plan.code}，${plan.maxUses} 次，${plan.days} 天` : `体验码 ${plan.code} 延期 ${plan.days} 天`;
}

export type { Config };

import { emailsIn, option, text } from "./base.js";
import { TrialCodeRefused, writeOnce, type CodeInfo } from "./codes.js";
import type { Config } from "./config.js";
import type { Ctx } from "./ctx.js";
import type { Row } from "./lark.js";
import { today } from "./ops.js";
import { listProjects } from "./projects.js";

const CODE_RULE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

export interface PartnerPlan {
  action: "开活动码";
  code: string;
  partnerName: string;
  contact: string;
  market: string;
  percentOff: number;
}

/** 「台湾=TW，大陆=CN，其他=GLOBAL」: profile 市场 → the project's sales market. 其他 catches the rest. */
export function marketFor(cfg: Config, profileMarket: string): string {
  const pairs = cfg.partner.markets;
  return pairs.find(([from]) => from === profileMarket)?.[1] ?? pairs.find(([from]) => from === "其他")?.[1] ?? "";
}

/**
 * What a 开活动码 item asks for, or a reason it can't be done. The code name defaults to the KOL's account, the
 * page name to the KOL's name, the market to the one their profile's 市场 maps to, the discount to 设置.
 */
export function partnerPlan(cfg: Config, review: Row, followup: Row | undefined, profile: Row | undefined, suggested: string, name: string): PartnerPlan | string {
  const existing = text(followup?.["活动码"]);
  if (existing) return `这位 KOL 已经有活动码「${existing}」，一位 KOL 只开一个`;
  const code = text(review["活动码"]) || suggested;
  if (!CODE_RULE.test(code)) return code ? `活动码「${code}」只能用字母、数字、_ 和 -，2 到 64 个字` : "没写活动码，也没法从账号推出一个";
  const market = text(review["销售市场"]) || marketFor(cfg, option(profile?.["市场"]));
  if (!market) return `档案的市场「${option(profile?.["市场"]) || "空"}」在「设置」的活动码市场里没有对应，请在审核项填销售市场`;
  const percentOff = Number(review["粉丝折扣"]) || cfg.partner.percentOff;
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90) return `粉丝折扣 ${percentOff}% 不对，要 1–90 的整数`;
  return {
    action: "开活动码", code, market, percentOff,
    partnerName: text(review["合作页名称"]) || name,
    contact: emailsIn(review["收件人"])[0] ?? "",
  };
}

/** 15 → 「85 折」, the way the mails say it. */
export function discountWords(percentOff: number): string {
  const rest = 100 - percentOff;
  return `${rest % 10 ? rest : rest / 10} 折`;
}

export function partnerValues(code: string, refLink: string, ledgerLink: string, percentOff: number): Record<string, string> {
  return {
    "{活動碼}": code, "{活动码}": code, "{專屬連結}": refLink, "{专属连结}": refLink, "{帳本連結}": ledgerLink, "{账本连结}": ledgerLink,
    "{粉絲折扣}": discountWords(percentOff), "{粉丝折扣}": discountWords(percentOff),
  };
}

export interface PartnerCode extends CodeInfo {
  refLink: string;
  ledgerLink: string;
  percentOff?: number;
}

/** Opens a partner campaign; asking again for the same followup returns the one opened the first time. */
export async function createPartnerCodeRemote(url: string, key: string, body: Omit<PartnerPlan, "action"> & { followupId: string; operator: string }, fetchImpl: typeof fetch = fetch): Promise<{ created?: boolean; code: PartnerCode }> {
  const res = await fetchImpl(`${url.replace(/\/+$/, "")}/partner-codes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new TrialCodeRefused("UNAUTHORIZED", "业务数据接口拒绝了活动码写密钥（401）。请向项目负责人确认后用 kol project set-partner-key 重新保存");
  if (res.status === 503) throw new TrialCodeRefused("NOT_CONFIGURED", "项目后台还没有开通开活动码（503）");
  // A server error may come after the campaign was opened: not a refusal (I-5).
  if (res.status >= 500) throw new Error(`业务数据接口出错（${res.status}）`);
  if (!res.ok) throw new TrialCodeRefused(String(data.error ?? res.status), String(data.message ?? `业务数据接口出错（${res.status}）`));
  return data;
}

/**
 * Like prepareTrial: opens the campaign right before the mail goes out, keeps the result in the journal so a
 * retry reuses it, and hands back the links for the draft and the followup update.
 */
export function preparePartner(ctx: Ctx, plan: PartnerPlan, review: Row, followupId: string) {
  return async () => {
    const key = `partner:${review.record_id}`;
    let done = ctx.journal.get(key)?.data as { code: string; refLink: string; ledgerLink: string; percentOff: number } | undefined;
    if (!done) {
      const project = listProjects().find((p) => p.name === ctx.cfg.project);
      if (!ctx.cfg.dataApi) throw new TrialCodeRefused("NO_API", "「设置」里没填业务数据接口，没法开活动码");
      if (!project?.partnerKey) throw new TrialCodeRefused("NO_KEY", `这台电脑没有项目「${ctx.cfg.project}」的活动码写密钥，请运行 kol project set-partner-key`);
      const { action, ...body } = plan;
      const r = await writeOnce(ctx, key, `开活动码 ${plan.code}`,
        () => createPartnerCodeRemote(ctx.cfg.dataApi, project.partnerKey!, { ...body, followupId, operator: ctx.me.name || ctx.me.id }), true);
      if (!r.code?.refLink) throw new TrialCodeRefused("NO_LINK", "活动码开好了，但接口没给专属连结，这封信先不发；请到项目后台看这个活动");
      done = { code: r.code.code, refLink: r.code.refLink, ledgerLink: r.code.ledgerLink ?? "", percentOff: r.code.percentOff ?? plan.percentOff };
      ctx.journal.mark(key, "prepared", undefined, done);
    }
    const values = partnerValues(done.code, done.refLink, done.ledgerLink, done.percentOff);
    const followup = {
      阶段: ["合作中"], 活动码: done.code, 专属连结: done.refLink, 账本连结: done.ledgerLink,
      下一步: `${today(ctx.cfg)} 开了活动码 ${done.code}（粉丝 ${discountWords(done.percentOff)}），等对方发布`,
    };
    return { values, followup };
  };
}

export function partnerNote(plan: PartnerPlan): string {
  return `开活动码 ${plan.code}，${plan.market}，粉丝 ${discountWords(plan.percentOff)}`;
}

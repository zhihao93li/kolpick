/**
 * A project's rules, stored as projects.settings and edited in the console. Missing keys fall back to DEFAULTS.
 * Secrets (API keys, database URLs) never go here; they stay in the local config (config.ts).
 */
export interface Settings {
  timezone: string;
  /** People the project contacts a day (invites + follow-ups + replies to new people). */
  dailyLimit: number;
  /** Sends per minute across all mailboxes. */
  perMinute: number;
  /** Pause a mailbox when its bounce rate over bounceWindowDays reaches this percent… */
  bounceRate: number;
  bounceWindowDays: number;
  /** …once it has sent at least this many. */
  bounceMinSent: number;
  followup1Days: number;
  followup2Days: number;
  /** Only people first invited on or after this day get follow-ups (YYYY-MM-DD; empty = everyone). */
  followupFrom: string;
  /** Days after the last follow-up with no answer before proposing to close. */
  closeDays: number;
  /** No auto follow-up for these levels / demands / channels. */
  noFollowupLevels: string[];
  noFollowupDemands: string[];
  noFollowupChannels: string[];
  /** Don't invite an address another project contacted within this many days. */
  cooldownDays: number;
  trialUses: number;
  trialDays: number;
  trialUnusedDays: number;
  trialExpiryDays: number;
  partnerDiscount: number;
  /** Market → TAFU partner market code, e.g. {"台湾": "TW"}; others go to partnerMarketDefault. */
  partnerMarkets: Record<string, string>;
  partnerMarketDefault: string;
  /** Word the post finder looks for (brand name, link). */
  postKeyword: string;
  postLookbackDays: number;
  findCountry: string;
  findLanguage: string;
  /** kol-data API root (docs/data-api.md); keys are local. */
  dataApiUrl: string;
  /** Feishu group bot for daily notes; empty = none. */
  feishuWebhook: string;
}

export const DEFAULTS: Settings = {
  timezone: "+08:00",
  dailyLimit: 450,
  perMinute: 30,
  bounceRate: 6,
  bounceWindowDays: 14,
  bounceMinSent: 20,
  followup1Days: 5,
  followup2Days: 7,
  closeDays: 7,
  followupFrom: "",
  noFollowupLevels: [],
  noFollowupDemands: [],
  noFollowupChannels: [],
  cooldownDays: 90,
  trialUses: 3,
  trialDays: 14,
  trialUnusedDays: 5,
  trialExpiryDays: 2,
  partnerDiscount: 15,
  partnerMarkets: {},
  partnerMarketDefault: "GLOBAL",
  postKeyword: "",
  postLookbackDays: 14,
  findCountry: "",
  findLanguage: "",
  dataApiUrl: "",
  feishuWebhook: "",
};

/** Labels the console and the agent see. */
export const LABELS: Record<keyof Settings, string> = {
  timezone: "时区",
  dailyLimit: "项目每天联系人数上限",
  perMinute: "每分钟发信上限",
  bounceRate: "退信率暂停线（%）",
  bounceWindowDays: "退信率统计天数",
  bounceMinSent: "至少发过几封才算退信率",
  followup1Days: "第一次催信天数",
  followup2Days: "第二次催信天数",
  closeDays: "无回应结案天数",
  followupFrom: "从哪天邀约的人开始催信",
  noFollowupLevels: "不催的级别",
  noFollowupDemands: "不催的对方要求",
  noFollowupChannels: "不催的渠道",
  cooldownDays: "跨项目冷却天数",
  trialUses: "体验码默认次数",
  trialDays: "体验码默认天数",
  trialUnusedDays: "体验码没用提醒天数",
  trialExpiryDays: "体验码到期前几天提醒",
  partnerDiscount: "活动码粉丝折扣（%）",
  partnerMarkets: "市场对应的活动码市场",
  partnerMarketDefault: "活动码默认市场",
  postKeyword: "找帖子的关键词",
  postLookbackDays: "找帖子回看天数",
  findCountry: "找人国家",
  findLanguage: "找人语言",
  dataApiUrl: "业务数据接口",
  feishuWebhook: "飞书群机器人",
};

export function withDefaults(stored: Partial<Settings> | null | undefined): Settings {
  return { ...DEFAULTS, ...(stored ?? {}) };
}

/** Checks one edited value; returns the cleaned value or throws a message for the console. */
export function cleanSetting<K extends keyof Settings>(key: K, value: unknown): Settings[K] {
  if (!(key in DEFAULTS)) throw new Error(`没有这个设置：${String(key)}`);
  const def = DEFAULTS[key];
  if (typeof def === "number") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${LABELS[key]}要填不小于 0 的数字`);
    return n as Settings[K];
  }
  if (Array.isArray(def)) {
    const list = Array.isArray(value) ? value : String(value ?? "").split(/[、,，\n]/);
    return list.map((s) => String(s).trim()).filter(Boolean) as Settings[K];
  }
  if (typeof def === "object") {
    if (typeof value === "string") {
      const out: Record<string, string> = {};
      for (const part of value.split(/[、,，\n]/)) {
        const [k, v] = part.split("=").map((s) => s.trim());
        if (k && v) out[k] = v;
      }
      return out as Settings[K];
    }
    return (value ?? {}) as Settings[K];
  }
  const text = String(value ?? "").trim();
  if (key === "timezone" && !/^[+-]\d{2}:\d{2}$/.test(text)) throw new Error("时区要写成 +08:00 这样");
  if (key === "followupFrom" && text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("日期要写成 2026-10-22 这样");
  return text as Settings[K];
}

import { PLATFORMS, type Platform } from "../discovery/models.js";
import { DEFAULT_PARAMS, type DiscoveryParams } from "../discovery/run.js";

export type Body = Record<string, string | File | (string | File)[]>;

export function str(body: Body, key: string): string {
  const v = body[key];
  return (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "").trim();
}

export function strs(body: Body, key: string): string[] {
  const v = body[key];
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string");
}

function num(body: Body, key: string): number | null {
  const s = str(body, key);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Keywords: one per line or separated by commas (half or full width). */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[\n,，、;；]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Handles or profile links, one per line or separated by commas/spaces; links become handles. */
export function splitHandles(text: string, platform: Platform): string[] {
  return [...new Set(text.split(/[\s,，、;；]+/).map((s) => {
    s = s.trim();
    if (s.includes("/")) {
      const parts = s.replace(/[?#].*$/, "").split("/").filter(Boolean);
      s = parts[parts.length - 1] ?? "";
    }
    s = s.replace(/^@+/, "");
    return s && platform === "youtube" ? `@${s}` : s;
  }).filter(Boolean))];
}

export type DiscoveryDefaults = Partial<Omit<DiscoveryParams, "platform" | "handles">>;

/** Discovery fields shared by the project defaults form and the new-job form. */
export function parseDiscovery(body: Body): DiscoveryDefaults {
  return {
    keywords: splitList(str(body, "keywords")),
    seeds: splitHandles(str(body, "seeds"), "instagram"),
    perKeyword: num(body, "perKeyword") ?? DEFAULT_PARAMS.perKeyword,
    perSeed: num(body, "perSeed") ?? DEFAULT_PARAMS.perSeed,
    minFollowers: num(body, "minFollowers"),
    maxFollowers: num(body, "maxFollowers"),
    chineseOnly: str(body, "chineseOnly") === "on",
    linkPages: str(body, "linkPages") === "on",
    youtubeHidden: str(body, "youtubeHidden") === "on",
    country: str(body, "country") || DEFAULT_PARAMS.country,
    language: str(body, "language") || DEFAULT_PARAMS.language,
    maxSpend: num(body, "maxSpend") ?? DEFAULT_PARAMS.maxSpend,
  };
}

export function parseJob(body: Body): DiscoveryParams | string {
  const platform = str(body, "platform") as Platform;
  if (!PLATFORMS.includes(platform)) return "请选择平台";
  const params: DiscoveryParams = {
    ...DEFAULT_PARAMS,
    ...parseDiscovery(body),
    platform,
    handles: splitHandles(str(body, "handles"), platform),
  };
  if (platform !== "instagram") params.seeds = [];
  if (!params.keywords.length && !params.seeds.length && !params.handles.length) {
    return "关键词、种子账号、已知账号至少填一项";
  }
  if (params.maxSpend <= 0 || params.maxSpend > 200) return "预算要在 0 到 200 美元之间";
  return params;
}

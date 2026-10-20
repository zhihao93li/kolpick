import { BudgetExceeded, type ActorRunner } from "./apify.js";
import { keep, type FilterOptions } from "./filters.js";
import { Creator, normalizeHandle, type Platform } from "./models.js";
import * as pipeline from "./pipeline.js";

export interface DiscoveryParams extends FilterOptions {
  platform: Platform;
  keywords: string[];
  seeds: string[]; // Instagram only: accounts to expand via similar accounts
  handles: string[]; // look these up directly
  perSeed: number;
  perKeyword: number;
  linkPages: boolean; // crawl link-in-bio pages for creators still missing an email
  youtubeHidden: boolean; // YouTube hidden business email, ~$0.12 per email found
  country: string; // YouTube search country
  language: string; // YouTube page language
  maxSpend: number; // USD; stop starting new actor runs past this
}

export const DEFAULT_PARAMS: Omit<DiscoveryParams, "platform"> = {
  keywords: [], seeds: [], handles: [], perSeed: 150, perKeyword: 50,
  minFollowers: null, maxFollowers: null, chineseOnly: false,
  linkPages: true, youtubeHidden: false, country: "TW", language: "zh", maxSpend: 10,
};

export type ResultStatus = "has_email" | "no_email" | `filtered:${string}`;

export interface DiscoveryResult {
  creators: { creator: Creator; status: ResultStatus }[];
  /** Set when the budget ran out part way; what was found so far is still returned. */
  stoppedEarly: string;
}

/**
 * Run discovery and email lookup for one platform. `skip` holds handles not worth paying to look up
 * again (already in this project); they are dropped before any lookup step.
 */
export async function discover(api: ActorRunner, p: DiscoveryParams, skip: Set<string> = new Set()): Promise<DiscoveryResult> {
  const given = p.handles.filter(Boolean).map((h) => new Creator(p.platform, h, { discoveredBy: "input" }));
  const drop = (cs: Creator[]) => pipeline.dedupe(cs).filter((c) => !skip.has(normalizeHandle(c.handle)));
  const kept = (cs: Creator[]) => cs.filter((c) => keep(c, p)[0]);

  let creators: Creator[] = [];
  let stoppedEarly = "";
  try {
    if (p.platform === "instagram") {
      creators = drop([...given, ...(await pipeline.igDiscover(api, p.seeds, p.keywords, p.perSeed, p.perKeyword))]);
      await pipeline.igLookup(api, creators);
      if (p.linkPages) await pipeline.linkPagesLookup(api, kept(creators));
    } else if (p.platform === "youtube") {
      creators = drop([...given, ...(await pipeline.ytDiscover(api, p.keywords, p.perKeyword, p.minFollowers ?? null,
                                                                p.maxFollowers ?? null, p.country, p.language))]);
      await pipeline.ytLookup(api, creators);
      if (p.linkPages) await pipeline.linkPagesLookup(api, kept(creators));
      if (p.youtubeHidden) await pipeline.ytHiddenLookup(api, kept(creators));
    } else {
      creators = drop([...given, ...(await pipeline.ttDiscover(api, p.keywords, p.perKeyword))]);
      await pipeline.ttLookup(api, creators);
      if (p.linkPages) await pipeline.linkPagesLookup(api, kept(creators));
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    stoppedEarly = err.message;
  }

  const results = creators.map((creator) => {
    const [ok, reason] = keep(creator, p);
    const status: ResultStatus = !ok ? `filtered:${reason}` : creator.email ? "has_email" : "no_email";
    return { creator, status };
  });
  return { creators: results, stoppedEarly };
}

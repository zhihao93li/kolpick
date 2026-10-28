/**
 * Finding people and their emails with the Apify actors in src/discovery. Two ways in: the agent finds and puts
 * a "add these?" card in front of the operator; the operator finds in the console and the people go straight in.
 */
import { ApifyRunner, type ActorRunner, type RunLedger } from "../discovery/apify.js";
import { normalizeHandle, PLATFORMS, type Platform } from "../discovery/models.js";
import { DEFAULT_PARAMS, discover, type DiscoveryParams } from "../discovery/run.js";
import { addLog, type Ctx, type Project } from "./ctx.js";
import { addCandidates, proposeDecision, type Candidate } from "./proposals.js";

export interface FindInput {
  platform: Platform;
  keywords?: string[];
  /** Instagram: accounts whose similar accounts to collect. */
  seeds?: string[];
  /** Look these accounts up directly (just their emails). */
  handles?: string[];
  /** Roughly how many accounts to bring in. */
  target?: number;
  minFollowers?: number | null;
  maxFollowers?: number | null;
  youtubeHidden?: boolean;
  /** USD; stops starting new actor runs past this. */
  budget?: number;
  batch?: string;
}

const PLATFORM_NAMES: Record<Platform, string> = { instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok" };

class MemoryLedger implements RunLedger {
  async find() {
    return null;
  }
  async started() {}
  async finished() {}
}

export async function findPeople(ctx: Ctx, p: Project, input: FindInput, o: { direct: boolean; who?: string; run?: ActorRunner }) {
  if (!PLATFORMS.includes(input.platform)) throw new Error(`平台只能是 ${PLATFORMS.join("、")}`);
  const known = await ctx.db.query<{ handle: string }>("select lower(handle) as handle from kols where project_id = $1 and platform = $2 and handle is not null",
    [p.id, PLATFORM_NAMES[input.platform]]);
  const skip = new Set(known.map((k) => normalizeHandle(k.handle)));
  const keywords = input.keywords ?? [], seeds = input.seeds ?? [];
  const sources = keywords.length + seeds.length;
  const per = input.target && sources ? Math.max(10, Math.ceil(input.target / sources)) : null;
  const params: DiscoveryParams = {
    ...DEFAULT_PARAMS, platform: input.platform, keywords, seeds, handles: input.handles ?? [],
    ...(per ? { perKeyword: per, perSeed: per } : {}),
    minFollowers: input.minFollowers ?? null, maxFollowers: input.maxFollowers ?? null, youtubeHidden: !!input.youtubeHidden,
    maxSpend: input.budget ?? 5, country: p.settings.findCountry || DEFAULT_PARAMS.country, language: p.settings.findLanguage || DEFAULT_PARAMS.language,
  };
  const token = process.env.APIFY_TOKEN || ctx.cfg.apifyToken;
  if (!o.run && !token) throw new Error("这台电脑没有 Apify token：在决策台「设置 → 这台电脑」里填");
  const run = o.run ?? new ApifyRunner(token!, params.maxSpend, new MemoryLedger());
  const result = await discover(run, params, skip);
  const candidates: Candidate[] = result.creators.filter((c) => !c.status.startsWith("filtered")).map(({ creator: c }) => ({
    platform: PLATFORM_NAMES[c.platform], handle: c.handle, name: c.name || c.handle, url: c.profileUrl, followers: c.followers,
    email: c.allEmails[0] ?? "", other_emails: c.allEmails.slice(1), bio: c.bio.slice(0, 500),
    note: `找人：${c.discoveredBy}${c.emailSource ? `，邮箱来自 ${c.emailSource}` : ""}`,
  }));
  const filtered = result.creators.length - candidates.length;
  const spent = Number(((run as any).spent ?? 0).toFixed(2));
  const batch = input.batch ?? `${PLATFORM_NAMES[input.platform]} ${new Date(ctx.now()).toISOString().slice(0, 10)}`;
  const summary = { found: candidates.length, withEmail: candidates.filter((c) => c.email).length, filtered, spentUsd: spent, stoppedEarly: result.stoppedEarly || undefined };
  if (o.direct) {
    const added = await addCandidates(ctx.db, p, candidates, batch);
    await addLog(ctx, p, { kind: "find", who: o.who ?? "operator", summary: `找人入库 ${added} 人（${batch}，花费约 $${spent}）` });
    return { ...summary, added };
  }
  if (!candidates.length) return { ...summary, card: null };
  const card = await proposeDecision(ctx, p, {
    kind: "discovery", title: `这批要不要入库：${batch}（${candidates.length} 人，${summary.withEmail} 个有邮箱）`,
    why: `关键词 ${keywords.join("、") || "无"}；相似账号 ${seeds.join("、") || "无"}；花费约 $${spent}`, action: { candidates, batch }, who: o.who ?? "agent",
  });
  return { ...summary, card: card.id };
}

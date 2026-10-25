import { ApifyRunner, estimate, type ActorKey, type ActorRunner, type Item, type RunLedger } from "../discovery/apify.js";
import { dayOf, option, text } from "./base.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot, profileOf } from "./data.js";
import { apifyToken } from "./find.js";
import { postKey, urlIn } from "./metrics.js";
import { stamp } from "./ops.js";

/** Followup stages whose KOLs may be posting about the project. */
export const WATCH_STAGES = ["已约发布", "合作中", "已发布"];
/** How many of each KOL's latest posts one check reads; a few days' worth for anyone posting daily. */
const PER_PROFILE = 10;

const ACTOR_FOR: Record<string, ActorKey> = { Instagram: "ig_post", TikTok: "tt_post", YouTube: "yt_video" };

export interface Watched {
  followupId: string;
  name: string;
  platform: string;
  profileUrl: string;
  /** Words that mark a post as being about the project: 设置's 发布识别词 plus this KOL's 活动码. */
  words: string[];
}

function handleFrom(url: string, re: RegExp): string {
  return url.match(re)?.[1] ?? "";
}

/** Each platform's actor input for "the latest posts of these profiles since `since`" (YYYY-MM-DD). */
export function profileInput(key: ActorKey, profiles: string[], since: string): Item {
  if (key === "ig_post") return { directUrls: profiles, resultsType: "posts", resultsLimit: PER_PROFILE, onlyPostsNewerThan: since };
  if (key === "tt_post") {
    const handles = profiles.map((u) => handleFrom(u, /tiktok\.com\/@([\w.]+)/i) || u.replace(/^@/, ""));
    return { profiles: handles, resultsPerPage: PER_PROFILE, oldestPostDateUnified: since, shouldDownloadVideos: false, shouldDownloadCovers: false };
  }
  return { startUrls: profiles.map((url) => ({ url })), maxResults: PER_PROFILE, maxResultsShorts: PER_PROFILE, maxResultStreams: 0, oldestPostDate: since };
}

/** The fields 发布内容 needs from one scraped post; the actors name them differently. */
export function postOf(it: Item): { url: string; caption: string; at: number | null; form: string; owner: string } {
  const url = String(it.url ?? it.webVideoUrl ?? it.postUrl ?? (it.shortCode ? `https://www.instagram.com/p/${it.shortCode}/` : ""));
  // Instagram has caption, TikTok text, YouTube a title plus its description in text: read them all.
  const caption = [it.title, it.caption, it.text, it.description].filter((x) => typeof x === "string" && x).join("\n");
  const when = it.timestamp ?? it.createTimeISO ?? it.date ?? it.uploadDate;
  const at = when ? Date.parse(String(when)) : null;
  const kind = String(it.productType ?? it.type ?? "").toLowerCase();
  const form = /youtu/.test(url) ? (kind === "shorts" || /\/shorts\//.test(url) ? "短视频" : "长片")
    : it.webVideoUrl || /clips|video|reel/.test(kind) ? "短视频"
    : /sidecar|image/.test(kind) ? "贴文" : "其他";
  const owner = String(it.ownerUsername ?? it.authorMeta?.name ?? it.channelUrl ?? "").toLowerCase();
  return { url, caption, at: at == null || Number.isNaN(at) ? null : at, form, owner };
}

/** Whether a post names the project: any of the words, ignoring case. */
export function mentions(caption: string, words: string[]): string {
  const c = caption.toLowerCase();
  return words.find((w) => w && c.includes(w.toLowerCase())) ?? "";
}

class MemoryLedger implements RunLedger {
  async find() {
    return null;
  }
  async started() {}
  async finished() {}
}

/**
 * `kol posts`: reads the latest posts of every KOL who has agreed to post (or already has), and files the ones
 * that mention the project into 发布内容, so `metrics` starts counting their plays. Posts already in 发布内容 are
 * skipped; a KOL at 已约发布 moves to 已发布 when their first post is found. Costs Apify money, within `budget`.
 */
export async function findPosts(ctx: Ctx, o: { dryRun: boolean; budget: number; days?: number; runner?: ActorRunner; now?: number }) {
  const cfg = ctx.cfg;
  const t = cfg.tables;
  const now = o.now ?? Date.now();
  if (!cfg.postWords.length) throw new Error("「设置」里没填「发布识别词」（比如 tafu、@tafu_me、tafu.me），不知道哪些帖子是在讲这个项目");
  const [s, posts] = await Promise.all([loadSnapshot(ctx.base, cfg), ctx.base.records(t.posts, { fields: ["内容链接", "KOL"] })]);
  const known = new Set(posts.map((p) => postKey(urlIn(text(p["内容链接"])))));

  const watched: Watched[] = [];
  const skipped: string[] = [];
  for (const f of s.followups.values()) {
    if (!WATCH_STAGES.includes(option(f["阶段"]))) continue;
    const p = profileOf(s, f);
    const name = displayName(s, f);
    const platform = option(p?.["主要平台"]);
    const profileUrl = text(p?.["主页链接"]);
    if (!ACTOR_FOR[platform] || !profileUrl) {
      skipped.push(`${name}：${platform || "没填主要平台"}${profileUrl ? "" : "，没有主页链接"}，抓不了`);
      continue;
    }
    watched.push({ followupId: f.record_id, name, platform, profileUrl, words: [...cfg.postWords, text(f["活动码"])].filter(Boolean) });
  }
  const since = dayOf(now - (o.days ?? cfg.postLookbackDays) * 86_400_000, cfg.timezone);
  const byPlatform = new Map<string, Watched[]>();
  for (const w of watched) byPlatform.set(w.platform, [...(byPlatform.get(w.platform) ?? []), w]);
  const cost = [...byPlatform].reduce((sum, [p, list]) => sum + estimate(ACTOR_FOR[p], list.length * PER_PROFILE), 0);
  const report = {
    看了: watched.length, 从: since, 估计花费美元: Number(cost.toFixed(2)),
    新发现: [] as { name: string; 链接: string; 命中: string; 发布日期: string }[],
    抓不了: skipped, 没抓到: [] as string[], 试跑: o.dryRun || undefined,
  };
  if (o.dryRun || !watched.length) return report;
  if (cost > o.budget) throw new Error(`估计要 $${cost.toFixed(2)}，超过预算 $${o.budget}。加大 --budget 或减少 --days 再跑`);

  const runner = o.runner ?? new ApifyRunner(apifyToken(), o.budget, new MemoryLedger());
  const rows: Record<string, unknown>[] = [];
  const moved: Record<string, Record<string, unknown>> = {};
  const today = dayOf(now, cfg.timezone);
  for (const [platform, list] of byPlatform) {
    const items = await runner.run(ACTOR_FOR[platform], profileInput(ACTOR_FOR[platform], list.map((w) => w.profileUrl), since), list.length * PER_PROFILE);
    const seen = new Set<string>();
    for (const it of items) {
      const post = postOf(it);
      if (!post.url) continue;
      const key = postKey(post.url);
      // An actor given several profiles returns them mixed; match each post back to its KOL by the profile it came from.
      // Instagram reports the profile it was given as inputUrl, YouTube as inputChannelUrl.
      const input = String(it.inputUrl ?? it.inputChannelUrl ?? it.fromYTUrl ?? "");
      const w = list.find((x) => ownerMatches(post.owner, x.profileUrl, input)) ?? (list.length === 1 ? list[0] : undefined);
      if (!w) continue;
      seen.add(w.followupId);
      if (known.has(key) || (post.at != null && dayOf(post.at, cfg.timezone) < since)) continue;
      const hit = mentions(post.caption, w.words);
      if (!hit) continue;
      known.add(key);
      const published = post.at != null ? stamp(post.at, cfg.timezone) : "";
      report.新发现.push({ name: w.name, 链接: post.url, 命中: hit, 发布日期: published.slice(0, 10) });
      rows.push({
        KOL: [{ id: w.followupId }], 平台: [platform], 形式: [post.form], 内容链接: post.url,
        内容标题: post.caption.replace(/\s+/g, " ").trim().slice(0, 80), ...(published ? { 发布日期: published } : {}),
        备注: `${today} kol posts 自动发现（文案里有「${hit}」），请核对`,
      });
      const f = s.followups.get(w.followupId)!;
      if (option(f["阶段"]) === "已约发布") moved[w.followupId] = { 阶段: ["已发布"], 下一步: `${today} 发现已发布：${post.url}` };
    }
    for (const w of list) if (!seen.has(w.followupId)) report.没抓到.push(`${w.name}（${w.profileUrl}）`);
  }
  if (rows.length) {
    await ctx.base.create(t.posts, rows);
    if (Object.keys(moved).length) await ctx.base.update(t.followups, moved);
    ctx.run.op({ type: "飞书变更", result: "完成", action: `自动发现发布 ${rows.length} 条` });
  }
  return report;
}

function ownerMatches(owner: string, profileUrl: string, inputUrl: string): boolean {
  const p = profileUrl.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (inputUrl && inputUrl.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "") === p) return true;
  if (!owner) return false;
  const handle = p.match(/(?:instagram\.com|tiktok\.com\/@|youtube\.com\/@)\/?([\w.-]+)/)?.[1] ?? "";
  return Boolean(handle) && (owner === handle || owner.includes(handle));
}

import { ApifyRunner, estimate, type ActorKey, type ActorRunner, type Item, type RunLedger } from "../discovery/apify.js";
import { cellTime, dayOf, option, text } from "./base.js";
import type { Ctx } from "./ctx.js";
import { apifyToken } from "./find.js";
import type { Row } from "./lark.js";

/** Days after publishing at which 发布内容 records plays and engagement (第N天播放 / 第N天互动). */
export const CHECKPOINTS = [1, 3, 7, 30] as const;
/** A checkpoint is still filled up to this many days late; after that the number would mislead, so it's left empty. */
const LATE_DAYS = 2;

const ACTOR_FOR: Record<string, ActorKey> = { Instagram: "ig_post", TikTok: "tt_post", YouTube: "yt_video" };

export interface Due {
  id: string;
  platform: string;
  url: string;
  day: (typeof CHECKPOINTS)[number];
}

/** Which posts need which checkpoint today, and which checkpoints were missed for good. */
export function duePosts(rows: Row[], now: number, tz: string): { due: Due[]; missed: string[]; unsupported: string[] } {
  const out = { due: [] as Due[], missed: [] as string[], unsupported: [] as string[] };
  for (const r of rows) {
    const published = cellTime(r["发布日期"], tz);
    const url = urlIn(text(r["内容链接"]));
    const platform = option(r["平台"]);
    if (published == null || !url) continue;
    for (const d of CHECKPOINTS) {
      if (r[`第${d}天播放`] != null || r[`第${d}天互动`] != null) continue;
      const at = published + d * 86_400_000;
      if (now < at) continue;
      const label = `${url}（第 ${d} 天）`;
      if (now > at + LATE_DAYS * 86_400_000) out.missed.push(label);
      else if (!ACTOR_FOR[platform]) out.unsupported.push(`${label}：${platform || "没填平台"} 抓不了，请手动填`);
      else out.due.push({ id: r.record_id, platform, url, day: d });
    }
  }
  return out;
}

/** A 发布内容 cell may hold a markdown link ([url](url)); the URL inside is what counts. */
export function urlIn(cell: string): string {
  return cell.match(/\]\((https?:[^)\s]+)\)/)?.[1] ?? cell.trim();
}

/** Stable key of a post URL, so a scraper's result can be matched to the row that asked for it. */
export function postKey(url: string): string {
  const u = url.trim();
  const ig = u.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/i);
  if (ig) return `ig:${ig[1]}`;
  const tt = u.match(/tiktok\.com\/.*?(?:video|photo)\/(\d+)/i);
  if (tt) return `tt:${tt[1]}`;
  const yt = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i);
  if (yt) return `yt:${yt[1]}`;
  return u.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

const first = (it: Item, keys: string[]) => {
  for (const k of keys) if (typeof it[k] === "number") return it[k] as number;
  return null;
};

/** Plays and engagement (likes + comments + shares) from one scraper row; the actors name these differently. */
export function statsOf(it: Item): { plays: number | null; engagement: number | null } {
  const plays = first(it, ["videoPlayCount", "playCount", "viewCount", "videoViewCount", "views"]);
  const parts = [first(it, ["likesCount", "diggCount", "likes", "likeCount"]), first(it, ["commentsCount", "commentCount", "comments"]),
    first(it, ["shareCount", "sharesCount"])].filter((n): n is number => n != null);
  return { plays, engagement: parts.length ? parts.reduce((a, b) => a + b, 0) : null };
}

function urlOf(it: Item): string {
  return String(it.url ?? it.webVideoUrl ?? it.postUrl ?? it.inputUrl ?? (it.shortCode ? `https://www.instagram.com/p/${it.shortCode}/` : ""));
}

function inputFor(key: ActorKey, urls: string[]): Item {
  if (key === "ig_post") return { directUrls: urls, resultsType: "posts", resultsLimit: 1 };
  if (key === "tt_post") return { postURLs: urls, resultsPerPage: 1, shouldDownloadVideos: false };
  return { startUrls: urls.map((url) => ({ url })), maxResults: 1, maxResultsShorts: 1, maxResultStreams: 0 };
}

class MemoryLedger implements RunLedger {
  async find() {
    return null;
  }
  async started() {}
  async finished() {}
}

/**
 * `kol metrics`: for every post whose day 1, 3, 7 or 30 has come (and isn't more than two days past), fetches
 * plays and engagement with one scraper run per platform and fills 第N天播放 / 第N天互动.
 */
export async function postMetrics(ctx: Ctx, o: { dryRun: boolean; budget: number; runner?: ActorRunner }) {
  const rows = await ctx.base.records(ctx.cfg.tables.posts);
  const { due, missed, unsupported } = duePosts(rows, Date.now(), ctx.cfg.timezone);
  const byPlatform = new Map<string, Due[]>();
  for (const d of due) byPlatform.set(d.platform, [...(byPlatform.get(d.platform) ?? []), d]);
  const cost = [...byPlatform].reduce((sum, [p, list]) => sum + estimate(ACTOR_FOR[p], new Set(list.map((d) => d.url)).size), 0);
  const report = {
    要抓: due.map((d) => `${d.url}（第 ${d.day} 天）`), 估计花费美元: Number(cost.toFixed(2)),
    已填: 0, 没抓到: [] as string[], 错过的: missed, 要手动填: unsupported, 试跑: o.dryRun || undefined,
  };
  if (o.dryRun || !due.length) return report;
  if (cost > o.budget) throw new Error(`估计要 $${cost.toFixed(2)}，超过预算 $${o.budget}。加大 --budget 再跑`);

  const runner = o.runner ?? new ApifyRunner(apifyToken(), o.budget, new MemoryLedger());
  const changes: Record<string, Record<string, unknown>> = {};
  for (const [platform, list] of byPlatform) {
    const urls = [...new Set(list.map((d) => d.url))];
    const items = await runner.run(ACTOR_FOR[platform], inputFor(ACTOR_FOR[platform], urls), urls.length);
    const found = new Map(items.map((it) => [postKey(urlOf(it)), statsOf(it)]));
    for (const d of list) {
      const s = found.get(postKey(d.url));
      if (!s || (s.plays == null && s.engagement == null)) {
        report.没抓到.push(`${d.url}（第 ${d.day} 天）`);
        continue;
      }
      changes[d.id] = {
        ...changes[d.id],
        ...(s.plays != null ? { [`第${d.day}天播放`]: s.plays } : {}),
        ...(s.engagement != null ? { [`第${d.day}天互动`]: s.engagement } : {}),
      };
      report.已填++;
    }
  }
  if (Object.keys(changes).length) {
    await ctx.base.update(ctx.cfg.tables.posts, changes);
    ctx.run.op({ type: "飞书变更", result: "完成", action: `发布数据 ${report.已填} 条`, detail: `${dayOf(Date.now(), ctx.cfg.timezone)} 抓取` });
  }
  return report;
}

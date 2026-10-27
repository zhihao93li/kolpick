/**
 * Codes and posts: daily sync of code usage from the project's API, finding the posts of KOLs who agreed to post,
 * and their plays and engagement on day 1, 3, 7 and 30. Scraping goes through Apify actors.
 */
import { ApifyRunner, estimate, type ActorKey, type ActorRunner, type Item, type RunLedger } from "../discovery/apify.js";
import { addLog, dayOf, type Ctx, type Project } from "./ctx.js";

/** Pulls used / active / expiry / orders for every code. A failure keeps the old numbers. */
export async function syncCodes(ctx: Ctx, p: Project): Promise<{ codes: number; updated: number }> {
  const codes = await ctx.db.query<any>("select id, kind, code from codes where project_id = $1", [p.id]);
  if (!codes.length) return { codes: 0, updated: 0 };
  const info = await ctx.tafu(p).lookup([...new Set(codes.map((c) => c.code))]);
  let updated = 0;
  for (const c of codes) {
    const i = info.get(`${c.kind}:${String(c.code).toLowerCase()}`);
    if (!i) continue;
    await ctx.db.query(
      `update codes set used = coalesce($2, used), max_uses = coalesce($3, max_uses), expires_at = coalesce($4, expires_at), active = coalesce($5, active),
         paid_orders = coalesce($6, paid_orders), refunded_orders = coalesce($7, refunded_orders), visitors = coalesce($8, visitors),
         last_used_at = case when $2::int > coalesce(used, 0) then now() else last_used_at end, synced_at = now() where id = $1`,
      [c.id, i.used ?? null, i.maxUses ?? null, i.expiresAt ?? null, i.active ?? null, i.paidOrders ?? null, i.refundedOrders ?? null, i.visitors ?? null]);
    updated++;
  }
  await addLog(ctx, p, { kind: "sync", who: "tool", summary: `同步码用量：${updated}/${codes.length} 个` });
  return { codes: codes.length, updated };
}

const ACTOR_FOR: Record<string, ActorKey> = { Instagram: "ig_post", TikTok: "tt_post", YouTube: "yt_video" };
const PER_PROFILE = 10;
export const CHECKPOINTS = [1, 3, 7, 30] as const;

class MemoryLedger implements RunLedger {
  async find() {
    return null;
  }
  async started() {}
  async finished() {}
}

export function runner(ctx: Ctx, budget: number): ActorRunner & { spent?: number } {
  const token = process.env.APIFY_TOKEN || ctx.cfg.apifyToken;
  if (!token) throw new Error("这台电脑没有 Apify token（kolpick setup）");
  return new ApifyRunner(token, budget, new MemoryLedger());
}

function handleFrom(url: string, re: RegExp): string {
  return url.match(re)?.[1] ?? "";
}

export function profileInput(key: ActorKey, profiles: string[], since: string): Item {
  if (key === "ig_post") return { directUrls: profiles, resultsType: "posts", resultsLimit: PER_PROFILE, onlyPostsNewerThan: since };
  if (key === "tt_post") {
    const handles = profiles.map((u) => handleFrom(u, /tiktok\.com\/@([\w.]+)/i) || u.replace(/^@/, ""));
    return { profiles: handles, resultsPerPage: PER_PROFILE, oldestPostDateUnified: since, shouldDownloadVideos: false, shouldDownloadCovers: false };
  }
  return { startUrls: profiles.map((url) => ({ url })), maxResults: PER_PROFILE, maxResultsShorts: PER_PROFILE, maxResultStreams: 0, oldestPostDate: since };
}

export function postOf(it: Item): { url: string; caption: string; at: number | null; form: string; owner: string } {
  const url = String(it.url ?? it.webVideoUrl ?? it.postUrl ?? (it.shortCode ? `https://www.instagram.com/p/${it.shortCode}/` : ""));
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

const firstNum = (it: Item, keys: string[]) => {
  for (const k of keys) if (typeof it[k] === "number") return it[k] as number;
  return null;
};

export function statsOf(it: Item): { views: number | null; engagement: number | null } {
  const views = firstNum(it, ["videoPlayCount", "playCount", "viewCount", "videoViewCount", "views"]);
  const parts = [firstNum(it, ["likesCount", "diggCount", "likes", "likeCount"]), firstNum(it, ["commentsCount", "commentCount", "comments"]),
    firstNum(it, ["shareCount", "sharesCount"])].filter((n): n is number => n != null);
  return { views, engagement: parts.length ? parts.reduce((a, b) => a + b, 0) : null };
}

/**
 * Reads the latest posts of every KOL who agreed to post (or has), and files those that mention the project
 * (the keyword setting or the KOL's partner code). Costs Apify money within `budget`.
 */
export async function findPosts(ctx: Ctx, p: Project, o: { budget?: number; run?: ActorRunner } = {}): Promise<{ watched: number; found: number; skipped: string[] }> {
  const words = p.settings.postKeyword.split(/[、,，\s]+/).filter(Boolean);
  if (!words.length) throw new Error("设置里没填「找帖子的关键词」（比如 tafu、@tafu_me）");
  const kols = await ctx.db.query<any>(
    `select k.id, k.name, k.platform, k.url, k.stage, (select string_agg(code, ',') from codes c where c.kol_id = k.id and c.kind = 'partner') as partner
     from kols k where k.project_id = $1 and k.stage in ('publish_agreed', 'partner', 'published')`, [p.id]);
  const skipped: string[] = [];
  const byActor = new Map<ActorKey, any[]>();
  for (const k of kols) {
    const key = ACTOR_FOR[k.platform];
    if (!key || !k.url) {
      skipped.push(`${k.name}：${k.platform ?? "没有平台"}${k.url ? "" : "，没有主页"}，抓不了`);
      continue;
    }
    byActor.set(key, [...(byActor.get(key) ?? []), k]);
  }
  if (!byActor.size) return { watched: 0, found: 0, skipped };
  const run = o.run ?? runner(ctx, o.budget ?? 3);
  const since = dayOf(ctx.now() - p.settings.postLookbackDays * 86_400_000, p.settings.timezone);
  const known = new Set((await ctx.db.query<{ url: string }>("select url from posts where project_id = $1", [p.id])).map((r) => postKey(r.url)));
  let found = 0;
  for (const [key, list] of byActor) {
    const items = await run.run(key, profileInput(key, list.map((k) => k.url), since), list.length * PER_PROFILE);
    for (const it of items) {
      const post = postOf(it);
      if (!post.url || known.has(postKey(post.url))) continue;
      const k = list.find((x) => post.owner && x.url.toLowerCase().includes(post.owner.replace(/^@/, ""))) ?? (list.length === 1 ? list[0] : undefined);
      if (!k) continue;
      const kw = [...words, ...(k.partner ? String(k.partner).split(",") : [])];
      const hit = kw.find((w) => post.caption.toLowerCase().includes(w.toLowerCase()));
      if (!hit) continue;
      known.add(postKey(post.url));
      await ctx.db.query(
        `insert into posts (project_id, kol_id, url, platform, format, title, published_at, notes) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
        [p.id, k.id, post.url, k.platform, post.form, post.caption.split("\n")[0].slice(0, 120), post.at ? new Date(post.at).toISOString() : null, `找帖子：提到「${hit}」`]);
      await ctx.db.query("update kols set stage = case when stage = 'publish_agreed' then 'published' else stage end, updated_at = now() where id = $1", [k.id]);
      await addLog(ctx, p, { kind: "post", who: "tool", kolId: k.id, summary: `${k.name} 发了：${post.url}` });
      found++;
    }
  }
  return { watched: kols.length - skipped.length, found, skipped };
}

function inputFor(key: ActorKey, urls: string[]): Item {
  if (key === "ig_post") return { directUrls: urls, resultsType: "posts", resultsLimit: 1 };
  if (key === "tt_post") return { postURLs: urls, resultsPerPage: 1, shouldDownloadVideos: false };
  return { startUrls: urls.map((url) => ({ url })), maxResults: 1, maxResultsShorts: 1, maxResultStreams: 0 };
}

/** Day 1, 3, 7 and 30 plays and engagement for posts whose checkpoint has come (up to two days late). */
export async function postMetrics(ctx: Ctx, p: Project, o: { budget?: number; run?: ActorRunner } = {}): Promise<{ due: number; filled: number }> {
  const posts = await ctx.db.query<any>("select * from posts where project_id = $1 and published_at is not null", [p.id]);
  const now = ctx.now();
  const due: { post: any; day: number }[] = [];
  for (const post of posts) {
    for (const d of CHECKPOINTS) {
      if (post.metrics?.[String(d)]) continue;
      const at = Date.parse(post.published_at) + d * 86_400_000;
      if (now >= at && now <= at + 2 * 86_400_000 && ACTOR_FOR[post.platform]) due.push({ post, day: d });
    }
  }
  if (!due.length) return { due: 0, filled: 0 };
  const run = o.run ?? runner(ctx, o.budget ?? 2);
  let filled = 0;
  const byActor = new Map<ActorKey, typeof due>();
  for (const x of due) byActor.set(ACTOR_FOR[x.post.platform], [...(byActor.get(ACTOR_FOR[x.post.platform]) ?? []), x]);
  for (const [key, list] of byActor) {
    const urls = [...new Set(list.map((x) => x.post.url))];
    const items = await run.run(key, inputFor(key, urls), urls.length);
    for (const it of items) {
      const url = String(it.url ?? it.webVideoUrl ?? it.postUrl ?? it.inputUrl ?? "");
      for (const x of list.filter((y) => postKey(y.post.url) === postKey(url))) {
        const st = statsOf(it);
        await ctx.db.query("update posts set metrics = metrics || jsonb_build_object($2::text, $3::jsonb) where id = $1",
          [x.post.id, String(x.day), JSON.stringify({ ...st, at: new Date(now).toISOString() })]);
        filled++;
      }
    }
  }
  await addLog(ctx, p, { kind: "metrics", who: "tool", summary: `抓帖子数据：${filled}/${due.length}` });
  return { due: due.length, filled };
}

export { estimate };

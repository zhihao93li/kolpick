// Per-platform discovery and email lookup.
//
// Each platform follows the order verified on the 150-KOL benchmark (2026-10-20):
//   Instagram: related accounts + keyword search -> old email actor (reads the business
//              "public_email" field) -> link-in-bio pages for the rest.
//   YouTube:   channel keyword search (description already included) -> hidden business
//              email for the rest, only when asked (12 US cents per email found).
//   TikTok:    user keyword search -> bio text.

import * as emails from "./emails.js";
import type { ActorRunner, Item } from "./apify.js";
import { Creator, normalizeHandle } from "./models.js";

// Link-in-bio targets that never carry a contact email (social sites, chat apps, shops).
const SKIP_LINK_DOMAINS = [
  "instagram.com", "facebook.com", "fb.com", "youtube.com", "youtu.be", "tiktok.com",
  "line.me", "lin.ee", "wa.me", "whatsapp.com", "threads.net", "x.com", "twitter.com",
  "shopee.tw", "shopee.com", "myship.7-11.com.tw", "gbf.tw", "momoshop.com.tw",
  "pse.is", "apps.apple.com", "play.google.com",
];

/** Read a dotted path from an actor item. */
function get(item: Item, path: string): any {
  let cur: any = item;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur ?? undefined;
}

function toInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number.parseInt(String(value), 10);
  return Number.isNaN(n) ? null : n;
}

/** Merge c into pool by platform+handle, keeping the first non-empty value of each field. */
export function merge(pool: Map<string, Creator>, c: Creator): void {
  if (!c.handle) return;
  const existing = pool.get(c.key);
  if (!existing) {
    pool.set(c.key, c);
    return;
  }
  for (const attr of ["profileUrl", "name", "bio", "externalUrl"] as const) {
    if (!existing[attr] && c[attr]) existing[attr] = c[attr];
  }
  for (const attr of ["followers", "isBusiness", "isPrivate"] as const) {
    if (existing[attr] === null && c[attr] !== null) (existing as any)[attr] = c[attr];
  }
  for (const e of c.emails) existing.addEmail(e.email, e.source);
}

export function dedupe(creators: Creator[]): Creator[] {
  const pool = new Map<string, Creator>();
  for (const c of creators) merge(pool, c);
  return [...pool.values()];
}

// ---------------------------------------------------------------- Instagram

export async function igDiscover(api: ActorRunner, seeds: string[], keywords: string[],
                                 perSeed: number, perKeyword: number): Promise<Creator[]> {
  const pool = new Map<string, Creator>();
  if (seeds.length) {
    const items = await api.run("ig_related", { username: seeds, maxItem: perSeed, enrichProfile: false },
                                seeds.length * perSeed);
    for (const it of items) {
      const handle = it.username || "";
      merge(pool, new Creator("instagram", handle, {
        profileUrl: `https://www.instagram.com/${handle}/`, name: it.full_name || "",
        isPrivate: it.is_private ?? null, discoveredBy: "related",
      }));
    }
  }
  if (keywords.length) {
    const items = await api.run("ig_search", { search: keywords.join(", "), searchType: "user", searchLimit: perKeyword },
                                keywords.length * perKeyword);
    for (const it of items) {
      const handle = it.username || "";
      merge(pool, new Creator("instagram", handle, {
        profileUrl: `https://www.instagram.com/${handle}/`, name: it.fullName || "",
        followers: toInt(it.followersCount), isBusiness: it.isBusinessAccount ?? null, isPrivate: it.private ?? null,
        bio: it.biography || "", externalUrl: it.externalUrl || "", discoveredBy: `search:${it.searchTerm ?? ""}`,
      }));
    }
  }
  return [...pool.values()];
}

/** Fill followers, account type, bio and email from the old actor (the one that reads public_email). */
export async function igLookup(api: ActorRunner, creators: Creator[]): Promise<void> {
  const todo = creators.filter((c) => !c.isPrivate);
  if (!todo.length) return;
  const items = await api.run("ig_email", { instagram_ids: todo.map((c) => c.handle), verify_email: false },
                              todo.length);
  const byHandle = new Map(items.map((it) => [normalizeHandle(it.username || ""), it]));
  for (const c of todo) {
    const it = byHandle.get(normalizeHandle(c.handle));
    if (!it) {
      c.note ||= "not_returned";
      continue;
    }
    if (it.follower_count !== null && it.follower_count !== undefined) c.followers = toInt(it.follower_count);
    c.isBusiness = it.is_business ?? c.isBusiness;
    c.isPrivate = it.is_private ?? c.isPrivate;
    c.name = it.full_name || c.name;
    c.bio = it.biography || c.bio;
    c.externalUrl = it.external_url || c.externalUrl;
    if (it.public_email) c.addEmail(it.public_email, "platform_field");
    for (const e of [...emails.splitField(it.ExtractedEmails), ...emails.extract(c.bio)]) c.addEmail(e, "bio");
  }
}

// ---------------------------------------------------------------- Link-in-bio pages

export function crawlable(url: string): boolean {
  if (!url) return false;
  let host = "";
  try {
    host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return !!host && !SKIP_LINK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export async function linkPagesLookup(api: ActorRunner, creators: Creator[]): Promise<void> {
  const targets = new Map<string, Creator[]>();
  for (const c of creators) {
    if (!c.email && crawlable(c.externalUrl)) {
      const url = c.externalUrl.includes("://") ? c.externalUrl : `https://${c.externalUrl}`;
      targets.set(url, [...(targets.get(url) ?? []), c]);
    }
  }
  if (!targets.size) return;
  const items = await api.run("link_pages", {
    startUrls: [...targets.keys()].map((url) => ({ url })),
    maxDepth: 1, maxRequestsPerStartUrl: 5, maxRequests: targets.size * 5,
    sameDomain: true, mergeContacts: true, proxyConfig: { useApifyProxy: true },
  }, targets.size);
  for (const it of items) {
    const found = emails.splitField(it.emails);
    // A page listing many addresses is usually a shop or platform, not the creator.
    if (!found.length || found.length > 2) continue;
    for (const c of targets.get(it.originalStartUrl || "") ?? []) {
      for (const e of found) c.addEmail(e, "link_page");
    }
  }
}

// ---------------------------------------------------------------- YouTube

export function ytHandle(value: string): string {
  value = (value || "").trim();
  if (value.includes("youtube.com/")) value = value.replace(/\/+$/, "").split("/").pop() ?? "";
  return value.startsWith("@") ? value : `@${value}`;
}

export async function ytDiscover(api: ActorRunner, keywords: string[], perKeyword: number,
                                 minFollowers: number | null, maxFollowers: number | null,
                                 country: string, language: string): Promise<Creator[]> {
  if (!keywords.length) return [];
  const input: Item = { discoveryMode: "both", searchTerms: keywords, maxChannelsPerSearchTerm: perKeyword,
                        countryHint: country, languageHint: language };
  // The actor drops channels with a hidden subscriber count when a min/max is set, so
  // only pass the bounds through when the caller asked for them.
  if (minFollowers) input.minSubscribers = minFollowers;
  if (maxFollowers) input.maxSubscribers = maxFollowers;
  const items = await api.run("yt_search", input, keywords.length * perKeyword);
  const pool = new Map<string, Creator>();
  for (const it of items) {
    const c = new Creator("youtube", get(it, "channel.handle") || "", {
      profileUrl: get(it, "channel.url") || "", name: get(it, "channel.title") || "",
      followers: toInt(get(it, "metrics.subscribers")), bio: get(it, "channel.description") || "",
      discoveredBy: `search:${get(it, "discoverySource.value") ?? ""}`,
    });
    const links = get(it, "profile.externalLinks") || [];
    if (links.length) c.externalUrl = typeof links[0] === "object" ? links[0].url || "" : String(links[0]);
    for (const e of [...emails.splitField(get(it, "profile.emails")), ...emails.extract(c.bio)]) c.addEmail(e, "bio");
    merge(pool, c);
  }
  return [...pool.values()];
}

/** Profile + bio email for channels given by handle (search results already have this). */
export async function ytLookup(api: ActorRunner, creators: Creator[]): Promise<void> {
  const todo = creators.filter((c) => !c.bio && !c.email);
  if (!todo.length) return;
  const items = await api.run("yt_profile", { platforms: ["youtube"], channels: todo.map((c) => ytHandle(c.handle)),
                                              maxCreators: todo.length, enrichEmails: true }, todo.length);
  const byHandle = new Map(items.map((it) => [normalizeHandle(it.handle || ""), it]));
  for (const c of todo) {
    const it = byHandle.get(normalizeHandle(c.handle));
    if (!it) continue;
    c.name = it.name || c.name;
    if (it.followers !== null && it.followers !== undefined) c.followers = toInt(it.followers);
    c.bio = it.bio || c.bio;
    c.profileUrl = it.profile_url || c.profileUrl;
    c.externalUrl = it.website || c.externalUrl;
    // Its "website" source crawls the channel's site, which is the same as our link step.
    if (it.email) c.addEmail(it.email, it.email_source === "website" ? "link_page" : "bio");
    for (const e of emails.extract(c.bio)) c.addEmail(e, "bio");
  }
}

export async function ytHiddenLookup(api: ActorRunner, creators: Creator[]): Promise<void> {
  const todo = creators.filter((c) => !c.email);
  if (!todo.length) return;
  const items = await api.run("yt_hidden", { channels: todo.map((c) => ytHandle(c.handle)), scrape_fresh_emails: false },
                              todo.length);
  const byHandle = new Map(items.map((it) => [normalizeHandle(it.Query || ""), it]));
  for (const c of todo) {
    const it = byHandle.get(normalizeHandle(ytHandle(c.handle)));
    if (it?.Email && emails.isValid(it.Email)) c.addEmail(it.Email, "youtube_hidden");
  }
}

// ---------------------------------------------------------------- TikTok

function ttCreator(meta: Item, discoveredBy: string): Creator {
  const handle = meta.name || "";
  const c = new Creator("tiktok", handle, {
    profileUrl: `https://www.tiktok.com/@${handle}`, name: meta.nickName || "", followers: toInt(meta.fans),
    isPrivate: meta.privateAccount ?? null, bio: meta.signature || "", externalUrl: meta.bioLink || "", discoveredBy,
  });
  for (const e of emails.extract(c.bio)) c.addEmail(e, "bio");
  return c;
}

export async function ttDiscover(api: ActorRunner, keywords: string[], perKeyword: number): Promise<Creator[]> {
  if (!keywords.length) return [];
  const items = await api.run("tt_search", { searchQueries: keywords, maxProfilesPerQuery: perKeyword },
                              keywords.length * perKeyword);
  const pool = new Map<string, Creator>();
  for (const it of items) {
    if (it.name) merge(pool, ttCreator(it, `search:${it.searchQuery ?? ""}`));
  }
  return [...pool.values()];
}

export async function ttLookup(api: ActorRunner, creators: Creator[]): Promise<void> {
  const todo = creators.filter((c) => !c.bio && !c.email);
  if (!todo.length) return;
  const items = await api.run("tt_profile", { profiles: todo.map((c) => normalizeHandle(c.handle)), resultsPerPage: 1 },
                              todo.length);
  const byHandle = new Map<string, Item>();
  for (const it of items) {
    const meta = it.authorMeta || {};
    if (meta.name && !byHandle.has(normalizeHandle(meta.name))) byHandle.set(normalizeHandle(meta.name), meta);
  }
  for (const c of todo) {
    const meta = byHandle.get(normalizeHandle(c.handle));
    if (!meta) continue;
    const fresh = ttCreator(meta, c.discoveredBy);
    c.name = fresh.name;
    c.followers = fresh.followers;
    c.isPrivate = fresh.isPrivate;
    c.bio = fresh.bio;
    c.externalUrl = fresh.externalUrl;
    for (const e of fresh.emails) c.addEmail(e.email, "bio");
  }
}

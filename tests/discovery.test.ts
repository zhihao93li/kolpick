import { describe, expect, it } from "vitest";
import type { ActorKey, ActorRunner, Item } from "../src/discovery/apify.js";
import { BudgetExceeded } from "../src/discovery/apify.js";
import * as emails from "../src/discovery/emails.js";
import { keep, looksChinese } from "../src/discovery/filters.js";
import { Creator } from "../src/discovery/models.js";
import * as pipeline from "../src/discovery/pipeline.js";
import { DEFAULT_PARAMS, discover } from "../src/discovery/run.js";

/** Returns canned items per actor key instead of calling Apify. */
class FakeApify implements ActorRunner {
  calls: [ActorKey, Item][] = [];
  constructor(private items: Partial<Record<ActorKey, Item[]>>, private failOn?: ActorKey) {}
  async run(key: ActorKey, input: Item): Promise<Item[]> {
    if (key === this.failOn) throw new BudgetExceeded("budget used up");
    this.calls.push([key, input]);
    return this.items[key] ?? [];
  }
}

describe("emails", () => {
  it("extracts from a Chinese bio", () => {
    expect(emails.extract("合作📧teresalin51320@gmail.com\n生活日常帳：@Teresa")).toEqual(["teresalin51320@gmail.com"]);
  });
  it("handles full-width @ and dedupes", () => {
    expect(emails.extract("聯絡：abc＠gmail．com / ABC@gmail.com")).toEqual(["abc@gmail.com"]);
  });
  it("drops placeholders and images", () => {
    expect(emails.extract("example@mail.com logo@2x.png real@shan.art")).toEqual(["real@shan.art"]);
  });
  it("splits string and list fields", () => {
    expect(emails.splitField("a@b.co, c@d.tw")).toEqual(["a@b.co", "c@d.tw"]);
    expect(emails.splitField(["a@b.co", ""])).toEqual(["a@b.co"]);
    expect(emails.splitField(null)).toEqual([]);
  });
});

describe("pipeline", () => {
  it("prefers the Instagram public_email field", async () => {
    const api = new FakeApify({ ig_email: [
      { username: "silviali2014", public_email: "silvialiblogger@gmail.com", ExtractedEmails: "",
        is_business: true, follower_count: 12000, biography: "合作 other@gmail.com" },
      { username: "nobody", public_email: null, ExtractedEmails: "", biography: "私訊小盒子" },
    ] });
    const a = new Creator("instagram", "silviali2014");
    const b = new Creator("instagram", "nobody");
    await pipeline.igLookup(api, [a, b]);
    expect([a.email, a.emailSource]).toEqual(["silvialiblogger@gmail.com", "platform_field"]);
    expect(a.allEmails).toEqual(["silvialiblogger@gmail.com", "other@gmail.com"]);
    expect(a.followers).toBe(12000);
    expect(b.email).toBe("");
  });

  it("skips social links and shop pages when crawling link-in-bio", async () => {
    const api = new FakeApify({ link_pages: [
      { originalStartUrl: "https://portaly.cc/huto4869", emails: ["huto4869@gmail.com"] },
      { originalStartUrl: "https://example-shop.tw/", emails: ["cs@x.com", "info@x.com", "b@x.com"] },
    ] });
    const a = new Creator("instagram", "huto4869", { externalUrl: "https://portaly.cc/huto4869" });
    const b = new Creator("instagram", "shop", { externalUrl: "https://example-shop.tw/" });
    const c = new Creator("instagram", "fb", { externalUrl: "https://www.facebook.com/foo" });
    await pipeline.linkPagesLookup(api, [a, b, c]);
    const urls = api.calls[0][1].startUrls.map((u: Item) => u.url);
    expect(urls).not.toContain("https://www.facebook.com/foo");
    expect([a.email, a.emailSource]).toEqual(["huto4869@gmail.com", "link_page"]);
    expect(b.email).toBe("");
  });

  it("reads the YouTube description email and leaves out unset subscriber bounds", async () => {
    const api = new FakeApify({ yt_search: [{
      channel: { handle: "@greenphoto2010", url: "https://www.youtube.com/@greenphoto2010",
                 title: "綠攝", description: "合作信箱：greenphoto27270867@gmail.com" },
      metrics: { subscribers: null }, discoverySource: { value: "婚禮攝影" },
    }] });
    const [c] = await pipeline.ytDiscover(api, ["婚禮攝影"], 20, null, null, "TW", "zh");
    expect(c.email).toBe("greenphoto27270867@gmail.com");
    expect(api.calls[0][1]).not.toHaveProperty("minSubscribers");
  });

  it("looks up YouTube hidden emails only for channels still missing one", async () => {
    const api = new FakeApify({ yt_hidden: [{ Query: "@moneyweeklylife", Email: "x@gmail.com", Status: "EMAIL_AVAILABLE" }] });
    const has = new Creator("youtube", "@a");
    has.addEmail("a@a.com", "bio");
    const missing = new Creator("youtube", "moneyweeklylife");
    await pipeline.ytHiddenLookup(api, [has, missing]);
    expect(api.calls[0][1].channels).toEqual(["@moneyweeklylife"]);
    expect(missing.emailSource).toBe("youtube_hidden");
  });

  it("reads the TikTok bio email", async () => {
    const api = new FakeApify({ tt_search: [
      { name: "bobbypombo", fans: 2500000, signature: "📧  teambobbyp@underscoretalent.com", searchQuery: "x" },
      { searchQuery: "x" },
    ] });
    const [c] = await pipeline.ttDiscover(api, ["x"], 10);
    expect(c.email).toBe("teambobbyp@underscoretalent.com");
    expect(c.followers).toBe(2500000);
  });

  it("filters", () => {
    expect(looksChinese("親子日常")).toBe(true);
    expect(looksChinese("親子の遊び方")).toBe(false);
    expect(looksChinese("hello")).toBe(false);
    const c = new Creator("tiktok", "a", { followers: 500, bio: "新秘" });
    expect(keep(c, { minFollowers: 1000 })).toEqual([false, "below_min_followers"]);
    expect(keep(c, { chineseOnly: true })).toEqual([true, ""]);
  });
});

describe("discover", () => {
  it("skips known handles and keeps what was found when the budget runs out", async () => {
    const api = new FakeApify({ ig_search: [
      { username: "keepme", searchTerm: "新秘" },
      { username: "known", searchTerm: "新秘" },
    ] }, "ig_email");
    const result = await discover(api, { ...DEFAULT_PARAMS, platform: "instagram", keywords: ["新秘"] }, new Set(["known"]));
    expect(result.stoppedEarly).toBe("budget used up");
    expect(result.creators.map((r) => [r.creator.handle, r.status])).toEqual([["keepme", "no_email"]]);
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { ActorKey, ActorRunner, Item } from "../../src/discovery/apify.js";
import { configFrom, type Config } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { urlIn } from "../../src/kolops/metrics.js";
import { findPosts, mentions, postOf, profileInput } from "../../src/kolops/posts.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { BASE, MAILBOXES, SETTINGS, seedProject } from "./project.js";

const NOW = Date.parse("2026-10-25T10:00:00+08:00");
let lark: FakeLark;
let cfg: Config;
let ctx: Ctx;
let deer: string, jay: string;
let runs: { key: ActorKey; input: Item }[];
let items: Item[];

const runner: ActorRunner = {
  async run(key, input) {
    runs.push({ key, input });
    return items;
  },
};

function kol(name: string, stage: string, url: string, platform = "Instagram", extra: Record<string, unknown> = {}) {
  const pid = lark.add(T.profiles, { 账号名称: name, 主要平台: [platform], 主页链接: url, 联系许可: ["可联系"] });
  return lark.add(T.followups, { 账号名称: name, 档案: [{ id: pid }], 阶段: [stage], ...extra });
}

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  seedProject(lark);
  cfg = configFrom("测试项目", BASE, { record_id: "s", ...SETTINGS, 发布识别词: "tafu、@tafu_me" }, MAILBOXES.map((m, i) => ({ record_id: `mb${i}`, ...m })));
  deer = kol("小鹿", "已约发布", "https://www.instagram.com/deer_jay/");
  jay = kol("阿哲", "合作中", "https://www.instagram.com/jay.tw", "Instagram", { 活动码: "JAY2026" });
  kol("还在体验", "体验中", "https://www.instagram.com/other/");
  kol("播客", "已约发布", "https://podcasts.apple.com/x", "Podcast");
  lark.add(T.posts, { 内容链接: "[https://www.instagram.com/reel/OLD1/](https://www.instagram.com/reel/OLD1/)", KOL: [{ id: jay }] });
  runs = [];
  items = [
    { url: "https://www.instagram.com/reel/NEW1/", caption: "用 @tafu_me 看了我們的合盤", timestamp: "2026-10-24T11:00:00.000Z", productType: "clips", ownerUsername: "deer_jay", inputUrl: "https://www.instagram.com/deer_jay/" },
    { url: "https://www.instagram.com/p/NEW2/", caption: "今天的早餐", timestamp: "2026-10-23T11:00:00.000Z", type: "Image", ownerUsername: "deer_jay" },
    { url: "https://www.instagram.com/p/NEW3/", caption: "粉絲輸入 jay2026 有優惠", timestamp: "2026-10-22T11:00:00.000Z", type: "Sidecar", ownerUsername: "jay.tw" },
    { url: "https://www.instagram.com/reel/OLD1/", caption: "TAFU 合盤", timestamp: "2026-10-20T11:00:00.000Z", type: "Video", ownerUsername: "jay.tw" },
  ];
  ctx = makeCtx(cfg, lark, { id: "ou", name: "测试" }, "发现发布", false, async () => {});
});

it("reads posts the way each scraper gives them", () => {
  expect(postOf(items[0])).toMatchObject({ url: "https://www.instagram.com/reel/NEW1/", form: "短视频", owner: "deer_jay" });
  expect(postOf(items[2]).form).toBe("贴文");
  expect(postOf({ url: "https://www.youtube.com/shorts/abcdefghijk", title: "x", date: "2026-10-01" }).form).toBe("短视频");
  expect(postOf({ webVideoUrl: "https://www.tiktok.com/@deer/video/1", text: "x", createTimeISO: "2026-10-01T00:00:00Z" }).form).toBe("短视频");
  expect(mentions("看了 TAFU 的報告", ["tafu"])).toBe("tafu");
  expect(urlIn("[https://a.com/p/1](https://a.com/p/1)")).toBe("https://a.com/p/1");
  expect(profileInput("tt_post", ["https://www.tiktok.com/@deer.jay"], "2026-10-11").profiles).toEqual(["deer.jay"]);
});

it("files new posts that mention the project, once, and moves 已约发布 to 已发布", async () => {
  const r = await findPosts(ctx, { dryRun: false, budget: 1, runner, now: NOW });
  expect(runs).toHaveLength(1);
  expect(runs[0].input).toMatchObject({ directUrls: ["https://www.instagram.com/deer_jay/", "https://www.instagram.com/jay.tw"], onlyPostsNewerThan: "2026-10-11" });
  expect(r.新发现.map((x) => `${x.name}:${x.命中}`)).toEqual(["小鹿:tafu", "阿哲:JAY2026"]);
  expect(r.抓不了[0]).toMatch(/播客：Podcast/);
  const added = lark.table(T.posts).slice(1);
  expect(added[0]).toMatchObject({ KOL: [{ id: deer }], 平台: ["Instagram"], 形式: ["短视频"], 内容链接: "https://www.instagram.com/reel/NEW1/", 发布日期: "2026-10-24 19:00" });
  expect(lark.table(T.followups).find((f) => f.record_id === deer)!["阶段"]).toEqual(["已发布"]);
  expect(lark.table(T.followups).find((f) => f.record_id === jay)!["阶段"]).toEqual(["合作中"]);

  expect((await findPosts(ctx, { dryRun: false, budget: 1, runner, now: NOW })).新发现).toEqual([]);
  expect(lark.table(T.posts)).toHaveLength(3);
});

it("needs the project's words, and stays within budget", async () => {
  const bare = makeCtx({ ...cfg, postWords: [] }, lark, { id: "ou", name: "测试" }, "发现发布", false, async () => {});
  await expect(findPosts(bare, { dryRun: false, budget: 1, runner, now: NOW })).rejects.toThrow(/发布识别词/);
  await expect(findPosts(ctx, { dryRun: false, budget: 0.01, runner, now: NOW })).rejects.toThrow(/超过预算/);
  expect(runs).toHaveLength(0);
});

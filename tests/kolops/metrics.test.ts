import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActorKey, ActorRunner, Item } from "../../src/discovery/apify.js";
import { makeCtx } from "../../src/kolops/ctx.js";
import { duePosts, postKey, postMetrics, statsOf } from "../../src/kolops/metrics.js";
import { notifyGroup } from "../../src/kolops/notify.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

const DAY = 86_400_000;

describe("duePosts", () => {
  const now = Date.parse("2026-10-24T12:00:00+08:00");
  it("asks for each checkpoint once it has come, gives up two days later, and skips platforms it can't read", () => {
    const rows = [
      { record_id: "a", 平台: ["Instagram"], 内容链接: "https://www.instagram.com/p/AbC123/", 发布日期: now - 3.5 * DAY, 第1天播放: 900 },
      { record_id: "b", 平台: ["YouTube"], 内容链接: "https://youtu.be/dQw4w9WgXcQ", 发布日期: now - 6 * DAY },
      { record_id: "c", 平台: ["Threads"], 内容链接: "https://www.threads.net/@x/post/1", 发布日期: now - 1.2 * DAY },
    ];
    const r = duePosts(rows, now, "+08:00");
    expect(r.due.map((d) => `${d.id}:${d.day}`)).toEqual(["a:3"]);
    expect(r.missed).toEqual(["https://youtu.be/dQw4w9WgXcQ（第 1 天）", "https://youtu.be/dQw4w9WgXcQ（第 3 天）"]);
    expect(r.unsupported[0]).toMatch(/Threads 抓不了/);
  });
});

it("matches the same post however its URL is written, and reads each scraper's numbers", () => {
  expect(postKey("https://www.instagram.com/reel/AbC123/?igsh=x")).toBe(postKey("https://instagram.com/p/AbC123"));
  expect(postKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toBe(postKey("https://youtu.be/dQw4w9WgXcQ"));
  expect(postKey("https://www.tiktok.com/@deer/video/7311?lang=zh")).toBe("tt:7311");
  expect(statsOf({ videoPlayCount: 1200, likesCount: 80, commentsCount: 5 })).toEqual({ plays: 1200, engagement: 85 });
  expect(statsOf({ playCount: 5000, diggCount: 300, commentCount: 20, shareCount: 7 })).toEqual({ plays: 5000, engagement: 327 });
});

it("fills the checkpoint from one scraper run per platform", async () => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  const lark = new FakeLark();
  const cfg = seedProject(lark);
  const id = lark.add(T.posts, { 平台: ["TikTok"], 内容链接: "https://www.tiktok.com/@deer/video/7311", 发布日期: Date.now() - 1.5 * DAY });
  const calls: [ActorKey, Item][] = [];
  const runner: ActorRunner = {
    async run(key, input) {
      calls.push([key, input]);
      return [{ webVideoUrl: "https://www.tiktok.com/@deer/video/7311", playCount: 5000, diggCount: 300, commentCount: 20 }];
    },
  };
  const ctx = makeCtx(cfg, lark, { id: "ou", name: "测试" }, "发布数据", true, async () => {});
  const r = await postMetrics(ctx, { dryRun: false, budget: 2, runner });
  expect(r.已填).toBe(1);
  expect(calls).toEqual([["tt_post", { postURLs: ["https://www.tiktok.com/@deer/video/7311"], resultsPerPage: 1, shouldDownloadVideos: false }]]);
  expect(lark.table(T.posts).find((p) => p.record_id === id)).toMatchObject({ 第1天播放: 5000, 第1天互动: 320 });
});

it("posts the summary to the group bot with the KOL keyword, or skips without a bot", async () => {
  const lark = new FakeLark();
  const cfg = seedProject(lark);
  const file = join(mkdtempSync(join(tmpdir(), "kol-test-")), "s.txt");
  writeFileSync(file, "今天催了 3 位。");
  expect(await notifyGroup(cfg, { file, dryRun: false })).toMatchObject({ 发送: false });

  const sent: any[] = [];
  const fetchImpl = (async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ code: 0 }));
  }) as typeof fetch;
  await notifyGroup({ ...cfg, webhook: "https://open.feishu.cn/hook/x" }, { file, dryRun: false, fetchImpl });
  expect(sent[0]).toEqual({ msg_type: "text", content: { text: "KOL｜测试项目\n今天催了 3 位。" } });

  const refuse = (async () => new Response(JSON.stringify({ code: 19024, msg: "Key Words Not Found" }))) as typeof fetch;
  await expect(notifyGroup({ ...cfg, webhook: "https://open.feishu.cn/hook/x" }, { file, dryRun: false, fetchImpl: refuse })).rejects.toThrow(/自定义关键词/);
});

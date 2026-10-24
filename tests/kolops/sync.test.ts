import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { syncInbox } from "../../src/kolops/sync.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";
import { TABLES } from "../../src/kolops/schema.js";
import type { Config } from "../../src/kolops/config.js";

const T = TABLES;
let cfg: Config;
let lark: FakeLark;
let ctx: Ctx;
let fid: string;

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  cfg = seedProject(lark);
  const pid = lark.add(T.profiles, { 账号名称: "小鹿與阿哲", 公开邮箱: "Deer@Example.com", 联系许可: ["可联系"] });
  fid = lark.add(T.followups, { 账号名称: "小鹿與阿哲", 档案: [{ id: pid }], 阶段: ["已邀约"], 当前轮到谁: ["KOL"] });
  lark.inbox["hello@tafu.me"] = [
    { message_id: "m1", from: "小鹿 <deer@example.com>", subject: "Re: 想送您", date: new Date().toISOString() },
    { message_id: "m2", from: "news@shop.com", subject: "促销", date: new Date().toISOString() },
  ];
  ctx = makeCtx(cfg, lark, { id: "ou_me", name: "测试" }, "收信同步", false, async () => {});
});

it("files a known KOL's reply and hands the followup to us, once", async () => {
  const r = await syncInbox(ctx, { days: 3, dryRun: false });
  expect(r.newReplies).toHaveLength(1);
  expect(r.unknownSenders.map((u) => u.from)).toEqual(["news@shop.com"]);
  const f = lark.table(T.followups).find((x) => x.record_id === fid)!;
  expect(f["当前轮到谁"]).toEqual(["我们"]);
  expect(f["阶段"]).toEqual(["已回复"]);
  expect(lark.table(T.contacts)).toHaveLength(1);

  const again = await syncInbox(ctx, { days: 3, dryRun: false });
  expect(again.newReplies).toHaveLength(0);
  expect(lark.table(T.contacts)).toHaveLength(1);
});

it("files an auto-reply without treating it as an answer", async () => {
  lark.inbox["hello@tafu.me"] = [{ message_id: "m3", from: "deer@example.com", subject: "自動回覆：休假中", date: new Date().toISOString() }];
  const r = await syncInbox(ctx, { days: 3, dryRun: false });
  expect(r.newReplies).toHaveLength(0);
  expect(r.autoReplies).toHaveLength(1);
  const f = lark.table(T.followups).find((x) => x.record_id === fid)!;
  expect(f["当前轮到谁"]).toEqual(["KOL"]);
  expect(f["阶段"]).toEqual(["已邀约"]);
  expect(f["最后来信日期"]).toBeUndefined();
  expect(lark.table(T.contacts)[0]["待处理"]).toBe(false);
});

it("lists people who aren't in the base, but not no-reply robots or our own mailboxes", async () => {
  lark.inbox["hello@tafu.me"] = [
    { message_id: "a", from: "經紀人 <agent@mcn.tw>", subject: "關於合作", date: new Date().toISOString() },
    { message_id: "b", from: "no-reply@instagram.com", subject: "通知", date: new Date().toISOString() },
    { message_id: "c", from: "mei@tafu.me", subject: "內部", date: new Date().toISOString() },
  ];
  const r = await syncInbox(ctx, { days: 3, dryRun: false });
  expect(r.unknownSenders).toEqual([{ mailbox: "hello@tafu.me", from: "agent@mcn.tw", subject: "關於合作", date: expect.any(String) }]);
});

it("starts a day before the last finished sync, wherever it ran", async () => {
  const fiveDaysAgo = Date.now() - 5 * 86_400_000;
  lark.add(T.runs, { 运行: "收信同步（同事）", 结果: ["完成"], 开始时间: fiveDaysAgo });
  lark.add(T.runs, { 运行: "收信同步（同事）", 结果: ["失败"], 开始时间: Date.now() - 3600_000 });
  const r = await syncInbox(ctx, { dryRun: true });
  const since = Date.parse(`${r.since.replace(" ", "T")}:00+08:00`);
  expect(Math.abs(since - (fiveDaysAgo - 86_400_000))).toBeLessThan(60_000);
});

it("reads the default few days when nothing synced before", async () => {
  const r = await syncInbox(ctx, { dryRun: true });
  const since = Date.parse(`${r.since.replace(" ", "T")}:00+08:00`);
  expect(Math.abs(since - (Date.now() - 3 * 86_400_000))).toBeLessThan(60_000);
});

it("closes a bounced address and files the bounce so it's counted once", async () => {
  lark.inbox["hello@tafu.me"] = [{ message_id: "b1", from: "Mail Delivery <mailer-daemon@tafu.me>", subject: "Undeliverable", date: new Date().toISOString() }];
  lark.bodies.b1 = "Delivery to deer@example.com failed permanently.";
  const r = await syncInbox(ctx, { days: 3, dryRun: false });
  expect(r.bounces).toEqual([{ name: "小鹿與阿哲", address: "deer@example.com" }]);
  const f = lark.table(T.followups).find((x) => x.record_id === fid)!;
  expect(f["结案原因"]).toEqual(["退信或邮箱无效"]);
  const filed = lark.table(T.contacts);
  expect(filed).toHaveLength(1);
  expect(filed[0]).toMatchObject({ 摘要: "[退信] deer@example.com", 渠道: ["hello@tafu.me"], 待处理: false, KOL: [{ id: fid }] });

  await syncInbox(ctx, { days: 3, dryRun: false });
  expect(lark.table(T.contacts)).toHaveLength(1);
});

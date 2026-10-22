import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { loadConfig } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { syncInbox } from "../../src/kolops/sync.js";
import { FakeLark } from "./fake.js";

const cfg = loadConfig(join(import.meta.dirname, "../../plugins/kol-ops"));
const T = cfg.tables;
let lark: FakeLark;
let ctx: Ctx;
let fid: string;

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
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
  expect(r.unknownSenders).toBe(1);
  const f = lark.table(T.followups).find((x) => x.record_id === fid)!;
  expect(f["当前轮到谁"]).toEqual(["我们"]);
  expect(f["阶段"]).toEqual(["已回复"]);
  expect(lark.table(T.contacts)).toHaveLength(1);

  const again = await syncInbox(ctx, { days: 3, dryRun: false });
  expect(again.newReplies).toHaveLength(0);
  expect(lark.table(T.contacts)).toHaveLength(1);
});

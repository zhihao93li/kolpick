import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { loadConfig } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { invite } from "../../src/kolops/invite.js";
import { FakeLark } from "./fake.js";

process.env.KOL_PLUGIN_ROOT = join(import.meta.dirname, "../../plugins/kol-ops");
const cfg = loadConfig();
const T = cfg.tables;
let lark: FakeLark;
let ctx: Ctx;
let ok: string, dnc: string, noMail: string, approval: string;

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  lark.add(T.control, { 暂停所有发送: false });
  ok = lark.add(T.profiles, { 账号名称: "77夫妻", 称呼: "77", 公开邮箱: "77@example.com", 联系许可: ["可联系"] });
  dnc = lark.add(T.profiles, { 账号名称: "狄嘉", 公开邮箱: "dj@example.com", 联系许可: ["永不联系"], 联系许可原因: "拒绝" });
  noMail = lark.add(T.profiles, { 账号名称: "无邮箱", 联系许可: ["可联系"] });
  approval = lark.add(T.reviews, { 类型: ["决定"], 审核项: "第三十九批·新版 伴侶方向 3 人", 处理: ["发／同意"] });
  ctx = makeCtx(cfg, lark, { id: "ou_me", name: "测试" }, "发邀约", false, async () => {});
});

const opts = () => ({ batch: "第三十九批·新版", template: "邀约-新版-伴侶", mailbox: "hello@tafu.me", approval, profiles: [ok, dnc, noMail], dryRun: false });

it("invites only contactable people with an email and creates their followups", async () => {
  const r = await invite(ctx, opts());
  expect(r.sent.map((x) => x.name)).toEqual(["77夫妻"]);
  expect(r.skipped.map((x) => x.reason).join("\n")).toMatch(/永不联系/);
  expect(r.skipped.map((x) => x.reason).join("\n")).toMatch(/没有邮箱/);
  const args = lark.sent[0].args;
  expect(args).toContain("+send");
  expect(args[args.indexOf("--subject") + 1]).toBe("想送 77 和另一半一份免費的關係合盤");
  const f = lark.table(T.followups)[0];
  expect(f["阶段"]).toEqual(["已邀约"]);
  expect(f["邀约批次"]).toEqual(["第三十九批·新版"]);
  expect(lark.table(T.contacts)[0]["KOL"]).toEqual([{ id: f.record_id }]);
});

it("re-running the batch sends nobody twice", async () => {
  await invite(ctx, opts());
  const again = await invite(ctx, opts());
  expect(again.sent).toHaveLength(0);
  expect(lark.sent).toHaveLength(1);
});

it("refuses without an approval naming the batch, or with a batch the select doesn't have", async () => {
  lark.table(T.reviews)[0]["处理"] = ["不发"];
  await expect(invite(ctx, opts())).rejects.toThrow(/还没有被批准/);
  lark.table(T.reviews)[0]["处理"] = ["发／同意"];
  await expect(invite(ctx, { ...opts(), batch: "第四十批·新版" })).rejects.toThrow(/选项|批次/);
});

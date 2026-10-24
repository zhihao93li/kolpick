import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { invite } from "../../src/kolops/invite.js";
import { FakeLark } from "./fake.js";
import { BASE, seedProject } from "./project.js";
import { addProject } from "../../src/kolops/projects.js";
import { TABLES } from "../../src/kolops/schema.js";
import type { Config } from "../../src/kolops/config.js";

const T = TABLES;
let cfg: Config;
let lark: FakeLark;
let ctx: Ctx;
let ok: string, dnc: string, noMail: string, approval: string;

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  cfg = seedProject(lark);
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

it("skips an address that already has a followup under another profile, or appears twice in the batch", async () => {
  const earlier = lark.add(T.profiles, { 账号名称: "77夫妻 YouTube", 公开邮箱: "77@example.com", 联系许可: ["可联系"] });
  lark.add(T.followups, { 账号名称: "77夫妻 YouTube", 档案: [{ id: earlier }], 阶段: ["结案"] });
  const twinA = lark.add(T.profiles, { 账号名称: "雙胞胎 IG", 称呼: "雙胞胎", 公开邮箱: "twins@example.com", 联系许可: ["可联系"] });
  const twinB = lark.add(T.profiles, { 账号名称: "雙胞胎 TikTok", 称呼: "雙胞胎", 公开邮箱: "Twins@Example.com", 联系许可: ["可联系"] });
  const r = await invite(ctx, { ...opts(), profiles: [ok, twinA, twinB] });
  expect(r.sent.map((x) => x.name)).toEqual(["雙胞胎 IG"]);
  const reasons = r.skipped.map((x) => `${x.name}：${x.reason}`).join("\n");
  expect(reasons).toMatch(/77夫妻：邮箱已经在「77夫妻 YouTube」的跟进记录里/);
  expect(reasons).toMatch(/雙胞胎 TikTok：这一批里已经有人用同一个邮箱/);
});

it("only sends a template approved in the 模板 table", async () => {
  await expect(invite(ctx, { ...opts(), template: "邀约-草稿" })).rejects.toThrow(/已批准的邀约模板：邀约-新版-伴侶/);
});

it("skips someone another project on this computer contacted recently, but not long ago", async () => {
  const other = new FakeLark();
  const recent = other.add(T.profiles, { 公开邮箱: "77@example.com" });
  other.add(T.followups, { 档案: [{ id: recent }], 最近联系日期: Date.now() - 10 * 86_400_000 });
  const old = other.add(T.profiles, { 公开邮箱: "dj-old@example.com" });
  other.add(T.followups, { 档案: [{ id: old }], 最近联系日期: Date.now() - 200 * 86_400_000 });
  lark.others.OtherBaseToken0001 = other;
  addProject("测试项目", BASE);
  addProject("另一个项目", "OtherBaseToken0001");
  const fresh = lark.add(T.profiles, { 账号名称: "老朋友", 称呼: "老朋友", 公开邮箱: "dj-old@example.com", 联系许可: ["可联系"] });

  const r = await invite(ctx, { ...opts(), profiles: [ok, fresh] });
  expect(r.sent.map((x) => x.name)).toEqual(["老朋友"]);
  expect(r.skipped[0].reason).toMatch(/项目「另一个项目」.*90 天内不重复联系/);
});

it("doesn't look at other projects when the cooldown is 0", async () => {
  const other = new FakeLark();
  const p = other.add(T.profiles, { 公开邮箱: "77@example.com" });
  other.add(T.followups, { 档案: [{ id: p }], 最近联系日期: Date.now() });
  lark.others.OtherBaseToken0001 = other;
  addProject("测试项目", BASE);
  addProject("另一个项目", "OtherBaseToken0001");
  ctx.cfg.crossProjectCooldownDays = 0;
  const r = await invite(ctx, { ...opts(), profiles: [ok] });
  expect(r.sent.map((x) => x.name)).toEqual(["77夫妻"]);
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { stamp } from "../../src/kolops/ops.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { trialDue, trialFollowup } from "../../src/kolops/trialfollow.js";
import type { Config } from "../../src/kolops/config.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

const NOW = Date.parse("2026-10-25T10:00:00+08:00");
let lark: FakeLark;
let ctx: Ctx;
let cfg: Config;

let n = 0;
function kol(name: string, f: Record<string, unknown>): string {
  const pid = lark.add(T.profiles, { 账号名称: name, 称呼: name, 公开邮箱: `kol${++n}@example.com`, 联系许可: ["可联系"] });
  return lark.add(T.followups, { 账号名称: name, 档案: [{ id: pid }], 阶段: ["体验中"], 联系渠道: ["hello@tafu.me"], 当前轮到谁: ["KOL"], 体验码上限: 3, ...f });
}

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  n = 0;
  cfg = seedProject(lark);
  lark.add(T.templates, { 名称: "体验-未用", 用途: ["体验未用"], 状态: ["已批准"], 正文: "{稱呼} 您好：體驗碼 {體驗碼} 還沒用，{到期日}前都可以。" });
  lark.add(T.templates, { 名称: "体验-用了一部分", 用途: ["体验跟进"], 状态: ["已批准"], 正文: "{稱呼} 您好：用了 {已用} 次，還剩 {剩餘} 次，原期限{已於 / 將於} {M 月 D 日}到期。" });
  ctx = makeCtx(cfg, lark, { id: "ou_me", name: "测试运营" }, "体验跟进", false, async () => {});
});

it("picks the right nudge for each trial", () => {
  const f = (x: Record<string, unknown>) => ({ record_id: "r", 体验码: "abc", 体验码上限: 3, 阶段: ["体验中"], ...x });
  const until = "2026-11-05 10:00";
  expect(trialDue(cfg, f({ 体验码已用: 0, 体验码到期: until, 最近联系日期: "2026-10-19 10:00" }), "A", NOW)?.kind).toBe("未用");
  expect(trialDue(cfg, f({ 体验码已用: 0, 体验码到期: until, 最近联系日期: "2026-10-22 10:00" }), "A", NOW)).toBeNull();
  expect(trialDue(cfg, f({ 体验码已用: 1, 体验码到期: until, 最近联系日期: "2026-10-10 10:00", 体验码最近使用: "2026-10-17 10:00" }), "A", NOW)?.kind).toBe("停滞");
  expect(trialDue(cfg, f({ 体验码已用: 1, 体验码到期: until, 最近联系日期: "2026-10-10 10:00", 体验码最近使用: "2026-10-20 10:00" }), "A", NOW)).toBeNull();
  expect(trialDue(cfg, f({ 体验码已用: 1, 体验码到期: "2026-10-26 18:00", 最近联系日期: "2026-10-24 10:00" }), "A", NOW)?.kind).toBe("到期");
  expect(trialDue(cfg, f({ 体验码已用: 3, 体验码到期: "2026-10-26 18:00" }), "A", NOW)).toBeNull();
  expect(trialDue(cfg, f({ 体验码已用: 0, 体验码到期: "2026-10-24 18:00" }), "A", NOW)).toBeNull();
  expect(trialDue(cfg, f({ 体验码已用: 0, 体验码到期: until, 阶段: ["结案"] }), "A", NOW)).toBeNull();
});

it("S-G5 S-G6 files one review per nudge from the approved template, only once, and not while we owe an answer", async () => {
  // Today's usage numbers are in (R-06 to R-08 wait for them).
  lark.add(T.runs, { 运行: "体验码同步（测试）", 结果: ["完成"], 开始时间: stamp(NOW, "+08:00") });
  const unused = kol("小鹿", { 体验码: "deer", 体验码已用: 0, 体验码到期: "2026-11-05 10:00", 最近联系日期: "2026-10-18 10:00" });
  kol("阿哲", { 体验码: "jay", 体验码已用: 1, 体验码到期: "2026-11-05 10:00", 最近联系日期: "2026-10-10 10:00", 体验码最近使用: "2026-10-12 10:00" });
  kol("老王", { 体验码: "wang", 体验码已用: 1, 体验码到期: "2026-10-26 18:00", 最近联系日期: "2026-10-24 10:00" });
  kol("要回", { 体验码: "owe", 体验码已用: 0, 体验码到期: "2026-11-05 10:00", 最近联系日期: "2026-10-10 10:00", 当前轮到谁: ["我们"] });
  kol("Gmail", { 体验码: "gm", 体验码已用: 0, 体验码到期: "2026-11-05 10:00", 最近联系日期: "2026-10-10 10:00", 联系渠道: ["tafuofficial Gmail"] });

  const r = await trialFollowup(ctx, { dryRun: false, now: NOW });
  expect(r.提交审核.map((x) => `${x.name}:${x.类型}`)).toEqual(["小鹿:未用", "阿哲:停滞"]);
  expect(r.要手动跟进.map((x) => x.name)).toEqual(["Gmail"]);
  expect(r.缺模板[0]).toMatch(/体验到期/);
  const [a, b] = lark.table(T.reviews);
  expect(a).toMatchObject({ 类型: ["回复邮件"], 状态: ["待你审核"], 收件人: "kol1@example.com", 审核项: "[体验未用] 小鹿 deer", KOL: [{ id: unused }] });
  expect(a["邮件草稿"]).toBe("小鹿 您好：體驗碼 deer 還沒用，2026 年 11 月 5 日 10:00前都可以。");
  expect(b["邮件草稿"]).toBe("阿哲 您好：用了 1 次，還剩 2 次，原期限將於 11 月 5 日到期。");
  // 「等你审核」 is shown from the open item, not written onto the followup (2.1).
  expect(lark.table(T.followups).find((f) => f.record_id === unused)!["当前轮到谁"]).not.toEqual(["等你审核"]);

  // Once the KOL's turn comes round again, the same nudge is not filed twice.
  for (const f of lark.table(T.followups)) if (f["账号名称"] !== "要回") f["当前轮到谁"] = ["KOL"];
  for (const rv of lark.table(T.reviews)) rv["状态"] = ["已执行"];
  expect((await trialFollowup(ctx, { dryRun: false, now: NOW })).提交审核).toEqual([]);
});

it("S-G1 without a successful code sync today, no usage-based nudge is filed", async () => {
  kol("小鹿", { 体验码: "deer", 体验码已用: 0, 体验码到期: "2026-11-05 10:00", 最近联系日期: "2026-10-18 10:00" });
  lark.add(T.runs, { 运行: "体验码同步（测试）", 结果: ["失败"], 开始时间: stamp(NOW, "+08:00") });
  lark.add(T.runs, { 运行: "体验码同步（测试）", 结果: ["完成"], 开始时间: stamp(NOW - 86_400_000, "+08:00") });
  const r = await trialFollowup(ctx, { dryRun: false, now: NOW });
  expect(r.提交审核).toEqual([]);
  expect(r.用量没同步).toMatch(/还没有成功同步/);
});

it("S-G3 a trial that ran out while she was trying it is raised once as a decision", async () => {
  const fid = kol("小鹿", { 体验码: "deer", 体验码已用: 1, 体验码到期: "2026-10-23 10:00", 最近联系日期: "2026-10-18 10:00" });
  kol("早就过期", { 体验码: "old", 体验码已用: 1, 体验码到期: "2026-09-01 10:00" });
  const r = await trialFollowup(ctx, { dryRun: false, now: NOW });
  expect(r.已过期待定).toEqual(["小鹿"]);
  expect(lark.table(T.reviews)).toEqual([expect.objectContaining({ 类型: ["决定"], 审核项: "[体验过期] 小鹿 deer", 发送渠道: ["不发邮件"], KOL: [{ id: fid }] })]);
  // Ended with 不做了: never raised again.
  lark.table(T.reviews)[0]["状态"] = ["已撤回"];
  expect((await trialFollowup(ctx, { dryRun: false, now: NOW })).已过期待定).toEqual([]);
});

it("S-G2 two days without a successful code sync: still no usage-based nudge", async () => {
  kol("小鹿", { 体验码: "deer", 体验码已用: 0, 体验码到期: "2026-11-05 10:00", 最近联系日期: "2026-10-18 10:00" });
  for (const d of [0, 1]) lark.add(T.runs, { 运行: "体验码同步（测试）", 结果: ["失败"], 开始时间: stamp(NOW - d * 86_400_000, "+08:00") });
  expect((await trialFollowup(ctx, { dryRun: false, now: NOW })).提交审核).toEqual([]);
});

it("S-G4 an extended trial may get its expiry nudge again for the new date", () => {
  const f = (until: string) => ({ record_id: "r", 体验码: "abc", 体验码上限: 3, 体验码已用: 1, 阶段: ["体验中"], 体验码到期: until, 最近联系日期: "2026-10-24 10:00" });
  const before = trialDue(cfg, f("2026-10-26 18:00"), "A", NOW)!;
  expect(before.kind).toBe("到期");
  const extended = trialDue(cfg, f("2026-10-27 09:00"), "A", NOW)!;
  expect(extended.kind).toBe("到期");
  expect(extended.key).not.toBe(before.key);
});

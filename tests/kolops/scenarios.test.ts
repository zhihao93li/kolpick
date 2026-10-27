// Scenarios from docs/behavior.md §7. Each test name starts with the scenario's number.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { addDays } from "../../src/kolops/base.js";
import { stamp, today } from "../../src/kolops/ops.js";
import { remind } from "../../src/kolops/remind.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { syncInbox } from "../../src/kolops/sync.js";
import { sendApproved } from "../../src/kolops/send.js";
import { LarkError } from "../../src/kolops/lark.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let cfg: Config;
let ctx: Ctx;

const DAY = 86_400_000;
const at = (msAgo: number) => stamp(Date.now() - msAgo, "+08:00");

function kol(name: string, email: string, followup: Record<string, unknown>, profile: Record<string, unknown> = {}) {
  const pid = lark.add(T.profiles, { 账号名称: name, 称呼: name, 公开邮箱: email, 联系许可: ["可联系"], ...profile });
  const fid = lark.add(T.followups, { 账号名称: name, 档案: [{ id: pid }], 联系渠道: ["hello@tafu.me"], 级别: ["B"], ...followup });
  return { pid, fid };
}
const followup = (fid: string) => lark.table(T.followups).find((f) => f.record_id === fid)!;
const inbox = (...mails: { id: string; from: string; subject?: string }[]) => {
  lark.inbox["hello@tafu.me"] = mails.map((m) => ({ message_id: m.id, from: m.from, subject: m.subject ?? "Re: 合作", date: new Date().toISOString() }));
};
const bounce = (id: string, address: string) => {
  lark.inbox["hello@tafu.me"] = [{ message_id: id, from: "mailer-daemon@feishu.cn", subject: "Undelivered", date: new Date().toISOString() }];
  lark.bodies[id] = `Delivery to ${address} failed permanently.`;
};
/** Invited long enough ago that the first reminder is due today. */
const dueForReminder = () => ({ 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 首次邀约日期: at(6 * DAY), 下次跟进日期: at(0) });

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  cfg = seedProject(lark, { 自动催信起始日: addDays(today({ timezone: "+08:00" } as Config), -30) + " 00:00" });
  ctx = makeCtx(cfg, lark, { id: "ou_me", name: "测试" }, "收信同步", true, async () => {});
});

describe("7.1 来信、认领和重开", () => {
  it("S-A1 an unclaimed human mail holds today's reminders and closing", async () => {
    const { fid } = kol("小鹿", "deer@example.com", dueForReminder());
    inbox({ id: "u1", from: "new-address@example.com", subject: "我換信箱了" });
    const r = await remind(ctx, { dryRun: false });
    expect(r.held).toMatch(/对不上 KOL/);
    expect(r.send.sent).toEqual([]);
    expect(followup(fid)["阶段"]).toEqual(["已邀约"]);
  });

  it("S-A2 once the mail is marked unrelated, reminders run again", async () => {
    kol("小鹿", "deer@example.com", dueForReminder());
    lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "促销", 待处理: false, 内容: "发件人：shop@example.com" });
    const r = await remind(ctx, { dryRun: false });
    expect(r.held).toBeUndefined();
    expect(r.send.sent.map((x) => x.name)).toEqual(["小鹿"]);
  });

  it("S-A3 a recognised bounce still closes while a mail waits to be claimed", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 首次邀约日期: at(3 * DAY) });
    lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "合作", 待处理: true, 内容: "发件人：who@example.com" });
    bounce("b1", "deer@example.com");
    await syncInbox(ctx, { days: 1, dryRun: false });
    expect(followup(fid)).toMatchObject({ 阶段: ["结案"], 结案原因: ["退信或邮箱无效"] });
  });

  it("S-A4 an auto-reply alone doesn't hold reminders", async () => {
    kol("小鹿", "deer@example.com", dueForReminder());
    inbox({ id: "a1", from: "deer@example.com", subject: "自動回覆：休假中" });
    const r = await remind(ctx, { dryRun: false });
    expect(r.held).toBeUndefined();
  });

  it("S-F1 mail from a closed KOL opens her followup again, her turn becomes ours", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { 阶段: ["结案"], 结案原因: ["拒绝"], 当前轮到谁: ["无需动作"], 首次邀约日期: at(40 * DAY) });
    inbox({ id: "r1", from: "deer@example.com", subject: "其實我還是想試試" });
    await syncInbox(ctx, { days: 1, dryRun: false });
    expect(followup(fid)).toMatchObject({ 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    expect(followup(fid)["结案原因"] ?? null).toBeNull();
  });

  it("S-F2 mail from a 永不联系 KOL is kept, but nothing reopens and nobody's turn changes", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { 阶段: ["结案"], 结案原因: ["拒绝"], 当前轮到谁: ["无需动作"] }, { 联系许可: ["永不联系"] });
    inbox({ id: "r2", from: "deer@example.com", subject: "請不要再寄了" });
    await syncInbox(ctx, { days: 1, dryRun: false });
    expect(followup(fid)).toMatchObject({ 阶段: ["结案"], 当前轮到谁: ["无需动作"] });
    expect(lark.table(T.contacts).find((c) => c["Message ID"] === "r2")).toMatchObject({ 待处理: true, KOL: [{ id: fid }] });
  });

  it("S-F4 after we write first to someone closed as 无回应, the rules close her again when she stays silent", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 首次邀约日期: at(25 * DAY), 下次跟进日期: at(0) });
    // Two reminders already went out.
    for (const n of [1, 2]) {
      lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 摘要: `[催信] 第 ${n} 次`, 日期: at((20 - n * 7) * DAY), KOL: [{ id: fid }] });
    }
    const r = await remind(ctx, { dryRun: false });
    expect(r.closed).toEqual(["小鹿"]);
    expect(followup(fid)).toMatchObject({ 阶段: ["结案"], 结案原因: ["无回应"] });
  });

  it("S-F5 if she answers before the date, she is not closed", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 首次邀约日期: at(25 * DAY), 下次跟进日期: at(0) });
    for (const n of [1, 2]) {
      lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 摘要: `[催信] 第 ${n} 次`, 日期: at((20 - n * 7) * DAY), KOL: [{ id: fid }] });
    }
    inbox({ id: "r3", from: "deer@example.com", subject: "抱歉晚回" });
    const r = await remind(ctx, { dryRun: false });
    expect(r.closed).toEqual([]);
    expect(followup(fid)["阶段"]).toEqual(["已回复"]);
  });
});

describe("7.2 退信", () => {
  it("S-B1 an invited KOL who never wrote is closed when her address bounces", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 首次邀约日期: at(2 * DAY) });
    bounce("b2", "deer@example.com");
    const r = await syncInbox(ctx, { days: 1, dryRun: false });
    expect(r.bounces).toEqual([{ name: "小鹿", address: "deer@example.com" }]);
    expect(followup(fid)).toMatchObject({ 阶段: ["结案"], 结案原因: ["退信或邮箱无效"], 当前轮到谁: ["无需动作"] });
    expect(lark.table(T.contacts).find((c) => c["Message ID"] === "b2")!["待处理"]).toBe(false);
  });

  it("S-B2 a KOL who has answered is not closed; the bounce waits for someone to fix the address", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { 阶段: ["体验中"], 当前轮到谁: ["KOL"], 首次邀约日期: at(20 * DAY), 最后来信日期: at(10 * DAY), 体验码: "deer_jay" });
    bounce("b3", "deer@example.com");
    const r = await syncInbox(ctx, { days: 1, dryRun: false });
    expect(r.bounces).toEqual([]);
    expect(r.bouncesToCheck).toEqual([{ name: "小鹿", address: "deer@example.com" }]);
    expect(followup(fid)["阶段"]).toEqual(["体验中"]);
    expect(lark.table(T.contacts).find((c) => c["Message ID"] === "b3")).toMatchObject({ 待处理: true, KOL: [{ id: fid }] });
  });

  it("S-B4 a bounce whose address isn't recognised stays 待处理 and moves nobody", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 首次邀约日期: at(2 * DAY) });
    bounce("b4", "someone-else@example.com");
    await syncInbox(ctx, { days: 1, dryRun: false });
    expect(followup(fid)["阶段"]).toEqual(["已邀约"]);
    const row = lark.table(T.contacts).find((c) => c["Message ID"] === "b4")!;
    expect(row["待处理"]).toBe(true);
    expect(row["KOL"]).toBeUndefined();
  });

  it("S-B5 a bounce and a due 无回应 close on the same day close for the bounce", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 首次邀约日期: at(25 * DAY), 下次跟进日期: at(0) });
    for (const n of [1, 2]) {
      lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 摘要: `[催信] 第 ${n} 次`, 日期: at((20 - n * 7) * DAY), KOL: [{ id: fid }] });
    }
    bounce("b5", "deer@example.com");
    await remind(ctx, { dryRun: false });
    expect(followup(fid)["结案原因"]).toEqual(["退信或邮箱无效"]);
  });
});

describe("7.3 共用邮箱", () => {
  it("S-C1 mail from an address two open KOLs share waits to be claimed; neither moves", async () => {
    const a = kol("甲", "team@example.com", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"] });
    const b = kol("乙", "team@example.com", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"] });
    inbox({ id: "s1", from: "team@example.com" });
    const r = await syncInbox(ctx, { days: 1, dryRun: false });
    expect(r.ambiguous.map((x) => x.kols)).toEqual([["甲", "乙"]]);
    expect(followup(a.fid)["阶段"]).toEqual(["已邀约"]);
    expect(followup(b.fid)["阶段"]).toEqual(["已邀约"]);
    const row = lark.table(T.contacts).find((c) => c["Message ID"] === "s1")!;
    expect(row).toMatchObject({ 待处理: true });
    expect(row["KOL"]).toBeUndefined();
  });

  it("S-C2 when only one of them is still open, the mail is hers", async () => {
    kol("甲", "team@example.com", { 阶段: ["结案"], 结案原因: ["拒绝"], 当前轮到谁: ["无需动作"] });
    const b = kol("乙", "team@example.com", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"] });
    inbox({ id: "s2", from: "team@example.com" });
    await syncInbox(ctx, { days: 1, dryRun: false });
    expect(followup(b.fid)).toMatchObject({ 阶段: ["已回复"], 当前轮到谁: ["我们"] });
  });

  it("S-C3 two KOLs sharing an address both due a reminder: only one mail goes there today", async () => {
    kol("甲", "team@example.com", dueForReminder());
    kol("乙", "team@example.com", dueForReminder());
    const r = await remind(ctx, { dryRun: false });
    expect(r.send.sent).toHaveLength(1);
    expect(r.send.skipped.map((x) => x.reason).join()).toMatch(/共用这个邮箱/);
  });
});

describe("7.3 共用邮箱（续）", () => {
  it("S-C4 a reviewed reply still goes to an address that already got today's reminder", async () => {
    const a = kol("甲", "team@example.com", dueForReminder());
    const b = kol("乙", "team@example.com", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    await remind(ctx, { dryRun: false });
    expect(lark.sent).toHaveLength(1);
    lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"], 收件人: "team@example.com",
      邮件草稿: "主题：回覆\n謝謝來信", KOL: [{ id: b.fid }], 审核项: "回乙" });
    const r = await sendApproved(makeCtx(cfg, lark, ctx.me, "", false, async () => {}), { dryRun: false });
    expect(r.sent).toHaveLength(1);
    expect(followup(a.fid)["阶段"]).toEqual(["已邀约"]);
  });

  it("S-C6 when one of two KOLs sharing an address is 永不联系, the other gets nothing either", async () => {
    kol("甲", "team@example.com", { 阶段: ["结案"], 当前轮到谁: ["无需动作"] }, { 联系许可: ["永不联系"] });
    kol("乙", "team@example.com", dueForReminder());
    const r = await remind(ctx, { dryRun: false });
    expect(r.send.sent).toEqual([]);
    expect(r.send.skipped.map((x) => x.reason).join()).toMatch(/永不联系/);
  });
});

describe("7.7 催信、结案和批准", () => {
  it("S-R2 a first reminder that failed doesn't count: the next run sends the first again", async () => {
    kol("小鹿", "deer@example.com", dueForReminder());
    lark.failSend = new LarkError("lark-cli mail +send 失败：{\"code\":1234}", true);
    await remind(ctx, { dryRun: false });
    lark.failSend = null;
    const again = await remind(makeCtx(cfg, lark, ctx.me, "催信和结案", true, async () => {}), { dryRun: false });
    expect(again.send.sent).toHaveLength(1);
    expect(lark.table(T.contacts).filter((c) => String(c["摘要"]).startsWith("[催信]"))).toHaveLength(1);
  });

  it("S-R6 a paused KOL is neither chased nor closed, and her mail is still filed", async () => {
    const { fid } = kol("小鹿", "deer@example.com", { ...dueForReminder(), 阶段: ["暂缓"] });
    for (const n of [1, 2]) {
      lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 摘要: `[催信] 第 ${n} 次`, 日期: at((20 - n * 7) * DAY), KOL: [{ id: fid }] });
    }
    inbox({ id: "p1", from: "deer@example.com", subject: "最近比較忙" });
    const r = await remind(ctx, { dryRun: false });
    expect(r.send.sent).toEqual([]);
    expect(r.closed).toEqual([]);
    expect(followup(fid)["阶段"]).toEqual(["暂缓"]);
    expect(lark.table(T.contacts).find((c) => c["Message ID"] === "p1")).toMatchObject({ 待处理: true, KOL: [{ id: fid }] });
  });

  it("S-R7 with sending paused nobody is chased, but people due to close are still closed", async () => {
    const due = kol("要催", "chase@example.com", dueForReminder());
    const done = kol("要结", "close@example.com", { ...dueForReminder(), 首次邀约日期: at(25 * DAY) });
    for (const n of [1, 2]) {
      lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 摘要: `[催信] 第 ${n} 次`, 日期: at((20 - n * 7) * DAY), KOL: [{ id: done.fid }] });
    }
    lark.table(T.settings)[0]["暂停所有发送"] = true;
    const r = await remind(ctx, { dryRun: false });
    expect(r.send.sent).toEqual([]);
    expect(r.closed).toEqual(["要结"]);
    expect(followup(due.fid)["阶段"]).toEqual(["已邀约"]);
  });

  it("S-R12 with a reply waiting for review, no reminder goes to her", async () => {
    const { fid } = kol("小鹿", "deer@example.com", dueForReminder());
    lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: fid }] });
    const r = await remind(ctx, { dryRun: false });
    expect(r.send.sent).toEqual([]);
  });

  it("S-R4 a mailbox that wasn't read in full holds today's reminders and closing", async () => {
    kol("小鹿", "deer@example.com", dueForReminder());
    lark.inbox["hello@tafu.me"] = Array.from({ length: 400 }, (_, i) => ({
      message_id: `bulk${i}`, from: "no-reply@shop.com", subject: "促销", date: new Date().toISOString(),
    }));
    const r = await remind(ctx, { dryRun: false });
    expect(r.held).toMatch(/没把信收全/);
    expect(r.send.sent).toEqual([]);
  });

  it("S-R20 the project's daily limit stops new people today; someone already written to today still gets a reply", async () => {
    cfg = seedProject(new FakeLark(), {}) && { ...cfg, companyDailyExternal: 1 };
    ctx = makeCtx(cfg, lark, ctx.me, "催信和结案", true, async () => {});
    kol("甲", "a@example.com", dueForReminder());
    kol("乙", "b@example.com", dueForReminder());
    const r = await remind(ctx, { dryRun: false });
    expect(r.send.sent).toHaveLength(1);
    expect(r.send.skipped.map((x) => x.reason).join()).toMatch(/额度/);
  });

  it("G-3 a partial read doesn't move the next sync's start past what was missed", async () => {
    lark.add(T.runs, { 运行: "收信同步（同事）", 结果: ["完成"], 开始时间: Date.now() - 5 * DAY });
    lark.add(T.runs, { 运行: "收信同步（同事）", 结果: ["部分完成"], 开始时间: Date.now() - 3600_000 });
    const r = await syncInbox(ctx, { dryRun: true });
    const since = Date.parse(`${r.since.replace(" ", "T")}:00+08:00`);
    expect(Math.abs(since - (Date.now() - 6 * DAY))).toBeLessThan(120_000);
  });

  it("S-R16 an unsent failed mail holds her place: no reminder goes to her", async () => {
    const { fid } = kol("小鹿", "deer@example.com", dueForReminder());
    lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["执行失败"], 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: fid }] });
    const r = await remind(ctx, { dryRun: false });
    expect(r.send.sent).toEqual([]);
    expect(r.notChased.map((x) => x.reason).join()).toMatch(/没发成/);
  });

  it("S-R25 without an approved 催信 2 template the second reminder waits, but people chased twice are still closed", async () => {
    lark.table(T.templates).find((t) => t["名称"] === "催信-2")!["状态"] = ["待审核"];
    const once = kol("一次", "one@example.com", { ...dueForReminder(), 首次邀约日期: at(13 * DAY) });
    lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 摘要: "[催信] 第 1 次", 日期: at(7 * DAY), KOL: [{ id: once.fid }] });
    const twice = kol("两次", "two@example.com", { ...dueForReminder(), 首次邀约日期: at(25 * DAY) });
    for (const n of [1, 2]) {
      lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 摘要: `[催信] 第 ${n} 次`, 日期: at((20 - n * 7) * DAY), KOL: [{ id: twice.fid }] });
    }
    const r = await remind(ctx, { dryRun: false });
    expect(r.notChased.find((x) => x.name === "一次")!.reason).toMatch(/催信 2/);
    expect(r.closed).toEqual(["两次"]);
  });
});

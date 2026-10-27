// Scenarios from docs/behavior.md §7 that show up as decision-console cards and actions.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addEmail, approve, closeFollowup, mailDone, mailLink, problemDone, resumeFollowup, updateFollowup, writeMail, type Jobs } from "../../src/kolops/console/actions.js";
import { remind } from "../../src/kolops/remind.js";
import { applyRevisions } from "../../src/kolops/reviews.js";
import { sendApproved } from "../../src/kolops/send.js";
import { trialFollowup } from "../../src/kolops/trialfollow.js";
import { LarkError } from "../../src/kolops/lark.js";
import { writeFileSync } from "node:fs";
import { CHECK_IN_MARK, ConsoleData, decisionCards } from "../../src/kolops/console/state.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { stamp, today } from "../../src/kolops/ops.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let ctx: Ctx;
let data: ConsoleData;

const DAY = 86_400_000;
const at = (msAgo: number) => stamp(Date.now() - msAgo, "+08:00");
const row = (table: string, id: string) => lark.table(table).find((r) => r.record_id === id)!;
/** Jobs that never run: these tests look at what an action files, not at the send. */
const held = () => ({ add: () => ({ id: 1, what: "held", person: "", state: "排队中", note: "", at: Date.now() }) }) as unknown as Jobs;

let n = 0;
function kol(name: string, followup: Record<string, unknown>, profile: Record<string, unknown> = {}) {
  const pid = lark.add(T.profiles, { 账号名称: name, 称呼: name, 公开邮箱: `kol${++n}@example.com`, 联系许可: ["可联系"], ...profile });
  const fid = lark.add(T.followups, { 账号名称: name, 档案: [{ id: pid }], 联系渠道: ["hello@tafu.me"], ...followup });
  return { pid, fid };
}
async function cards() {
  await data.refresh();
  return decisionCards(data, ctx.cfg, today(ctx.cfg)).cards;
}

const fresh = () => makeCtx(ctx.cfg, lark, ctx.me, "", false, async () => {});

beforeEach(async () => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-console-"));
  n = 0;
  lark = new FakeLark();
  const cfg = seedProject(lark, { 自动催信起始日: stamp(Date.now() - 60 * DAY, "+08:00") });
  ctx = makeCtx(cfg, lark, { id: "op", name: "林运营" }, "", false, async () => {});
  data = new ConsoleData(ctx);
});

describe("7.1 认领和重开", () => {
  it("S-F3 mail from a closed KOL's new address, claimed for her, reopens her followup", async () => {
    const { fid } = kol("小鹿", { 阶段: ["结案"], 结案原因: ["拒绝"], 当前轮到谁: ["无需动作"] });
    const mail = lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "我換信箱了", 待处理: true, 内容: "发件人：deer.new@example.com", 日期: at(0) });
    await data.refresh();
    await mailLink(ctx, data, [mail], fid);
    expect(row(T.followups, fid)).toMatchObject({ 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    expect(row(T.followups, fid)["结案原因"] ?? null).toBeNull();
  });

  it("S-F2 a 永不联系 KOL's mail shows only 不用回", async () => {
    const { fid } = kol("小鹿", { 阶段: ["结案"], 当前轮到谁: ["无需动作"] }, { 联系许可: ["永不联系"] });
    lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "別再寄了", 待处理: true, KOL: [{ id: fid }], 日期: at(0) });
    const card = (await cards()).find((c) => c.who?.id === fid)!;
    expect(card).toMatchObject({ kind: "mail", blocked: true, tag: "永不联系" });
  });
});

describe("7.2 退信", () => {
  it("S-B2 a bounce left for a KOL who has answered comes up as its own card", async () => {
    const { fid } = kol("小鹿", { 阶段: ["体验中"], 当前轮到谁: ["KOL"] });
    lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "[退信] kol1@example.com", 待处理: true, KOL: [{ id: fid }], 日期: at(0) });
    const card = (await cards()).find((c) => c.who?.id === fid)!;
    expect(card).toMatchObject({ kind: "bounce", tag: "退信" });
  });

  it("S-B3 after adding a new address, a mail can go to it", async () => {
    const { fid } = kol("小鹿", { 阶段: ["合作中"], 当前轮到谁: ["KOL"] });
    await data.refresh();
    await addEmail(ctx, data, fid, "Deer.New@Example.com");
    await data.refresh();
    await writeMail(ctx, data, held(), fid, "", "換這個信箱聯絡您", undefined, { to: "deer.new@example.com" });
    expect(lark.table(T.reviews)[0]["收件人"]).toBe("deer.new@example.com");
    await expect(writeMail(ctx, data, held(), fid, "", "x", undefined, { to: "nobody@example.com" })).rejects.toThrow(/不是她档案里的邮箱/);
  });
});

describe("7.5 约定发布和等对方", () => {
  const overdue = () => kol("小鹿", { 阶段: ["已约发布"], 当前轮到谁: ["KOL"], 约定发布日期: at(10 * DAY) });

  it("S-E3 after two check-ins went out, the card offers 结案, 暂缓 or 再等", async () => {
    const { fid } = overdue();
    for (const d of [7, 3]) lark.add(T.reviews, { 审核项: `${CHECK_IN_MARK} 林运营在决策台写的信`, 状态: ["已执行"], KOL: [{ id: fid }], 执行时间: at(d * DAY) });
    const card = (await cards()).find((c) => c.id === `overdue:${fid}`)!;
    expect(card).toMatchObject({ asked: 2, tag: "问过还没发" });
    expect(card.draft).toBeUndefined();
  });

  it("S-E2 a check-in that went out moves her next follow-up 3 days on, and the card waits till then", async () => {
    const { fid } = overdue();
    await data.refresh();
    await writeMail(ctx, data, held(), fid, "想確認一下", "請問發布了嗎？", undefined, { purpose: "发布确认" });
    await sendApproved(fresh(), { dryRun: false });
    expect(String(row(T.followups, fid)["下次跟进日期"])).toMatch(/^\d{4}-\d{2}-\d{2} 10:00$/);
    expect((await cards()).find((c) => c.id === `overdue:${fid}`)).toBeUndefined();
  });

  it("S-E4 a check-in that didn't go out isn't counted and doesn't move the follow-up date", async () => {
    const { fid } = overdue();
    await data.refresh();
    await writeMail(ctx, data, held(), fid, "想確認一下", "請問發布了嗎？", undefined, { purpose: "发布确认" });
    lark.failSend = new LarkError("lark-cli mail +send 失败：{\"code\":1234}", true);
    await sendApproved(fresh(), { dryRun: false });
    expect(row(T.followups, fid)["下次跟进日期"]).toBeUndefined();
    const card = (await cards()).find((c) => c.id === `overdue:${fid}`)!;
    expect(card).toMatchObject({ asked: 0, tag: "没按时发布" });
  });

  it("S-E5 waiting on her a week with no follow-up date comes up", async () => {
    const { fid } = kol("小鹿", { 阶段: ["已回复"], 当前轮到谁: ["KOL"], 最近联系日期: at(8 * DAY) });
    kol("还早", { 阶段: ["已回复"], 当前轮到谁: ["KOL"], 最近联系日期: at(3 * DAY) });
    kol("有日期", { 阶段: ["已回复"], 当前轮到谁: ["KOL"], 最近联系日期: at(8 * DAY), 下次跟进日期: at(-3 * DAY) });
    const waiting = (await cards()).filter((c) => c.kind === "waiting");
    expect(waiting.map((c) => c.who?.id)).toEqual([fid]);
  });
});

describe("7.7 待发位置", () => {
  it("S-R13 an item that only makes a code doesn't hide her new mail", async () => {
    const { fid } = kol("小鹿", { 阶段: ["体验中"], 当前轮到谁: ["我们"] });
    lark.add(T.reviews, { 类型: ["决定"], 状态: ["待你审核"], 发送渠道: ["不发邮件"], 体验码动作: ["延期"], 审核项: "延期", KOL: [{ id: fid }] });
    lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "還想多用幾次", 待处理: true, KOL: [{ id: fid }], 日期: at(0) });
    const mailCards = (await cards()).filter((c) => c.kind === "mail" && c.who?.id === fid);
    expect(mailCards).toHaveLength(1);
  });
});

describe("评审补的场景", () => {
  it("S-F4 writing first to a KOL closed as 无回应 reopens her at the stage she closed from, and the rules close her again", async () => {
    const { fid } = kol("小鹿", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 首次邀约日期: at(25 * DAY), 下次跟进日期: at(0), 级别: ["B"] });
    for (const n of [1, 2]) lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 摘要: `[催信] 第 ${n} 次`, 日期: at((20 - n * 7) * DAY), KOL: [{ id: fid }] });
    const routine = () => makeCtx(ctx.cfg, lark, ctx.me, "催信和结案", true, async () => {});
    await remind(routine(), { dryRun: false });
    expect(row(T.followups, fid)).toMatchObject({ 阶段: ["结案"], 结案原因: ["无回应"] });
    expect(String(row(T.followups, fid)["下一步"])).toMatch(/结案前：已邀约/);

    await data.refresh();
    await writeMail(ctx, data, held(), fid, "再打擾一次", "最近有空看看嗎？");
    await sendApproved(fresh(), { dryRun: false });
    expect(row(T.followups, fid)).toMatchObject({ 阶段: ["已邀约"], 当前轮到谁: ["KOL"] });
    // Silent until the date: closed again as 无回应.
    row(T.followups, fid)["下次跟进日期"] = at(0);
    const r = await remind(routine(), { dryRun: false });
    expect(r.closed).toEqual(["小鹿"]);
  });

  it("S-A2 once the waiting mail is marked unrelated from the console, reminders run again", async () => {
    kol("小鹿", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 首次邀约日期: at(6 * DAY), 下次跟进日期: at(0), 级别: ["B"] });
    const m = lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "促销", 待处理: true, 内容: "发件人：shop@example.com", 日期: at(0) });
    const routine = () => makeCtx(ctx.cfg, lark, ctx.me, "催信和结案", true, async () => {});
    expect((await remind(routine(), { dryRun: false })).held).toMatch(/对不上 KOL/);
    await mailDone(ctx, [m]);
    const r = await remind(routine(), { dryRun: false });
    expect(r.held).toBeUndefined();
    expect(r.send.sent).toHaveLength(1);
  });

  it("an approval with nothing to carry out is marked done, so it holds nobody up", async () => {
    const { fid } = kol("小鹿", { 阶段: ["体验中"], 当前轮到谁: ["KOL"] });
    const id = lark.add(T.reviews, { 类型: ["决定"], 状态: ["待你审核"], 发送渠道: ["不发邮件"], 审核项: "要不要再送一次", KOL: [{ id: fid }] });
    await data.refresh();
    await approve(ctx, data, held(), id, {});
    expect(row(T.reviews, id)["状态"]).toEqual(["已执行"]);
  });

  it("I-1 the console refuses a second mail while one is waiting or failed", async () => {
    const { fid } = kol("小鹿", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["执行失败"], 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: fid }] });
    await data.refresh();
    await expect(writeMail(ctx, data, held(), fid, "", "再寫一封")).rejects.toThrow(/同一时间只能有一封/);
  });

  it("E-30 closing leaves an item being sent alone, and its write-back keeps her closed (T-1)", async () => {
    const { fid } = kol("小鹿", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待执行"], 执行结果: "执行中（测试）", 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: fid }] });
    await data.refresh();
    await closeFollowup(ctx, data, fid, { never: false, reason: "其他" });
    expect(row(T.reviews, id)["状态"]).toEqual(["待执行"]);
    expect(row(T.followups, fid)).toMatchObject({ 阶段: ["结案"], 当前轮到谁: ["无需动作"] });
  });

  it("T-1 a closed followup's turn can't be set to anyone by hand", async () => {
    const { fid } = kol("小鹿", { 阶段: ["结案"], 当前轮到谁: ["无需动作"] });
    await data.refresh();
    await expect(updateFollowup(ctx, data, fid, { 当前轮到谁: "KOL" })).rejects.toThrow(/无需动作/);
  });

  it("C-10 an expired trial the reviewer asks to extend comes back as a 延期 reply", async () => {
    const { fid } = kol("小鹿", { 阶段: ["体验中"], 当前轮到谁: ["KOL"], 体验码: "deer", 体验码已用: 1, 体验码上限: 3, 体验码到期: at(2 * DAY) });
    await trialFollowup(ctx, { dryRun: false });
    const item = lark.table(T.reviews).find((r) => String(r["审核项"]).startsWith("[体验过期]"))!;
    item["处理"] = ["改"];
    item["你的意见"] = "延期 7 天";
    const file = join(process.env.KOL_DATA_DIR!, "rev.json");
    writeFileSync(file, JSON.stringify([{ review: item.record_id, draft: "小鹿您好：\n\n體驗碼 {體驗碼} 延到 {到期日}。", trial: { action: "延期", days: 7 } }]));
    const r = await applyRevisions(ctx, { file, dryRun: false });
    expect(r.写入).toBe(1);
    expect(row(T.reviews, item.record_id)).toMatchObject({ 类型: ["回复邮件"], 体验码动作: ["延期"], 体验码: "deer", 体验天数: 7, 状态: ["待你审核"], 收件人: "kol1@example.com" });
    expect(row(T.reviews, item.record_id)["KOL"]).toEqual([{ id: fid }]);
  });
});

describe("界面差距表（ui.md 第 6 节）", () => {
  it("C-01 a 发后动作 changed on the card is part of the approval and is carried out", async () => {
    const { fid } = kol("小鹿", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 发送渠道: ["hello@tafu.me"], 收件人: "kol1@example.com", 邮件草稿: "主题：謝謝\n謝謝您，祝順利", 审核项: "回她", KOL: [{ id: fid }] });
    await data.refresh();
    await approve(ctx, data, held(), id, { 发后动作: "结案", 结案原因: "拒绝" });
    expect(row(T.reviews, id)).toMatchObject({ 发后动作: ["结案"], 结案原因: ["拒绝"], 处理: ["发／同意"] });
    const rep = await sendApproved(fresh(), { dryRun: false, only: [id] });
    expect(rep).toMatchObject({ skipped: [] });
    expect(row(T.followups, fid)).toMatchObject({ 阶段: ["结案"], 结案原因: ["拒绝"] });
  });

  it("C-01 发后动作 without a reason is refused, and 无 clears both", async () => {
    const { fid } = kol("小鹿", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 发送渠道: ["hello@tafu.me"], 收件人: "kol1@example.com", 邮件草稿: "好的", 审核项: "回她", KOL: [{ id: fid }], 发后动作: ["结案"], 结案原因: ["拒绝"] });
    await data.refresh();
    await expect(approve(ctx, data, held(), id, { 发后动作: "结案" })).rejects.toThrow(/结案原因/);
    await approve(ctx, data, held(), id, { 发后动作: "" });
    expect(row(T.reviews, id)["发后动作"] ?? null).toBeNull();
    expect(row(T.reviews, id)["结案原因"] ?? null).toBeNull();
  });

  it("U-3 pausing notes the stage it paused from, and resuming goes back to it", async () => {
    const { fid } = kol("小鹿", { 阶段: ["合作中"], 当前轮到谁: ["KOL"] });
    await data.refresh();
    await updateFollowup(ctx, data, fid, { 阶段: "暂缓" });
    expect(row(T.followups, fid)["阶段"]).toEqual(["暂缓"]);
    expect(String(row(T.followups, fid)["下一步"])).toMatch(/（暂缓前：合作中）/);
    await data.refresh();
    expect(await resumeFollowup(ctx, data, fid)).toBe("合作中");
    expect(row(T.followups, fid)["阶段"]).toEqual(["合作中"]);
  });

  it("U-3 resuming a pause that noted nothing goes back to 已回复", async () => {
    const { fid } = kol("小鹿", { 阶段: ["暂缓"], 当前轮到谁: ["KOL"], 下一步: "先放着" });
    await data.refresh();
    expect(await resumeFollowup(ctx, data, fid)).toBe("已回复");
  });

  it("C-12 adding a new address keeps the bounce card; the mail to it being queued clears it", async () => {
    const { fid } = kol("小鹿", { 阶段: ["合作中"], 当前轮到谁: ["KOL"] });
    const b = lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "[退信] kol1@example.com", 待处理: true, KOL: [{ id: fid }], 日期: at(0) });
    await data.refresh();
    await addEmail(ctx, data, fid, "deer.new@example.com");
    expect((await cards()).find((c) => c.who?.id === fid)).toMatchObject({ kind: "bounce", bounced: "kol1@example.com" });
    await writeMail(ctx, data, held(), fid, "", "換這個信箱聯絡您", undefined, { to: "deer.new@example.com", answers: [b] });
    expect(row(T.contacts, b)["待处理"]).toBe(false);
    expect((await cards()).find((c) => c.kind === "bounce")).toBeUndefined();
  });

  it("C-12 a mail refused (I-1) leaves the bounce card in place", async () => {
    const { fid } = kol("小鹿", { 阶段: ["合作中"], 当前轮到谁: ["KOL"] });
    const b = lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "[退信] kol1@example.com", 待处理: true, KOL: [{ id: fid }], 日期: at(0) });
    lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["执行失败"], 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: fid }] });
    await data.refresh();
    await expect(writeMail(ctx, data, held(), fid, "", "x", undefined, { answers: [b] })).rejects.toThrow(/只能有一封/);
    expect(row(T.contacts, b)["待处理"]).toBe(true);
  });

  it("U-5 an approved mail from a mailbox switched off since goes back for review instead of hanging", async () => {
    const { fid } = kol("小鹿", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 发送渠道: ["old@tafu.me"], 收件人: "kol1@example.com", 邮件草稿: "好的", 审核项: "回她", KOL: [{ id: fid }], 处理: ["发／同意"] });
    const r = await sendApproved(fresh(), { dryRun: false });
    expect(r.skipped.find((x) => x.key === id)?.reason).toMatch(/已停用/);
    expect(row(T.reviews, id)).toMatchObject({ 状态: ["待你审核"] });
    expect(row(T.reviews, id)["处理"] ?? null).toBeNull();
    const card = (await cards()).find((c) => c.id === id)!;
    expect(card.returned).toMatch(/已停用/);
  });

  it("C-10 an expired trial is its own card with the code's usage", async () => {
    const { fid } = kol("小鹿", { 阶段: ["体验中"], 当前轮到谁: ["KOL"], 体验码: "deer", 体验码已用: 1, 体验码上限: 3, 体验码到期: at(2 * DAY) });
    await trialFollowup(ctx, { dryRun: false });
    const card = (await cards()).find((c) => c.who?.id === fid)!;
    expect(card).toMatchObject({ kind: "expired", tag: "体验码过期", trial: { code: "deer", used: 1, max: 3 } });
  });
});

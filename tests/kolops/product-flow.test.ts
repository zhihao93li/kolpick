import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "../../src/kolops/base.js";
import { approve, closeFollowup, decideTemplate, Jobs, mailDone, problemRetry, problemSent, sendQueued, setPaused, updateFollowup, writeMail } from "../../src/kolops/console/actions.js";
import { ConsoleData, decisionCards, peopleView } from "../../src/kolops/console/state.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { stamp, today } from "../../src/kolops/ops.js";
import { approveInConsole } from "../../src/kolops/reviews.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { sendApproved } from "../../src/kolops/send.js";
import { syncInbox } from "../../src/kolops/sync.js";
import { loadTemplates } from "../../src/kolops/templates.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

/** What one operator action should leave behind across approval, sending and the followup (review of 2026-10-26). */

let lark: FakeLark;
let ctx: Ctx;
let data: ConsoleData;
let fid = "";

const row = (table: string, id: string) => lark.table(table).find((r) => r.record_id === id)!;
const review = (extra: Record<string, unknown> = {}) => lark.add(T.reviews, {
  状态: ["待你审核"], 类型: ["回复邮件"], 发送渠道: ["hello@tafu.me"], 收件人: "audit@example.com",
  邮件草稿: "主题：合作\n旧的合作提案", KOL: [{ id: fid }], 审核项: "合作回复", ...extra,
});
const cards = () => decisionCards(data, ctx.cfg, today(ctx.cfg)).cards;
const fresh = () => makeCtx(ctx.cfg, lark, ctx.me, "", false, async () => {});
/** Jobs that never run, for actions whose job is beside the point. */
const held = () => ({ add: () => ({ id: 1, what: "held", person: fid, state: "排队中", note: "", at: Date.now() }) }) as unknown as Jobs;
async function settled(jobs: Jobs) {
  for (let i = 0; i < 200 && jobs.list.some((j) => ["排队中", "进行中"].includes(j.state)); i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(async () => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-flow-"));
  lark = new FakeLark();
  const cfg = seedProject(lark);
  for (const tpl of lark.table(T.templates)) if (tpl["状态"]?.[0] === "待审核") tpl["状态"] = ["草稿"];
  const pid = lark.add(T.profiles, { 账号: "audit", 账号名称: "审核测试", 公开邮箱: "audit@example.com", 联系许可: ["可联系"] });
  fid = lark.add(T.followups, { 账号名称: "审核测试", 档案: [{ id: pid }], 阶段: ["已回复"], 当前轮到谁: ["我们"], 联系渠道: ["hello@tafu.me"] });
  ctx = makeCtx(cfg, lark, { id: "audit", name: "审核员" }, "", false, async () => {});
  data = new ConsoleData(ctx);
  await data.refresh();
});

afterEach(() => vi.useRealTimers());

describe("P1", () => {
  it("S-R14 1 不再跟进 withdraws what was approved for her, so nothing goes out after", async () => {
    const rid = review();
    await approveInConsole(ctx, rid);
    await closeFollowup(ctx, data, fid, { never: false, reason: "其他" });
    expect(row(T.reviews, rid)).toMatchObject({ 状态: ["已撤回"], 处理: ["不发"] });
    expect((await sendApproved(fresh(), { dryRun: false })).sent).toHaveLength(0);
    expect(lark.sent).toHaveLength(0);
    expect(row(T.followups, fid)).toMatchObject({ 阶段: ["结案"], 当前轮到谁: ["无需动作"] });
  });

  it("S-R9 2 mail she sends after an approval holds it and puts it back in front of the reviewer with her new words", async () => {
    const rid = review();
    await approveInConsole(ctx, rid);
    lark.inbox["hello@tafu.me"] = [{ message_id: "new-refusal", from: "audit@example.com", subject: "先不要发体验码，我们暂不合作", date: new Date().toISOString() }];
    lark.bodies["new-refusal"] = "先不要发体验码，我们暂不合作";
    await syncInbox(fresh(), { dryRun: false });
    await data.refresh();
    const card = cards().find((c) => c.id === rid)!;
    expect(card).toMatchObject({ kind: "reply", tag: "同意后她又来信了", seen: "new-refusal" });

    const rep = await sendApproved(fresh(), { dryRun: false });
    expect(rep.sent).toHaveLength(0);
    expect(rep.skipped[0].reason).toMatch(/又来信了/);
    expect(row(T.reviews, rid)["状态"]).toEqual(["待你审核"]);

    // A card from before her mail can't approve over it; one that showed it can.
    await expect(approve(ctx, data, held(), rid, {}, "an-older-mail")).rejects.toThrow("又来信了");
    await approve(ctx, data, held(), rid, {}, "new-refusal");
    expect((await sendApproved(fresh(), { dryRun: false })).sent).toHaveLength(1);
  });

  it("3 a late write-back keeps her newer reply and records the mail at the time it went out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sentAt = new Date("2026-10-26T10:00:00+08:00").getTime();
    vi.setSystemTime(sentAt);
    const rid = review();
    await approveInConsole(ctx, rid);
    const create = lark.json.bind(lark);
    let fail = true;
    lark.json = async (args: string[]) => {
      if (fail && args[1] === "+record-batch-create" && args.includes(T.contacts)) {
        fail = false;
        throw new Error("write failed");
      }
      return create(args);
    };
    expect((await sendApproved(fresh(), { dryRun: false })).failed).toHaveLength(1);

    vi.setSystemTime(sentAt + 2 * 3600_000);
    await ctx.base.update(T.followups, { [fid]: { 当前轮到谁: ["我们"], 最后来信日期: stamp(sentAt + 3600_000, ctx.cfg.timezone) } });
    const rep = await sendApproved(fresh(), { dryRun: false });
    expect(rep.sent[0].kind).toMatch(/补记/);
    expect(lark.sent).toHaveLength(1);
    expect(row(T.followups, fid)["当前轮到谁"]).toEqual(["我们"]);
    expect(lark.table(T.contacts).find((c) => c["方向"]?.[0] === "发出")!["日期"]).toBe(stamp(sentAt, ctx.cfg.timezone));
    expect(row(T.reviews, rid)["状态"]).toEqual(["已执行"]);
  });

  it("4 写信给她 never switches to another mailbox on its own", async () => {
    await ctx.base.update(T.followups, { [fid]: { 联系渠道: ["tafuofficial Gmail"] } });
    await data.refresh();
    await expect(writeMail(ctx, data, held(), fid, "合作", "回复内容")).rejects.toThrow("选一个发信邮箱");
    expect(lark.table(T.reviews)).toHaveLength(0);
    await writeMail(ctx, data, held(), fid, "合作", "回复内容", "mei@tafu.me");
    expect(lark.table(T.reviews).at(-1)!["发送渠道"]).toEqual([ctx.cfg.mailboxes.find((m) => m.address === "mei@tafu.me")!.channel]);
  });
});

describe("P2", () => {
  it("S-R24 6 what is approved while paused waits, and resuming sends it", async () => {
    const rid = review();
    const jobs = new Jobs(ctx);
    await setPaused(ctx, true);
    expect(await approve(ctx, data, jobs, rid, {})).toBeNull();
    expect(row(T.reviews, rid)["处理"]).toEqual(["发／同意"]);
    expect(lark.sent).toHaveLength(0);
    await setPaused(ctx, false);
    sendQueued(jobs);
    await settled(jobs);
    expect(jobs.list[0].state).toBe("做完了");
    expect(lark.sent).toHaveLength(1);
    expect(row(T.reviews, rid)["状态"]).toEqual(["已执行"]);
  });

  it("7 after an unknown result: 确认没发出 lets it be approved and sent again", async () => {
    const rid = review();
    await approveInConsole(ctx, rid);
    lark.failSend = new Error("socket hang up");
    await sendApproved(fresh(), { dryRun: false });
    lark.failSend = null;
    await data.refresh();
    expect(cards().find((c) => c.id === rid)).toMatchObject({ kind: "problem", unknownSend: true });

    await problemRetry(fresh(), rid);
    expect(row(T.reviews, rid)).toMatchObject({ 状态: ["待你审核"], 同意来源: "" });
    await approveInConsole(fresh(), rid);
    expect((await sendApproved(fresh(), { dryRun: false })).sent).toHaveLength(1);
  });

  it("7 after an unknown result: 确认已经发出 records it and it never goes out again", async () => {
    const rid = review();
    await approveInConsole(ctx, rid);
    lark.failSend = new Error("socket hang up");
    await sendApproved(fresh(), { dryRun: false });
    lark.failSend = null;
    await data.refresh();
    await problemSent(fresh(), data, rid);
    expect(row(T.reviews, rid)["状态"]).toEqual(["已执行"]);
    expect(lark.table(T.contacts).filter((c) => c["方向"]?.[0] === "发出")).toHaveLength(1);
    expect(row(T.followups, fid)["当前轮到谁"]).toEqual(["KOL"]);
    row(T.reviews, rid)["状态"] = ["待执行"];
    expect((await sendApproved(fresh(), { dryRun: false })).sent).toHaveLength(0);
    expect(lark.sent).toHaveLength(0);
  });

  it("8 a template waiting for approval is its own card, and approving it puts it to use", async () => {
    const tid = lark.add(T.templates, { 名称: "新邀约", 用途: ["邀约"], 状态: ["待审核"], 主旨: "合作", 正文: "您好" });
    await data.refresh();
    expect(cards().map((c) => c.id)).toContain(`template:${tid}`);
    await decideTemplate(ctx, tid, true);
    expect(row(T.templates, tid)["状态"]).toEqual(["已批准"]);
    expect((await loadTemplates(ctx.base, ctx.cfg)).map((t) => t.name)).toContain("新邀约");
  });

  it("8 approving a 模板审批 item approves the template its title names", async () => {
    const tid = lark.add(T.templates, { 名称: "审核模板", 用途: ["邀约"], 状态: ["待审核"], 主旨: "合作", 正文: "您好" });
    const rid = review({ 类型: ["模板审批"], 审核项: "批准「审核模板」", 发送渠道: ["不发邮件"] });
    await data.refresh();
    expect(cards().find((c) => c.id === rid)!.steps[0].text).toContain("审核模板");
    expect(await approve(ctx, data, held(), rid, {})).toBeNull();
    expect(row(T.templates, tid)["状态"]).toEqual(["已批准"]);
  });

  it("S-E2 9 a late post already asked about waits for the follow-up date", async () => {
    await ctx.base.update(T.followups, { [fid]: { 阶段: ["已约发布"], 约定发布日期: `${addDays(today(ctx.cfg), -3)} 10:00` } });
    await data.refresh();
    expect(cards().some((c) => c.kind === "overdue")).toBe(true);
    await updateFollowup(ctx, data, fid, { 下一步: "问了发布时间，等她回", 下次跟进日期: addDays(today(ctx.cfg), 3), 当前轮到谁: "KOL" });
    await data.refresh();
    expect(cards().some((c) => c.kind === "overdue")).toBe(false);
    await updateFollowup(ctx, data, fid, { 下次跟进日期: today(ctx.cfg) });
    await data.refresh();
    expect(cards().some((c) => c.kind === "overdue")).toBe(true);
  });

  it("10 不用回 takes her off 等我们回 when nothing else is waiting on us", async () => {
    const cid = lark.add(T.contacts, { 方向: ["收到"], 待处理: true, KOL: [{ id: fid }], 日期: stamp(Date.now(), ctx.cfg.timezone) });
    await mailDone(ctx, [cid]);
    await data.refresh();
    expect(row(T.followups, fid)["当前轮到谁"]).toEqual(["KOL"]);
    expect(peopleView(data, ctx.cfg, "wait", today(ctx.cfg)).rows.map((r) => r.id)).not.toContain(fid);
  });

  it("10 不用回 leaves her waiting on us while a reply is still to be decided", async () => {
    review();
    const cid = lark.add(T.contacts, { 方向: ["收到"], 待处理: true, KOL: [{ id: fid }], 日期: stamp(Date.now(), ctx.cfg.timezone) });
    await mailDone(ctx, [cid]);
    expect(row(T.followups, fid)["当前轮到谁"]).toEqual(["我们"]);
  });

  it("11 R-05 writing first to a closed KOL who had answered before opens her followup at 已回复", async () => {
    const before = stamp(Date.now() - 20 * 86_400_000, ctx.cfg.timezone);
    await ctx.base.update(T.followups, { [fid]: { 阶段: ["结案"], 结案原因: ["无回应"], 当前轮到谁: ["无需动作"], 最后来信日期: before } });
    const rid = review();
    await approveInConsole(ctx, rid);
    expect((await sendApproved(fresh(), { dryRun: false })).sent).toHaveLength(1);
    await data.refresh();
    expect(row(T.followups, fid)).toMatchObject({ 阶段: ["已回复"], 当前轮到谁: ["KOL"] });
    expect(row(T.followups, fid)["结案原因"] ?? null).toBeNull();
    expect(String(row(T.followups, fid)["下一步"])).toMatch(/我们又写信了（之前结案：无回应）/);
    expect(row(T.followups, fid)["下次跟进日期"]).toBeTruthy();
    expect(peopleView(data, ctx.cfg, "all", today(ctx.cfg)).rows.map((r) => r.id)).toContain(fid);
  });
});

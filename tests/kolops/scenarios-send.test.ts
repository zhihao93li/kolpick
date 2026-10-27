// Scenarios from docs/behavior.md §7 that go through sending and the TAFU code API.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { problemDone, problemRetry, problemSent } from "../../src/kolops/console/actions.js";
import { ConsoleData } from "../../src/kolops/console/state.js";
import type { Config } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { LarkError } from "../../src/kolops/lark.js";
import { stamp } from "../../src/kolops/ops.js";
import { addProject, setDataApiKey } from "../../src/kolops/projects.js";
import { remind } from "../../src/kolops/remind.js";
import { approveInConsole } from "../../src/kolops/reviews.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { sendApproved } from "../../src/kolops/send.js";
import { FakeLark } from "./fake.js";
import { BASE, seedProject } from "./project.js";

let lark: FakeLark;
let cfg: Config;
let ctx: Ctx;
let fid: string;
let calls: string[];
let api: (url: string) => { status: number; json: object } | Error;

const EXPIRES = "2026-12-08T02:00:00.000Z";
const code = (used = 0) => ({ code: { code: "deer_jay", found: true, kind: "trial", maxUses: 3, used, expiresAt: EXPIRES } });
const row = (table: string, id: string) => lark.table(table).find((r) => r.record_id === id)!;
const fresh = () => makeCtx(cfg, lark, ctx.me, "", false, async () => {});

function review(fields: Record<string, unknown> = {}) {
  return lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"],
    收件人: "deer@example.com", KOL: [{ id: fid }], 审核项: "发体验码给小鹿", 体验码动作: ["发码"],
    邮件草稿: "小鹿您好：\n\n體驗碼是 {體驗碼}，可以用 {次數} 次，{到期日}前有效。", ...fields });
}

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  cfg = { ...seedProject(lark), dataApi: "https://api.example.com/api/kol-data" };
  addProject("测试项目", BASE);
  setDataApiKey("测试项目", "write-key", "trialKey");
  const pid = lark.add(T.profiles, { 账号: "@deer_jay", 账号名称: "小鹿", 称呼: "小鹿", 公开邮箱: "deer@example.com", 联系许可: ["可联系"] });
  fid = lark.add(T.followups, { 账号名称: "小鹿", 档案: [{ id: pid }], 阶段: ["已回复"], 当前轮到谁: ["我们"], 联系渠道: ["hello@tafu.me"] });
  // Her mail the replies answer, so they thread under it.
  lark.inbox["hello@tafu.me"] = [{ message_id: "in1", from: "小鹿 <deer@example.com>", subject: "Re: 合作", date: "2026-10-24T22:14:00+08:00" }];
  calls = [];
  api = (url) => (url.endsWith("/extend") ? { status: 200, json: code(1) } : { status: 201, json: { created: true, ...code() } });
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const r = api(url);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), { status: r.status });
  });
  ctx = makeCtx(cfg, lark, { id: "ou", name: "林运营" }, "发出已批准的信", false, async () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("7.4 码的收口", () => {
  it("S-D1 an approved 发码 that sends no mail still makes the code and writes it onto the followup", async () => {
    const rid = review({ 类型: ["决定"], 发送渠道: ["不发邮件"], 邮件草稿: "" });
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.codes).toEqual(["小鹿"]);
    expect(calls).toHaveLength(1);
    expect(lark.sent).toHaveLength(0);
    expect(row(T.followups, fid)).toMatchObject({ 体验码: "deer_jay", 阶段: ["体验中"] });
    expect(row(T.reviews, rid)["状态"]).toEqual(["已执行"]);
  });

  it("S-D2 the code made and the mail then failing: the code is on the followup and is not made again", async () => {
    const rid = review();
    lark.failSend = new LarkError("lark-cli mail +send 失败：{\"code\":1234}", true);
    const first = await sendApproved(ctx, { dryRun: false });
    expect(first.failed).toHaveLength(1);
    expect(row(T.followups, fid)["体验码"]).toBe("deer_jay");

    lark.failSend = null;
    await problemRetry(ctx, rid);
    await approveInConsole(ctx, rid);
    const again = await sendApproved(fresh(), { dryRun: false });
    expect(again.sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("S-D3 the code made and the mail's result unknown: confirming it went out records it and sends nothing more", async () => {
    const rid = review();
    lark.failSend = new LarkError("连接断开", false);
    await sendApproved(ctx, { dryRun: false });
    expect(row(T.reviews, rid)["执行结果"]).toMatch(/结果不明/);
    expect(row(T.followups, fid)["体验码"]).toBe("deer_jay");

    lark.failSend = null;
    const data = new ConsoleData(ctx);
    await data.refresh();
    await problemSent(ctx, data, rid);
    expect(row(T.reviews, rid)["状态"]).toEqual(["已执行"]);
    expect((await sendApproved(fresh(), { dryRun: false })).sent).toHaveLength(0);
    expect(lark.sent).toHaveLength(0);
  });

  it("S-D4 a code made by hand in the back office is filled in when confirming the mail went out", async () => {
    const rid = review({ 状态: ["执行失败"], 执行结果: "发送结果不明：超时" });
    const data = new ConsoleData(ctx);
    await data.refresh();
    await problemSent(ctx, data, rid, "deer_manual");
    expect(row(T.followups, fid)["体验码"]).toBe("deer_manual");
    expect(row(T.reviews, rid)["执行结果"]).toMatch(/码 deer_manual 已记到跟进/);
  });
});

describe("7.7 结果不明", () => {
  it("S-R17 an extension that times out is unknown, and is not tried again until someone checks and re-approves", async () => {
    lark.table(T.followups)[0]["体验码"] = "deer_jay";
    const rid = review({ 体验码动作: ["延期"], 体验码: "deer_jay", 体验天数: 7, 邮件草稿: "小鹿您好：\n\n延到 {到期日}。" });
    api = () => new Error("fetch failed: socket hang up");
    await sendApproved(ctx, { dryRun: false });
    expect(row(T.reviews, rid)).toMatchObject({ 状态: ["执行失败"] });
    expect(row(T.reviews, rid)["执行结果"]).toMatch(/结果不明/);
    expect(calls).toHaveLength(1);

    // Approved again without anyone saying it didn't happen: still not tried.
    lark.table(T.reviews).find((r) => r.record_id === rid)!["状态"] = ["待执行"];
    await sendApproved(fresh(), { dryRun: false });
    expect(calls).toHaveLength(1);

    // Someone checked the back office: not extended. Now it may run.
    lark.table(T.reviews).find((r) => r.record_id === rid)!["状态"] = ["执行失败"];
    api = () => ({ status: 200, json: code(1) });
    await problemRetry(ctx, rid);
    await approveInConsole(ctx, rid);
    await sendApproved(fresh(), { dryRun: false });
    expect(calls).toHaveLength(2);
  });

  it("S-R11 an automatic reminder whose result is unknown gets a 出了问题 card; confirming it counts as a reminder", async () => {
    const DAY = 86_400_000;
    lark.table(T.followups)[0] = { ...lark.table(T.followups)[0], 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 级别: ["B"],
      首次邀约日期: stamp(Date.now() - 2 * DAY, "+08:00"), 下次跟进日期: stamp(Date.now(), "+08:00") };
    lark.inbox["hello@tafu.me"] = [];
    lark.failSend = new LarkError("连接断开", false);
    const remindCtx = makeCtx(cfg, lark, ctx.me, "催信和结案", true, async () => {});
    await remind(remindCtx, { dryRun: false });
    const card = lark.table(T.reviews).find((r) => String(r["审核项"]).startsWith("[催信]"))!;
    expect(card).toMatchObject({ 状态: ["执行失败"], KOL: [{ id: fid }] });
    expect(card["执行结果"]).toMatch(/结果不明/);

    lark.failSend = null;
    const data = new ConsoleData(ctx);
    await data.refresh();
    await problemSent(ctx, data, card.record_id);
    const out = lark.table(T.contacts).filter((c) => c["方向"]?.[0] === "发出");
    expect(out.map((c) => String(c["摘要"]))).toEqual([expect.stringMatching(/^\[催信\]/)]);
    expect(lark.sent).toHaveLength(0);
  });
});

describe("评审补的场景", () => {
  it("I-5 a 5xx from the extend API is unknown, not a refusal", async () => {
    lark.table(T.followups)[0]["体验码"] = "deer_jay";
    const rid = review({ 体验码动作: ["延期"], 体验码: "deer_jay", 体验天数: 7, 邮件草稿: "小鹿您好：\n\n延到 {到期日}。" });
    api = () => ({ status: 502, json: { error: "BAD_GATEWAY" } });
    await sendApproved(ctx, { dryRun: false });
    expect(row(T.reviews, rid)["执行结果"]).toMatch(/结果不明/);
    expect(row(T.reviews, rid)["执行结果"]).toMatch(/先到项目后台看到期日/);
  });

  it("C-04 giving up on an automatic reminder of unknown result counts it as sent: never chased twice, never stuck", async () => {
    const DAY = 86_400_000;
    lark.table(T.followups)[0] = { ...lark.table(T.followups)[0], 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 级别: ["B"],
      首次邀约日期: stamp(Date.now() - 2 * DAY, "+08:00"), 下次跟进日期: stamp(Date.now(), "+08:00") };
    lark.inbox["hello@tafu.me"] = [];
    lark.failSend = new LarkError("连接断开", false);
    const routine = () => makeCtx(cfg, lark, ctx.me, "催信和结案", true, async () => {});
    await remind(routine(), { dryRun: false });
    const card = lark.table(T.reviews).find((r) => String(r["审核项"]).startsWith("[催信]"))!;
    lark.failSend = null;
    const data = new ConsoleData(ctx);
    await data.refresh();
    await problemDone(ctx, data, card.record_id);
    expect(lark.table(T.contacts).filter((c) => String(c["摘要"]).startsWith("[催信]"))).toHaveLength(1);
    const again = await remind(routine(), { dryRun: false });
    expect(again.send.sent).toHaveLength(0);
    expect(lark.sent).toHaveLength(0);
  });

  it("C-12 approving a reply leaves a bounce waiting for a new address alone", async () => {
    lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], 摘要: "[退信] deer@example.com", 待处理: true, KOL: [{ id: fid }], 日期: stamp(Date.now(), "+08:00") });
    const rid = review({ 体验码动作: [], 邮件草稿: "主题：回覆\n謝謝" });
    await approveInConsole(ctx, rid);
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(1);
    expect(lark.table(T.contacts).find((c) => String(c["摘要"]).startsWith("[退信]"))!["待处理"]).toBe(true);
  });

  it("an older approved decision with nothing to do is marked done by the next send", async () => {
    const id = lark.add(T.reviews, { 类型: ["决定"], 状态: ["待你审核"], 处理: ["发／同意"], 发送渠道: ["不发邮件"], 审核项: "老的决定", KOL: [{ id: fid }] });
    await sendApproved(ctx, { dryRun: false });
    expect(row(T.reviews, id)["状态"]).toEqual(["已执行"]);
  });
});

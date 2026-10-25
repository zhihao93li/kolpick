import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { applyInbox, listInbox, ownWords } from "../../src/kolops/inbox.js";
import { sendApproved } from "../../src/kolops/send.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let ctx: Ctx;
let pid: string, fid: string, c1: string, c2: string, c3: string;
const dir = () => mkdtempSync(join(tmpdir(), "kol-test-"));

function decisions(list: unknown[]): string {
  const file = join(dir(), "d.json");
  writeFileSync(file, JSON.stringify(list));
  return file;
}

beforeEach(() => {
  process.env.KOL_DATA_DIR = dir();
  lark = new FakeLark();
  const cfg = seedProject(lark);
  pid = lark.add(T.profiles, { 账号: "deer_jay", 账号名称: "小鹿與阿哲", 公开邮箱: "deer@example.com", 联系许可: ["可联系"] });
  fid = lark.add(T.followups, { 账号名称: "小鹿與阿哲", 档案: [{ id: pid }], 阶段: ["已邀约"], 联系渠道: ["hello@tafu.me"], 当前轮到谁: ["我们"] });
  lark.inbox["hello@tafu.me"] = [
    { message_id: "m1", from: "小鹿 <deer@example.com>", subject: "Re: 想送您一份合盤", date: "2026-10-24T10:00:00+08:00" },
    { message_id: "m2", from: "小鹿 <deer@example.com>", subject: "Re: 想送您一份合盤", date: "2026-10-24T11:00:00+08:00" },
  ];
  lark.bodies.m1 = "好啊，想試試看！\n\nTAFU <hello@tafu.me> 於 2026年10月22日 週四 上午10:00 寫道：\n> 想送您 3 次免費體驗";
  lark.bodies.m2 = "謝謝，先不用了 On Thu, Oct 22, 2026 at 10:00 AM TAFU wrote: 想送您";
  const mail = (id: string, date: string) => lark.add(T.contacts, { 方向: ["收到"], 渠道: ["hello@tafu.me"], "Message ID": id, 摘要: "Re: 想送您一份合盤", 日期: date, 待处理: true, KOL: [{ id: fid }] });
  c1 = mail("m1", "2026-10-24 10:00");
  c2 = mail("m2", "2026-10-24 11:00");
  c3 = lark.add(T.contacts, { 方向: ["收到"], 渠道: ["IG 私信"], 摘要: "IG 来信", 日期: "2026-10-24 12:00", 待处理: true });
  ctx = makeCtx(cfg, lark, { id: "ou_me", name: "测试运营" }, "批量处理来信", false, async () => {});
});

it("keeps only the KOL's own words", () => {
  expect(ownWords(lark.bodies.m1)).toBe("好啊，想試試看！");
  expect(ownWords(lark.bodies.m2)).toBe("謝謝，先不用了");
  expect(ownWords("Hi\n> quoted")).toBe("Hi");
  expect(ownWords("可以嗎？感謝 <hello@tafu.me>於 2026年10月5日週一，晚上7:56寫道： 范周這一家 您好")).toBe("可以嗎？感謝");
});

it("lists pending mail oldest first, with the words, the followup and a code name", async () => {
  const r = await listInbox(ctx, { limit: 30 });
  expect(r.待处理总数).toBe(3);
  expect(r.来信.map((x) => x.contact)).toEqual([c1, c2, c3]);
  expect(r.来信[0]).toMatchObject({ kol: "小鹿與阿哲", 阶段: "已邀约", from: "deer@example.com", 内容: "好啊，想試試看！", 插件能回: true, 建议码名: "deer_jay" });
  expect(r.来信[2]).toMatchObject({ 插件能回: false, kol: "（没关联跟进）" });
  expect(r.之后已回过信).toBe(0);

  // A mail we sent after the first one marks it as probably answered by hand.
  lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 日期: "2026-10-24 10:30", KOL: [{ id: fid }] });
  const again = await listInbox(ctx, { limit: 30 });
  expect(again.来信.map((x) => x.之后回过信)).toEqual(["2026-10-24 10:30", null, null]);
});

it("writes nothing when any decision is wrong", async () => {
  const r = await applyInbox(ctx, { dryRun: false, file: decisions([
    { contact: c1, category: "想体验", draft: "您好，碼是 deer_jay", trial: { action: "发码" } },
    { contact: c2, category: "拒绝" },
    { contact: c3, category: "要回复", draft: "hi" },
  ]) });
  expect(r.写入).toBe(0);
  expect(r.问题).toHaveLength(3);
  expect(r.问题![0]).toMatch(/\{體驗碼\}/);
  expect(r.问题![1]).toMatch(/发后动作/);
  expect(r.问题![2]).toMatch(/没关联跟进/);
  expect(lark.table(T.reviews)).toHaveLength(0);
  expect(lark.table(T.contacts).every((c) => c["待处理"] === true)).toBe(true);
});

it("files the batch for review, unticks the mail and hands the KOL to review", async () => {
  const r = await applyInbox(ctx, { dryRun: false, file: decisions([
    { contact: c1, category: "想体验", draft: "您好！體驗碼 {體驗碼}，{到期日}前可用 {次數} 次。", trial: { action: "发码" }, note: "对方说想试" },
    { contact: c2, category: "拒绝", after: "结案", reason: "拒绝" },
    { contact: c3, category: "不用回" },
  ]) });
  expect(r).toMatchObject({ 写入: 2, 只标为已处理: 1 });
  const [want, no] = lark.table(T.reviews);
  expect(want).toMatchObject({ 类型: ["回复邮件"], 状态: ["待你审核"], 收件人: "deer@example.com", 发送渠道: ["hello@tafu.me"], 体验码动作: ["发码"], KOL: [{ id: fid }] });
  expect(want["审核项"]).toBe("[批量] 想体验 小鹿與阿哲");
  expect(no).toMatchObject({ 类型: ["决定"], 发送渠道: ["不发邮件"], 发后动作: ["结案"], 结案原因: ["拒绝"] });
  expect(lark.table(T.contacts).every((c) => c["待处理"] === false)).toBe(true);
  expect(lark.table(T.followups)[0]["当前轮到谁"]).toEqual(["等你审核"]);

  // Run again: the mails are no longer pending, so nothing is filed twice.
  expect((await applyInbox(ctx, { dryRun: false, file: decisions([{ contact: c1, category: "不用回" }]) })).问题).toHaveLength(1);
});

it("carries out an approved refusal with no mail: closes the followup and, for 永不联系, the profile", async () => {
  await applyInbox(ctx, { dryRun: false, file: decisions([{ contact: c2, category: "拒绝", after: "永不联系", reason: "隐私" }]) });
  const rid = lark.table(T.reviews)[0].record_id;
  Object.assign(lark.table(T.reviews)[0], { 处理: ["发／同意"] });
  const r = await sendApproved(ctx, { dryRun: false });
  expect(r.closed).toEqual(["小鹿與阿哲"]);
  expect(lark.sent).toHaveLength(0);
  expect(lark.table(T.followups)[0]).toMatchObject({ 阶段: ["结案"], 结案原因: ["隐私"], 当前轮到谁: ["无需动作"] });
  expect(lark.table(T.profiles)[0]["联系许可"]).toEqual(["永不联系"]);
  expect(lark.table(T.reviews).find((x) => x.record_id === rid)!["状态"]).toEqual(["已执行"]);
});

it("sends a closing reply first, then closes", async () => {
  await applyInbox(ctx, { dryRun: false, file: decisions([{ contact: c2, category: "拒绝", draft: "了解，謝謝回覆！", after: "结案", reason: "档期" }]) });
  Object.assign(lark.table(T.reviews)[0], { 处理: ["发／同意"] });
  const r = await sendApproved(ctx, { dryRun: false });
  expect(r.sent).toHaveLength(1);
  expect(lark.table(T.followups)[0]).toMatchObject({ 阶段: ["结案"], 结案原因: ["档期"], 当前轮到谁: ["无需动作"] });
  expect(lark.table(T.profiles)[0]["联系许可"]).toEqual(["可联系"]);
});

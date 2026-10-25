import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { LarkError } from "../../src/kolops/lark.js";
import { addProject, setDataApiKey } from "../../src/kolops/projects.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { sendApproved } from "../../src/kolops/send.js";
import { suggestTrialCode } from "../../src/kolops/trial.js";
import { FakeLark } from "./fake.js";
import { BASE, seedProject } from "./project.js";

let lark: FakeLark;
let cfg: Config;
let ctx: Ctx;
let fid: string;
let calls: { url: string; body: any; auth: string }[];
let reply: (url: string, body: any) => { status: number; json: object };

const EXPIRES = "2026-11-08T02:00:00.000Z";
const DRAFT = "{稱呼}您好：\n\n體驗碼是 {體驗碼}，可以用 {次數} 次，{到期日}前有效。";

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  cfg = { ...seedProject(lark), dataApi: "https://api.example.com/api/kol-data" };
  addProject("测试项目", BASE);
  setDataApiKey("测试项目", "write-key", "trialKey");
  const pid = lark.add(T.profiles, { 账号: "@deer_jay", 账号名称: "小鹿與阿哲", 公开邮箱: "deer@example.com", 联系许可: ["可联系"] });
  fid = lark.add(T.followups, { 账号名称: "小鹿與阿哲", 档案: [{ id: pid }], 阶段: ["已回复"], 当前轮到谁: ["我们"], 联系渠道: ["hello@tafu.me"] });
  lark.inbox["hello@tafu.me"] = [{ message_id: "in1", from: "小鹿 <deer@example.com>", subject: "Re: 想送 小鹿 一份合盤", date: "2026-10-24T22:14:00+08:00" }];
  calls = [];
  reply = (url) => url.endsWith("/extend")
    ? { status: 200, json: { code: { code: "deer_jay", found: true, kind: "trial", maxUses: 3, used: 1, expiresAt: EXPIRES } } }
    : { status: 201, json: { created: true, code: { code: "deer_jay", found: true, kind: "trial", maxUses: 3, used: 0, expiresAt: EXPIRES } } };
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, auth: init.headers.Authorization });
    const r = reply(url, body);
    return new Response(JSON.stringify(r.json), { status: r.status });
  });
  ctx = makeCtx(cfg, lark, { id: "ou", name: "钟嫣婷" }, "发出已批准的信", false, async () => {});
});
afterEach(() => vi.unstubAllGlobals());

function review(fields: Record<string, any> = {}) {
  return lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 处理: ["发／同意"], 确认发出: true, 发送渠道: ["hello@tafu.me"],
    收件人: "deer@example.com", KOL: [{ id: fid }], 审核项: "发体验码给小鹿", 体验码动作: ["发码"], 邮件草稿: DRAFT.replace("{稱呼}", "小鹿"), ...fields });
}

it("names a code after the KOL's account", () => {
  expect(suggestTrialCode({ record_id: "p", 账号: "@Yun.San 1208" })).toBe("Yun_San_1208");
  expect(suggestTrialCode({ record_id: "p", 账号: "@幸福" })).toBe("");
});

describe("issuing a trial code with the reply", () => {
  it("creates the code, fills it into the reply, sends it in the KOL's thread and moves the followup to 体验中", async () => {
    const rid = review();
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(1);
    expect(calls).toEqual([{ url: "https://api.example.com/api/kol-data/trial-codes", auth: "Bearer write-key",
      body: { code: "deer_jay", maxUses: 3, days: 14, kolName: "小鹿與阿哲", followupId: fid, operator: "钟嫣婷" } }]);
    const args = lark.sent[0].args;
    expect(args).toContain("+reply");
    expect(args[args.indexOf("--subject") + 1]).toBe("Re: 想送 小鹿 一份合盤");
    expect(args[args.indexOf("--body") + 1]).toContain("體驗碼是 deer_jay，可以用 3 次，2026 年 11 月 8 日 10:00前有效。");
    expect(lark.table(T.followups).find((x) => x.record_id === fid)).toMatchObject({
      阶段: ["体验中"], 体验码: "deer_jay", 体验码上限: 3, 体验码已用: 0, 体验码到期: "2026-11-08 10:00", 当前轮到谁: ["KOL"] });
    expect(lark.table(T.reviews).find((x) => x.record_id === rid)!["状态"]).toEqual(["已执行"]);
  });

  it("dry run says what it would create and touches nothing", async () => {
    review({ 体验次数: 5, 体验天数: 7, 体验码: "deer_vip" });
    const r = await sendApproved(ctx, { dryRun: true });
    expect(r.sent[0].kind).toBe("回复（发码 deer_vip，5 次，7 天）");
    expect(calls).toHaveLength(0);
    expect(lark.sent).toHaveLength(0);
  });

  it("sends nothing when the code can't be made, and says why", async () => {
    reply = () => ({ status: 409, json: { error: "CODE_TAKEN", message: "券码 deer_jay 已存在（不区分大小写），请换一个" } });
    const rid = review();
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.sent).toHaveLength(0);
    expect(r.failed[0].reason).toMatch(/没有办成，这封信没发：券码 deer_jay 已存在/);
    expect(lark.sent).toHaveLength(0);
    expect(lark.table(T.reviews).find((x) => x.record_id === rid)!["状态"]).toEqual(["执行失败"]);
  });

  it("rejects items it can't carry out before touching anything", async () => {
    review({ 体验次数: 11 });
    review({ 邮件草稿: "沒有放碼的回信" });
    review({ 体验码动作: ["延期"] }); // the followup has no 体验码 yet and none was given
    const r = await sendApproved(ctx, { dryRun: false });
    expect(r.skipped.map((x) => x.reason)).toEqual([
      "体验次数 11 超出 1–10", "草稿里没有 {體驗碼}，码建好了也填不进信里", "没写体验码，也没法从账号推出一个"]);
    expect(calls).toHaveLength(0);
  });
});

describe("extending a trial code with the reply", () => {
  it("never extends twice when a retry follows a failed send", async () => {
    lark.table(T.followups).find((x) => x.record_id === fid)!["体验码"] = "deer_jay";
    const rid = review({ 体验码动作: ["延期"], 体验天数: 7, 邮件草稿: "小鹿您好：\n\n體驗碼已延到 {到期日}。" });
    lark.failSend = new LarkError("lark-cli mail +reply 失败：{\"code\":1234}", true);
    const first = await sendApproved(ctx, { dryRun: false });
    expect(first.failed).toHaveLength(1);
    expect(calls).toHaveLength(1);

    lark.failSend = null;
    lark.table(T.reviews).find((x) => x.record_id === rid)!["状态"] = ["待执行"];
    const again = await sendApproved(ctx, { dryRun: false });
    expect(again.sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://api.example.com/api/kol-data/trial-codes/deer_jay/extend", body: { days: 7, operator: "钟嫣婷" } });
    expect(lark.table(T.followups).find((x) => x.record_id === fid)!["下一步"]).toMatch(/延期到 11 月 8 日/);
  });
});

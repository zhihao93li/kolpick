import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configFrom, type Config } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { discountWords, marketFor } from "../../src/kolops/partner.js";
import { addProject, setDataApiKey } from "../../src/kolops/projects.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { sendApproved } from "../../src/kolops/send.js";
import { FakeLark } from "./fake.js";
import { BASE, MAILBOXES, SETTINGS, seedProject } from "./project.js";

let lark: FakeLark;
let cfg: Config;
let ctx: Ctx;
let fid: string;
let calls: { url: string; body: any; auth: string }[];
let reply: () => { status: number; json: object };

const DRAFT = "小鹿您好：\n\n專屬連結 {專屬連結}，粉絲享 {粉絲折扣}；業績看 {帳本連結}（碼 {活動碼}）。";
const CODE = { code: "deer_jay", found: true, kind: "partner", active: true, percentOff: 15,
  refLink: "https://tafu.me/zh-tw?ref=deer_jay", ledgerLink: "https://tafu.me/ledger/tok" };

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  lark = new FakeLark();
  seedProject(lark);
  const settings = { record_id: "set1", ...SETTINGS, 活动码市场: "台湾=TW，大陆=CN，其他=GLOBAL", 业务数据接口: "https://api.example.com/api/kol-data" };
  cfg = configFrom("测试项目", BASE, settings, MAILBOXES.map((m, i) => ({ record_id: `mb${i}`, ...m })));
  addProject("测试项目", BASE);
  setDataApiKey("测试项目", "partner-key", "partnerKey");
  const pid = lark.add(T.profiles, { 账号: "@deer_jay", 账号名称: "小鹿與阿哲", 公开邮箱: "deer@example.com", 联系许可: ["可联系"], 市场: ["台湾"] });
  fid = lark.add(T.followups, { 账号名称: "小鹿與阿哲", 档案: [{ id: pid }], 阶段: ["已看报告"], 当前轮到谁: ["我们"], 联系渠道: ["hello@tafu.me"] });
  lark.inbox["hello@tafu.me"] = [{ message_id: "in1", from: "小鹿 <deer@example.com>", subject: "Re: 合作", date: "2026-10-24T22:14:00+08:00" }];
  calls = [];
  reply = () => ({ status: 201, json: { created: true, code: CODE } });
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const r = reply();
    return new Response(JSON.stringify(r.json), { status: r.status });
  });
  ctx = makeCtx(cfg, lark, { id: "ou", name: "钟嫣婷" }, "发出已批准的信", false, async () => {});
});
afterEach(() => vi.unstubAllGlobals());

function review(fields: Record<string, any> = {}) {
  return lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"],
    收件人: "deer@example.com", KOL: [{ id: fid }], 审核项: "开活动码给小鹿", 体验码动作: ["开活动码"], 邮件草稿: DRAFT, ...fields });
}

it("maps markets and words discounts the way the mails say them", () => {
  expect(marketFor(cfg, "台湾")).toBe("TW");
  expect(marketFor(cfg, "香港")).toBe("GLOBAL");
  expect(discountWords(15)).toBe("85 折");
  expect(discountWords(20)).toBe("8 折");
});

it("opens the campaign, fills the links into the reply and records them on the followup", async () => {
  review();
  const r = await sendApproved(ctx, { dryRun: false });
  expect(r.sent).toHaveLength(1);
  expect(calls).toEqual([{ url: "https://api.example.com/api/kol-data/partner-codes", auth: "Bearer partner-key",
    body: { code: "deer_jay", partnerName: "小鹿與阿哲", contact: "deer@example.com", market: "TW", percentOff: 15, followupId: fid, operator: "钟嫣婷" } }]);
  const body = lark.sent[0].args[lark.sent[0].args.indexOf("--body") + 1];
  expect(body).toContain("專屬連結 https://tafu.me/zh-tw?ref=deer_jay，粉絲享 85 折；業績看 https://tafu.me/ledger/tok（碼 deer_jay）");
  expect(lark.table(T.followups).find((x) => x.record_id === fid)).toMatchObject({
    阶段: ["合作中"], 活动码: "deer_jay", 专属连结: CODE.refLink, 账本连结: CODE.ledgerLink, 当前轮到谁: ["KOL"] });
});

it("takes the reviewer's discount, market and page name", async () => {
  review({ 粉丝折扣: 20, 销售市场: "GLOBAL", 合作页名称: "Deer X TAFU", 活动码: "deer2026" });
  const dry = await sendApproved(ctx, { dryRun: true });
  expect(dry.sent[0].kind).toBe("回复（开活动码 deer2026，GLOBAL，粉丝 8 折）");
  await sendApproved(ctx, { dryRun: false });
  expect(calls[0].body).toMatchObject({ code: "deer2026", market: "GLOBAL", percentOff: 20, partnerName: "Deer X TAFU" });
});

it("refuses before sending when the draft has no link, or the KOL already has a campaign", async () => {
  review({ 邮件草稿: "沒有連結" });
  const r = await sendApproved(ctx, { dryRun: false });
  expect(r.skipped[0].reason).toMatch(/\{專屬連結\}/);
  lark.table(T.followups).find((x) => x.record_id === fid)!["活动码"] = "old";
  lark.table(T.reviews)[0]["邮件草稿"] = DRAFT;
  expect((await sendApproved(ctx, { dryRun: false })).skipped[0].reason).toMatch(/已经有活动码「old」/);
  expect(calls).toHaveLength(0);
});

it("sends nothing when the project refuses", async () => {
  reply = () => ({ status: 409, json: { error: "CODE_TAKEN", message: "活动标识 deer_jay 已存在" } });
  review();
  const r = await sendApproved(ctx, { dryRun: false });
  expect(r.failed[0].reason).toMatch(/活动标识 deer_jay 已存在/);
  expect(lark.sent).toHaveLength(0);
});

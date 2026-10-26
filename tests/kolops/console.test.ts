import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays } from "../../src/kolops/base.js";
import { ConsoleData, decisionCards, peopleView, personDetail, cardMails } from "../../src/kolops/console/state.js";
import { startConsole } from "../../src/kolops/console/server.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { stamp, today } from "../../src/kolops/ops.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let ctx: Ctx;
let day = "";
const at = (d: string, hm = "10:00") => `${d} ${hm}`;

beforeEach(() => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-console-"));
  lark = new FakeLark();
  const cfg = seedProject(lark);
  // The seed's unapproved template would be a card of its own in every queue here; it has its own test.
  for (const tpl of lark.table(T.templates)) if (tpl["状态"]?.[0] === "待审核") tpl["状态"] = ["草稿"];
  ctx = makeCtx(cfg, lark, { id: "ou", name: "林运营" }, "", false, async () => {});
  day = today(cfg);
});

function kol(name: string, followup: Record<string, unknown>, profile: Record<string, unknown> = {}) {
  const p = lark.add(T.profiles, { 账号: name, 账号名称: name, 公开邮箱: `${name}@example.com`, 主要平台: ["Instagram"], 粉丝数: 18_000, ...profile });
  const f = lark.add(T.followups, { 账号名称: name, 档案: [{ id: p }], 联系渠道: ["hello@tafu.me"], ...followup });
  lark.table(T.profiles).find((r) => r.record_id === p)!["跟进记录"] = [{ id: f }];
  return { p, f };
}

async function loaded() {
  const data = new ConsoleData(ctx);
  await data.refresh();
  return data;
}

describe("decision queue", () => {
  it("turns a pending review into plain steps, from the code it creates to the mail it sends", async () => {
    const { f } = kol("mika.daily", { 阶段: ["已回复"], 当前轮到谁: ["等你审核"] }, { 称呼: "米卡" });
    lark.add(T.reviews, {
      状态: ["待你审核"], 类型: ["回复邮件"], 审核项: "米卡想先试用", 要你定什么: "给她发体验码，并回信告诉她怎么用", KOL: [{ id: f }],
      发送渠道: ["hello@tafu.me"], 收件人: "mika.daily@example.com", 邮件草稿: "米卡你好：\n\n這是妳的體驗碼。", 体验码动作: ["发码"], 体验码: "MIKADAILY",
    });
    const { cards } = decisionCards(await loaded(), ctx.cfg, day);
    expect(cards).toHaveLength(1);
    const c = cards[0];
    expect(c).toMatchObject({ kind: "reply", group: "回信", headline: "米卡想先试用", suggest: "给她发体验码，并回信告诉她怎么用" });
    expect(c.steps.map((s) => s.text)).toEqual(["在 TAFU 后台建一个体验码", "成功后，从 hello@tafu.me 把下面这封信发给 mika.daily@example.com"]);
    expect(c.steps[0].params).toEqual([{ label: "码名", value: "MIKADAILY", field: "体验码" }, { label: "能用几次", value: "3", field: "体验次数" }, { label: "几天内有效", value: "14", field: "体验天数" }]);
    expect(c.draft?.body).toContain("這是妳的體驗碼");
  });

  it("puts failures first and shows a pending mail only when no review already covers that KOL", async () => {
    const a = kol("chen.family", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    const b = kol("lin.talks", { 阶段: ["已回复"], 当前轮到谁: ["等你审核"] });
    const c = kol("hsu.notes", { 阶段: ["体验中"], 当前轮到谁: ["我们"] });
    lark.add(T.contacts, { 方向: ["收到"], 待处理: true, 渠道: ["hello@tafu.me"], "Message ID": "m1", 摘要: "Re: 合作邀約", 日期: at(addDays(day, -4)), KOL: [{ id: a.f }] });
    lark.add(T.contacts, { 方向: ["收到"], 待处理: true, 渠道: ["hello@tafu.me"], "Message ID": "m2", 摘要: "Re: 合作邀約", 日期: at(day), KOL: [{ id: b.f }] });
    lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 审核项: "林小姐只接固定费", KOL: [{ id: b.f }], 邮件草稿: "林小姐您好", 发送渠道: ["hello@tafu.me"] });
    lark.add(T.reviews, { 状态: ["执行失败"], 类型: ["回复邮件"], 审核项: "延期", KOL: [{ id: c.f }], 执行时间: at(addDays(day, -1)), 执行结果: "TAFU：今天的改动额度满了" });
    lark.bodies.m1 = "想了解一下合作方式";

    const data = await loaded();
    const { cards } = decisionCards(data, ctx.cfg, day, await cardMails(ctx, data));
    expect(cards.map((x) => x.kind)).toEqual(["problem", "reply", "mail"]);
    expect(cards[0].why).toBe("TAFU：今天的改动额度满了");
    expect(cards[1].mail?.text).toBe(undefined);
    expect(cards[2]).toMatchObject({ headline: "@chen.family 来信，已经 4 天没人回了" });
    expect(cards[2].mail?.text).toBe("想了解一下合作方式");
  });

  it("puts one KOL's unanswered mails on one card", async () => {
    const a = kol("chen.family", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    const m1 = lark.add(T.contacts, { 方向: ["收到"], 待处理: true, 渠道: ["hello@tafu.me"], 摘要: "第一封", 日期: at(addDays(day, -3)), KOL: [{ id: a.f }] });
    const m2 = lark.add(T.contacts, { 方向: ["收到"], 待处理: true, 渠道: ["hello@tafu.me"], 摘要: "第二封", 日期: at(day), KOL: [{ id: a.f }] });
    const { cards } = decisionCards(await loaded(), ctx.cfg, day);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: `mail:${m1},${m2}`, headline: "@chen.family 来信（2 封），已经 3 天没人回了" });
    expect(cards[0].mail?.label).toContain("第二封");
  });

  it("shows mail from an unknown sender and from a closed KOL for what they are", async () => {
    const closed = kol("gone", { 阶段: ["结案"], 结案原因: ["无回应"] });
    lark.add(T.contacts, { 方向: ["收到"], 待处理: true, 渠道: ["hello@tafu.me"], 摘要: "合作", 内容: "发件人：agent@mcn.tw", 日期: at(day) });
    lark.add(T.contacts, { 方向: ["收到"], 待处理: true, 渠道: ["hello@tafu.me"], 摘要: "我回來了", 日期: at(day), KOL: [{ id: closed.f }] });
    const { cards } = decisionCards(await loaded(), ctx.cfg, day);
    expect(cards.map((c) => [c.kind, c.tag])).toEqual([["unknown", "对不上人"], ["mail", "之前已结案"]]);
    expect(cards[0].headline).toBe("agent@mcn.tw 来信，对不上任何 KOL");
    expect(cards[1].headline).toContain("又来信了（之前已结案：无回应）");
  });

  it("raises an agreed post that is two days late", async () => {
    kol("moon.notes", { 阶段: ["已约发布"], 约定发布日期: at(addDays(day, -3)), 活动码: "moonnotes" });
    kol("workday.wen", { 阶段: ["已约发布"], 约定发布日期: at(addDays(day, -1)) });
    const { cards } = decisionCards(await loaded(), ctx.cfg, day);
    expect(cards.map((x) => x.headline)).toEqual([expect.stringContaining("过了 3 天还没找到帖子")]);
    expect(cards[0].why).toContain("moonnotes");
    expect(cards[0].draft).toMatchObject({ subject: "想確認一下發布時間", body: expect.stringContaining("專屬活動碼：moonnotes"), note: expect.stringContaining("插件自带") });
  });

  it("fills the check-in mail for a late post from the approved 发布确认 template", async () => {
    kol("moon.notes", { 阶段: ["已约发布"], 约定发布日期: at(addDays(day, -3)), 活动码: "moonnotes" }, { 称呼: "月月" });
    lark.add(T.templates, { 名称: "发布确认", 用途: ["发布确认"], 状态: ["已批准"], 主旨: "發布時間確認", 正文: "{稱呼}妳好：約好 {約定日期} 發布，想確認一下進度。活動碼 {活動碼}" });
    const { cards } = decisionCards(await loaded(), ctx.cfg, day);
    expect(cards[0].draft).toMatchObject({ subject: "發布時間確認", body: expect.stringMatching(/^月月妳好：約好 \d+ 月 \d+ 日 發布.*活動碼 moonnotes$/) });
  });

  it("counts items sent back for rewriting without queueing them", async () => {
    const { f } = kol("a", { 阶段: ["已回复"] });
    lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 处理: ["改"], 审核项: "改一下", KOL: [{ id: f }] });
    const r = decisionCards(await loaded(), ctx.cfg, day);
    expect(r.cards).toEqual([]);
    expect(r.waitingClaude).toBe(1);
  });
});

describe("KOL views", () => {
  it("lists who waits on us, longest wait first, flagging pending decisions", async () => {
    const old = kol("old", { 阶段: ["已回复"], 当前轮到谁: ["我们"], 最后来信日期: at(addDays(day, -5)) });
    const fresh = kol("fresh", { 阶段: ["已回复"], 当前轮到谁: ["等你审核"], 最后来信日期: at(day) });
    kol("theirs", { 阶段: ["已邀约"], 当前轮到谁: ["KOL"] });
    lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 审核项: "x", KOL: [{ id: fresh.f }] });
    const { rows } = peopleView(await loaded(), ctx.cfg, "wait", day);
    expect(rows.map((r) => r.id)).toEqual([old.f, fresh.f]);
    expect(rows[0].cells[1]).toEqual({ v: "5 天", tone: "warn" });
    expect(rows[1].cells[2]).toMatchObject({ v: "等你决定", link: "decide" });
  });

  it("shows trial usage and marks an unused code", async () => {
    kol("t", { 阶段: ["体验中"], 体验码: "T", 体验码已用: 0, 体验码上限: 3, 体验码到期: at(addDays(day, 1)) });
    const { rows } = peopleView(await loaded(), ctx.cfg, "trial", day);
    expect(rows[0].cells[0]).toEqual({ v: "0 / 3 · 还没用", tone: "warn" });
    expect(rows[0].cells[1]).toEqual({ v: "明天", tone: "warn" });
  });

  it("offers only uncontacted profiles with an address and not marked 永不联系", async () => {
    lark.add(T.profiles, { 账号: "new.one", 公开邮箱: "new@example.com", 粉丝数: 9000 });
    lark.add(T.profiles, { 账号: "no.mail" });
    lark.add(T.profiles, { 账号: "blocked", 公开邮箱: "b@example.com", 联系许可: ["永不联系"] });
    kol("taken", { 阶段: ["已邀约"] });
    const { rows, total } = peopleView(await loaded(), ctx.cfg, "pool", day);
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ handle: "@new.one", hasDetail: false });
  });

  it("searches by address", async () => {
    kol("alpha", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    kol("beta", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    const { rows } = peopleView(await loaded(), ctx.cfg, "wait", day, "beta@example");
    expect(rows.map((r) => r.handle)).toEqual(["@beta"]);
  });
});

describe("one KOL", () => {
  it("lays out the conversation with their mails on the left and ours on the right", async () => {
    const { f } = kol("an", { 阶段: ["体验中"], 当前轮到谁: ["KOL"], 体验码: "YOGAAN", 体验码已用: 1, 体验码上限: 3 }, { 称呼: "安安" });
    const c1 = lark.add(T.contacts, { 方向: ["发出"], 渠道: ["mei@tafu.me"], 摘要: "[回复] 體驗碼", 内容: "這是妳的體驗碼", 日期: at(addDays(day, -3)) });
    const c2 = lark.add(T.contacts, { 方向: ["收到"], 渠道: ["mei@tafu.me"], 摘要: "Re: 體驗碼", "Message ID": "m9", 日期: at(addDays(day, -1)) });
    const c3 = lark.add(T.contacts, { 方向: ["收到"], 渠道: ["mei@tafu.me"], 摘要: "[自动回复] 休假中", 日期: at(day) });
    lark.table(T.followups).find((r) => r.record_id === f)!["接触记录"] = [{ id: c3 }, { id: c1 }, { id: c2 }];
    lark.bodies.m9 = "第三段看不懂";

    const p = await personDetail(ctx, await loaded(), f);
    expect(p?.bubbles.map((b) => [b.side, b.text])).toEqual([["us", "這是妳的體驗碼"], ["them", "第三段看不懂"], ["event", "[自动回复] 休假中"]]);
    // Hand-filed records keep their text in 内容 under a 「[分类] …」 summary; archives open to their full text.
    const c4 = lark.add(T.contacts, { 方向: ["收到"], 渠道: ["tafuofficial Gmail"], 摘要: "[问问题] 安安：报告怎么看", 内容: "請問報告怎麼看？", 日期: at(day, "11:00") });
    const c5 = lark.add(T.contacts, { 方向: ["存档"], 摘要: "10/5 前邮件往来存档", 内容: "全部往來……", 日期: at(day, "12:00") });
    const c6 = lark.add(T.contacts, { 方向: ["发出"], 渠道: ["tafuofficial Gmail"], 摘要: "体验跟进 A", 日期: at(day, "13:00") });
    lark.table(T.followups).find((r) => r.record_id === f)!["接触记录"] = [{ id: c1 }, { id: c2 }, { id: c3 }, { id: c4 }, { id: c5 }, { id: c6 }];
    const q = await personDetail(ctx, await loaded(), f);
    expect(q?.bubbles.slice(3)).toEqual([
      expect.objectContaining({ side: "them", who: "安安 · 问问题", text: "請問報告怎麼看？", summaryOnly: false }),
      expect.objectContaining({ side: "event", text: "10/5 前邮件往来存档", full: "全部往來……" }),
      expect.objectContaining({ side: "us", text: "体验跟进 A", summaryOnly: true }),
    ]);
    expect(p).toMatchObject({ name: "安安", stageStep: 2, trial: { code: "YOGAAN", used: 1, max: 3 } });
    expect(p?.situation).toContain("用了 1 / 3 次");
  });
});

describe("the console server", () => {
  it("serves the page and data to this computer only, and refuses writes", async () => {
    kol("a", { 阶段: ["已回复"], 当前轮到谁: ["我们"] });
    const { url, server } = await startConsole(ctx, { port: 0, openBrowser: false });
    try {
      const page = await fetch(url);
      expect(await page.text()).toContain("KOL 决策台");
      const o = await (await fetch(`${url}api/overview`)).json();
      expect(o).toMatchObject({ project: "测试项目", counts: { wait: 1 } });
      expect((await fetch(`${url}api/people?view=nope`)).status).toBe(400);
      expect((await fetch(`${url}api/overview`, { method: "PUT" })).status).toBe(405);
      const port = new URL(url).port;
      // fetch won't let a page set Host, so ask the way a rebinding attack would arrive: same socket, another name.
      const status = await new Promise<number>((resolve, reject) => {
        request({ host: "127.0.0.1", port, path: "/api/overview", headers: { host: `evil.example:${port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on("error", reject).end();
      });
      expect(status).toBe(403);
    } finally {
      server.close();
    }
  });
});

it("stamps dates the way the base does", () => {
  expect(stamp(Date.parse("2026-10-26T02:00:00Z"))).toBe("2026-10-26 10:00");
});

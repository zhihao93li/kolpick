// The settings page (docs/ui.md 4.5): rules, mailboxes, templates and options, written to the tables the commands read.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, decideTemplate, resumeFollowup, setDefaultEmail, updateFollowup, updateProfile, writeMail } from "../../src/kolops/console/actions.js";
import { sendApproved } from "../../src/kolops/send.js";
import { today } from "../../src/kolops/ops.js";
import { approvalProblem, fingerprint } from "../../src/kolops/reviews.js";
import { addOption, changeHistory, disableMailbox, discardTemplate, mailboxPending, readMailboxes, readRules, renameOption, saveMailbox, saveRules, saveTemplate, submitTemplate } from "../../src/kolops/console/settings.js";
import { ConsoleData, decisionCards, syncWarning } from "../../src/kolops/console/state.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { loadTemplates } from "../../src/kolops/templates.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let ctx: Ctx;
let data: ConsoleData;
const row = (table: string, id: string) => lark.table(table).find((r) => r.record_id === id)!;
const settings = () => lark.table(T.settings)[0];

beforeEach(async () => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-settings-"));
  lark = new FakeLark();
  const cfg = seedProject(lark);
  ctx = makeCtx(cfg, lark, { id: "op", name: "林运营" }, "", false, async () => {});
  data = new ConsoleData(ctx);
});

describe("发信规则", () => {
  it("saves changed numbers, logs who changed what, and refuses out-of-range values", async () => {
    expect((await readRules(ctx)).fields.find((f) => f.key === "结案天数")!.value).toBe("7");
    expect(await saveRules(ctx, { 结案天数: "10", 第一次催信天数: "5" })).toBe(1);
    expect(settings()["结案天数"]).toBe(10);
    expect((await changeHistory(ctx, ""))[0]).toMatchObject({ what: "再过几天还没回就结案：7 → 10", who: "林运营" });
    await expect(saveRules(ctx, { 体验码默认次数: "20" })).rejects.toThrow(/不能大于 10/);
    await expect(saveRules(ctx, { 时区: "+09:00" })).rejects.toThrow(/不能在这里改/);
    await expect(saveRules(ctx, { 活动码市场: "台湾" })).rejects.toThrow(/资料市场=销售市场/);
  });
});

describe("发信邮箱", () => {
  it("adds a mailbox with a warm-up, and turns its auto reminders off", async () => {
    await saveMailbox(ctx, "", { 邮箱: "Hi@Tafu.tw", 每日上限: "150", 启用日期: "2026-10-28", 起步上限: "20", 每天增加: "10", 不自动催: true });
    const m = lark.table(T.mailboxes).find((r) => r["邮箱"] === "hi@tafu.tw")!;
    expect(m).toMatchObject({ 渠道名: "hi@tafu.tw", 每日上限: 150, 起步上限: 20, 启用: true });
    expect(String(settings()["不催渠道"])).toMatch(/hi@tafu\.tw/);
    await expect(saveMailbox(ctx, "", { 邮箱: "hi@tafu.tw", 每日上限: "10" })).rejects.toThrow(/已经在/);
  });

  it("an address with mail history can't change", async () => {
    lark.add(T.contacts, { 方向: ["发出"], 渠道: ["hello@tafu.me"], 摘要: "x", 日期: "2026-10-20 10:00" });
    const id = lark.table(T.mailboxes)[0].record_id;
    await expect(saveMailbox(ctx, id, { 邮箱: "new@tafu.me" })).rejects.toThrow(/有往来记录/);
  });

  it("U-5 disabling lists the mail still to go from it; each must move or be withdrawn first", async () => {
    const fid = lark.add(T.followups, { 账号名称: "小鹿", 联系渠道: ["hello@tafu.me"], 阶段: ["已回复"] });
    const a = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: fid }], 收件人: "a@example.com" });
    const b = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 发送渠道: ["hello@tafu.me"], 审核项: "回他", KOL: [{ id: fid }] });
    await data.refresh();
    const id = lark.table(T.mailboxes)[0].record_id;
    expect((await mailboxPending(ctx, data, id)).map((p) => p.state)).toEqual(["已同意，还没发", "待你决定"]);
    await expect(disableMailbox(ctx, data, id, { [a]: { action: "drop" } })).rejects.toThrow(/还有 1 封/);
    await disableMailbox(ctx, data, id, { [a]: { action: "move", to: "mei@tafu.me" }, [b]: { action: "drop" } });
    expect(row(T.reviews, a)).toMatchObject({ 发送渠道: ["mei@tafu.me"], 处理: ["发／同意"] });
    expect(row(T.reviews, b)).toMatchObject({ 状态: ["已撤回"] });
    expect(row(T.mailboxes, id)["启用"]).toBe(false);
    expect((await readMailboxes(ctx)).find((m) => m.id === id)!.enabled).toBe(false);
  });
});

describe("模板", () => {
  it("Q-11 editing an approved template stops it until approved; 放弃草稿 puts the old text back", async () => {
    const id = lark.table(T.templates).find((r) => r["名称"] === "催信-1")!.record_id;
    await saveTemplate(ctx, id, { subject: "新主旨 {稱呼}", body: "{稱呼} 您好，新的寫法" });
    expect(row(T.templates, id)["状态"]).toEqual(["草稿"]);
    expect((await loadTemplates(ctx.base, ctx.cfg)).some((t) => t.name === "催信-1")).toBe(false);
    await discardTemplate(ctx, id);
    expect(row(T.templates, id)).toMatchObject({ 状态: ["已批准"], 主旨: "想送 {稱呼} 3 次免費的完整體驗" });
    expect(String(row(T.templates, id)["备注"] ?? "")).not.toMatch(/编辑前/);
  });

  it("a draft with an unknown placeholder can't be submitted; approving uses the new text", async () => {
    const id = lark.table(T.templates).find((r) => r["名称"] === "催信-1")!.record_id;
    await saveTemplate(ctx, id, { subject: "提醒", body: "{稱呼} 您好，{方向說明}" });
    await expect(submitTemplate(ctx, id)).rejects.toThrow(/\{方向說明\}/);
    await saveTemplate(ctx, id, { subject: "提醒", body: "{稱呼} 您好，再提醒一次" });
    await submitTemplate(ctx, id);
    await decideTemplate(ctx, id, true);
    expect(row(T.templates, id)).toMatchObject({ 状态: ["已批准"], 正文: "{稱呼} 您好，再提醒一次" });
    expect(String(row(T.templates, id)["备注"] ?? "")).not.toMatch(/编辑前/);
  });

  it("turning down an edit of a template in use restores the old text instead of retiring it", async () => {
    const id = lark.table(T.templates).find((r) => r["名称"] === "催信-2")!.record_id;
    await saveTemplate(ctx, id, { subject: "改過", body: "{稱呼} 改過" });
    await submitTemplate(ctx, id);
    await decideTemplate(ctx, id, false);
    expect(row(T.templates, id)).toMatchObject({ 状态: ["已批准"], 正文: "{稱呼} 您好：\n\n這是最後一次打擾。" });
  });

  it("a new template starts as a draft", async () => {
    const id = await saveTemplate(ctx, "", { name: "发布确认-繁", purpose: "发布确认", subject: "確認", body: "{稱呼} 您好，{約定日期} 的貼文" });
    expect(row(T.templates, id)).toMatchObject({ 状态: ["草稿"], 用途: ["发布确认"] });
    await submitTemplate(ctx, id);
    expect(row(T.templates, id)["状态"]).toEqual(["待审核"]);
  });
});

describe("选项", () => {
  it("adds a batch and merges one option into another, moving every record", async () => {
    lark.options["入库批次"] = ["10 月 A", "10 月 B"];
    const p1 = lark.add(T.profiles, { 账号名称: "a", 入库批次: ["10 月 A"] });
    const p2 = lark.add(T.profiles, { 账号名称: "b", 入库批次: ["10 月 B"] });
    await data.refresh();
    await addOption(ctx, "入库批次", "11 月");
    expect(lark.options["入库批次"]).toEqual(["10 月 A", "10 月 B", "11 月"]);
    await expect(addOption(ctx, "入库批次", "11 月")).rejects.toThrow(/已经有了/);
    expect(await renameOption(ctx, data, "入库批次", "10 月 A", "10 月 B")).toBe(1);
    expect(row(T.profiles, p1)["入库批次"]).toEqual(["10 月 B"]);
    expect(row(T.profiles, p2)["入库批次"]).toEqual(["10 月 B"]);
    expect(lark.options["入库批次"]).toEqual(["10 月 B", "11 月"]);
  });
});

describe("KOL 资料", () => {
  it("U-3 edits 资料 in place and makes another address the default", async () => {
    const pid = lark.add(T.profiles, { 账号名称: "小鹿", 公开邮箱: "a@example.com", 其他邮箱: "b@example.com" });
    const fid = lark.add(T.followups, { 账号名称: "小鹿", 档案: [{ id: pid }] });
    await data.refresh();
    await updateProfile(ctx, data, fid, { 称呼: "鹿鹿", 市场: "台湾" });
    expect(row(T.profiles, pid)).toMatchObject({ 称呼: "鹿鹿", 市场: ["台湾"] });
    await expect(updateProfile(ctx, data, fid, { 主页链接: "instagram.com/x" })).rejects.toThrow(/https/);
    await setDefaultEmail(ctx, data, fid, "b@example.com");
    expect(row(T.profiles, pid)).toMatchObject({ 公开邮箱: "b@example.com", 其他邮箱: "a@example.com" });
  });
});

describe("G-3 横幅", () => {
  it("shows what the latest mailbox read left out, and clears once a complete one runs", async () => {
    const now = new Date();
    const at = (min: number) => { const d = new Date(now.getTime() - min * 60_000 + 8 * 3600_000); return d.toISOString().slice(0, 16).replace("T", " "); };
    lark.add(T.runs, { 运行: "收信同步（林运营）", 结果: ["部分完成"], 开始时间: at(30), 问题与备注: "mei@tafu.me 从 10-26 起超过 400 封，只读了一部分。请用 --days 1 分几次补同步" });
    expect((await syncWarning(ctx))[0]).toMatch(/mei@tafu\.me/);
    lark.add(T.runs, { 运行: "收信同步（林运营）", 结果: ["完成"], 开始时间: at(5) });
    expect(await syncWarning(ctx)).toEqual([]);
  });
});

describe("Astra 第二轮审核修的问题", () => {
  const approvedMail = (fid: string, fields: Record<string, unknown> = {}) => {
    const r: Record<string, unknown> = { 类型: ["回复邮件"], 状态: ["待你审核"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: fid }],
      收件人: "a@example.com", 邮件草稿: "主题：好\n好的", 同意来源: "决策台", 同意人: "林运营", 同意时间: "2026-10-27 10:00", ...fields };
    const id = lark.add(T.reviews, r);
    lark.table(T.reviews).find((x) => x.record_id === id)!["内容指纹"] = fingerprintOf(id);
    return id;
  };
  const fingerprintOf = (id: string) => fingerprint(row(T.reviews, id));

  it("#2 moving an approval that no longer holds sends it back; one that holds keeps its approver and time", async () => {
    const f1 = lark.add(T.followups, { 账号名称: "甲", 联系渠道: ["hello@tafu.me"] });
    const f2 = lark.add(T.followups, { 账号名称: "乙", 联系渠道: ["hello@tafu.me"] });
    const ok = approvedMail(f1);
    const changed = approvedMail(f2);
    row(T.reviews, changed)["邮件草稿"] = "主题：好\n改过了，没人看过";
    await data.refresh();
    const id = lark.table(T.mailboxes)[0].record_id;
    await disableMailbox(ctx, data, id, { [ok]: { action: "move", to: "mei@tafu.me" }, [changed]: { action: "move", to: "mei@tafu.me" } });
    expect(row(T.reviews, ok)).toMatchObject({ 发送渠道: ["mei@tafu.me"], 处理: ["发／同意"], 同意时间: "2026-10-27 10:00" });
    expect(approvalProblem(ctx.cfg, row(T.reviews, ok))).toBeNull();
    expect(row(T.reviews, changed)).toMatchObject({ 发送渠道: ["mei@tafu.me"], 状态: ["待你审核"] });
    expect(row(T.reviews, changed)["处理"] ?? null).toBeNull();
  });

  it("#2 she wrote after the approval: moving sends it back for review", async () => {
    const f = lark.add(T.followups, { 账号名称: "甲", 联系渠道: ["hello@tafu.me"] });
    const id = approvedMail(f);
    lark.add(T.contacts, { 方向: ["收到"], 待处理: true, KOL: [{ id: f }], 摘要: "等等", 日期: "2026-10-27 11:00" });
    await data.refresh();
    await disableMailbox(ctx, data, lark.table(T.mailboxes)[0].record_id, { [id]: { action: "move", to: "mei@tafu.me" } });
    expect(row(T.reviews, id)["处理"] ?? null).toBeNull();
  });

  it("#4 a mail being sent or with an unknown result blocks the switch-off", async () => {
    const f = lark.add(T.followups, { 账号名称: "甲", 联系渠道: ["hello@tafu.me"] });
    const a = approvedMail(f, { 状态: ["待执行"], 执行结果: "执行中（林运营 10:00）" });
    await data.refresh();
    const mb = lark.table(T.mailboxes)[0].record_id;
    expect((await mailboxPending(ctx, data, mb))[0].stuck).toMatch(/正在执行/);
    await expect(disableMailbox(ctx, data, mb, { [a]: { action: "drop" } })).rejects.toThrow(/不能换邮箱或撤掉/);
    expect(row(T.reviews, a)["状态"]).toEqual(["待执行"]);
  });

  it("#3 a 渠道名 can't be another mailbox's name or address, nor change while in use", async () => {
    const [hello, mei] = lark.table(T.mailboxes);
    await expect(saveMailbox(ctx, hello.record_id, { 渠道名: "mei@tafu.me" })).rejects.toThrow(/另一个发信邮箱/);
    lark.add(T.followups, { 账号名称: "甲", 联系渠道: ["mei@tafu.me"] });
    await expect(saveMailbox(ctx, mei.record_id, { 渠道名: "梅" })).rejects.toThrow(/不能改/);
  });

  it("#6 a rename reads records afresh: one changed since the page loaded isn't overwritten", async () => {
    lark.options["内容类型"] = ["A", "B", "C"];
    const p = lark.add(T.profiles, { 账号名称: "a", 内容类型: ["A"] });
    await data.refresh();
    row(T.profiles, p)["内容类型"] = ["C"];
    const q = lark.add(T.profiles, { 账号名称: "b", 内容类型: ["A"] });
    expect(await renameOption(ctx, data, "内容类型", "A", "B")).toBe(1);
    expect(row(T.profiles, p)["内容类型"]).toEqual(["C"]);
    expect(row(T.profiles, q)["内容类型"]).toEqual(["B"]);
  });

  it("#7 approving pins the code defaults shown on the card, so a later settings change can't alter them", async () => {
    const pid = lark.add(T.profiles, { 账号名称: "deer", 账号: "deer_lu", 公开邮箱: "a@example.com" });
    const f = lark.add(T.followups, { 账号名称: "deer", 档案: [{ id: pid }], 联系渠道: ["hello@tafu.me"] });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 发送渠道: ["hello@tafu.me"], 收件人: "a@example.com", 审核项: "发码", KOL: [{ id: f }],
      邮件草稿: "主题：碼\n{體驗碼}", 体验码动作: ["发码"] });
    await data.refresh();
    const held = { add: () => ({ id: 1, what: "", person: "", state: "排队中", note: "", at: 0 }) } as any;
    await approve(ctx, data, held, id, {});
    expect(row(T.reviews, id)).toMatchObject({ 体验码: "deer_lu", 体验次数: ctx.cfg.trial.maxUses, 体验天数: ctx.cfg.trial.days });
    expect(approvalProblem(ctx.cfg, row(T.reviews, id))).toBeNull();
  });

  it("#10 a note added after the kept version doesn't lose it; a mangled one is an error, not a retirement", async () => {
    const id = lark.table(T.templates).find((r) => r["名称"] === "催信-1")!.record_id;
    await saveTemplate(ctx, id, { subject: "新", body: "{稱呼} 新" });
    row(T.templates, id)["备注"] = `${row(T.templates, id)["备注"]}\n运营补充：下周再看`;
    await discardTemplate(ctx, id);
    expect(row(T.templates, id)).toMatchObject({ 状态: ["已批准"], 主旨: "想送 {稱呼} 3 次免費的完整體驗" });
    expect(row(T.templates, id)["备注"]).toBe("运营补充：下周再看");
    await saveTemplate(ctx, id, { subject: "又改", body: "{稱呼} 又改" });
    row(T.templates, id)["备注"] = String(row(T.templates, id)["备注"]).replace("{", "");
    await expect(discardTemplate(ctx, id)).rejects.toThrow(/读不出来/);
    expect(row(T.templates, id)["状态"]).toEqual(["草稿"]);
  });

  it("#11 the bundled 发活动码 template's placeholders are accepted", async () => {
    const raw = readFileSync(join(process.cwd(), "plugins/kol-ops/templates/发活动码.txt"), "utf8");
    const id = await saveTemplate(ctx, "", { name: "发活动码", purpose: "发活动码", subject: "活動", body: raw });
    await submitTemplate(ctx, id);
    expect(row(T.templates, id)["状态"]).toEqual(["待审核"]);
  });

  it("#12 editing 下一步 while paused keeps the stage it paused from; pausing again doesn't lose it", async () => {
    const fid = lark.add(T.followups, { 账号名称: "甲", 阶段: ["合作中"] });
    await data.refresh();
    await updateFollowup(ctx, data, fid, { 阶段: "暂缓" });
    await data.refresh();
    await updateFollowup(ctx, data, fid, { 下一步: "下个月联系" });
    await data.refresh();
    await updateFollowup(ctx, data, fid, { 阶段: "暂缓", 下一步: "还是等等" });
    await data.refresh();
    expect(await resumeFollowup(ctx, data, fid)).toBe("合作中");
  });

  it("浏览器测试 #1 pausing and resuming keep what 下一步 said", async () => {
    const fid = lark.add(T.followups, { 账号名称: "甲", 阶段: ["合作中"], 下一步: "等她排档期" });
    await data.refresh();
    await updateFollowup(ctx, data, fid, { 阶段: "暂缓" });
    expect(row(T.followups, fid)["下一步"]).toBe("等她排档期（暂缓前：合作中）");
    await data.refresh();
    await resumeFollowup(ctx, data, fid);
    expect(row(T.followups, fid)).toMatchObject({ 阶段: ["合作中"], 下一步: "等她排档期" });
  });

  it("#13 a read that failed outright warns too", async () => {
    const d = new Date(Date.now() + 8 * 3600_000 - 5 * 60_000).toISOString().slice(0, 16).replace("T", " ");
    lark.add(T.runs, { 运行: "收信同步（林运营）", 结果: ["失败"], 开始时间: d, 问题与备注: "权限不足" });
    expect((await syncWarning(ctx))[0]).toMatch(/收信同步失败.*权限不足/);
  });
});

describe("Astra 复审修的问题", () => {
  const held = () => ({ add: () => ({ id: 1, what: "", person: "", state: "排队中", note: "", at: 0 }) }) as any;

  it("P1-1 an item this computer noted as maybe sent is neither withdrawn nor moved when its mailbox is switched off", async () => {
    const f = lark.add(T.followups, { 账号名称: "甲", 联系渠道: ["hello@tafu.me"] });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: f }] });
    ctx.journal.mark(`review:${id}`, "unknown");
    await data.refresh();
    const mb = lark.table(T.mailboxes)[0].record_id;
    expect((await mailboxPending(ctx, data, mb))[0].stuck).toMatch(/结果不明/);
    await expect(disableMailbox(ctx, data, mb, { [id]: { action: "drop" } })).rejects.toThrow(/不能换邮箱或撤掉/);
    expect(row(T.reviews, id)["状态"]).toEqual(["待你审核"]);
  });

  it("P2-9 a decision that sends no mail isn't on the switch-off list", async () => {
    const f = lark.add(T.followups, { 账号名称: "甲", 联系渠道: ["hello@tafu.me"] });
    lark.add(T.reviews, { 类型: ["决定"], 状态: ["待你审核"], 审核项: "要不要再送一次", KOL: [{ id: f }] });
    await data.refresh();
    expect(await mailboxPending(ctx, data, lark.table(T.mailboxes)[0].record_id)).toEqual([]);
  });

  it("P1-2 a mailbox with mail waiting can't change address, and an address can't be another mailbox's 渠道名", async () => {
    const [hello, mei] = lark.table(T.mailboxes);
    const f = lark.add(T.followups, { 账号名称: "甲" });
    lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: f }] });
    await expect(saveMailbox(ctx, hello.record_id, { 邮箱: "other@tafu.me" })).rejects.toThrow(/不能改地址/);
    mei["渠道名"] = "梅姐";
    await expect(saveMailbox(ctx, "", { 邮箱: "梅姐@tafu.me", 渠道名: "x@tafu.me", 每日上限: "10" })).resolves.toBeTruthy();
    await expect(saveMailbox(ctx, "", { 邮箱: "y@tafu.me", 渠道名: "梅姐", 每日上限: "10" })).rejects.toThrow(/另一个发信邮箱/);
  });

  it("P1-3 approving checks the card's version: a default changed after the card was shown asks to look again", async () => {
    const pid = lark.add(T.profiles, { 账号名称: "deer", 账号: "deer_lu", 公开邮箱: "a@example.com" });
    const f = lark.add(T.followups, { 账号名称: "deer", 档案: [{ id: pid }], 联系渠道: ["hello@tafu.me"] });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 发送渠道: ["hello@tafu.me"], 收件人: "a@example.com", 审核项: "发码", KOL: [{ id: f }],
      邮件草稿: "主题：碼\n{體驗碼}", 体验码动作: ["发码"] });
    await data.refresh();
    const card = decisionCards(data, ctx.cfg, today(ctx.cfg)).cards.find((c) => c.id === id)!;
    ctx.cfg.trial.maxUses = 9;
    await expect(approve(ctx, data, held(), id, {}, undefined, card.shown)).rejects.toThrow(/刷新/);
    ctx.cfg.trial.maxUses = 3;
    await approve(ctx, data, held(), id, {}, undefined, card.shown);
    expect(row(T.reviews, id)["体验次数"]).toBe(3);
  });

  it("P1-3 a template card approves only the version it showed; P2-7 a mangled kept version stops the approval", async () => {
    const id = lark.table(T.templates).find((r) => r["名称"] === "催信-1")!.record_id;
    await saveTemplate(ctx, id, { subject: "新", body: "{稱呼} 新" });
    await submitTemplate(ctx, id);
    await data.refresh();
    const card = decisionCards(data, ctx.cfg, today(ctx.cfg)).cards.find((c) => c.id === `template:${id}`)!;
    row(T.templates, id)["正文"] = "{稱呼} 又被改了";
    await expect(decideTemplate(ctx, id, true, card.shown)).rejects.toThrow(/又被改过/);
    row(T.templates, id)["备注"] = String(row(T.templates, id)["备注"]).replace("{", "");
    await expect(decideTemplate(ctx, id, true)).rejects.toThrow(/读不出来/);
    expect(row(T.templates, id)["状态"]).toEqual(["待审核"]);
  });

  it("P1-6 resuming reads her now: one closed meanwhile isn't reopened; a default switch keeps an address added meanwhile", async () => {
    const pid = lark.add(T.profiles, { 账号名称: "甲", 公开邮箱: "a@example.com", 其他邮箱: "b@example.com" });
    const fid = lark.add(T.followups, { 账号名称: "甲", 档案: [{ id: pid }], 阶段: ["暂缓"], 下一步: "x（暂缓前：合作中）" });
    await data.refresh();
    row(T.followups, fid)["阶段"] = ["结案"];
    await expect(resumeFollowup(ctx, data, fid)).rejects.toThrow(/不是暂缓/);
    row(T.profiles, pid)["其他邮箱"] = "b@example.com, c@example.com";
    await setDefaultEmail(ctx, data, fid, "b@example.com");
    expect(row(T.profiles, pid)).toMatchObject({ 公开邮箱: "b@example.com", 其他邮箱: "a@example.com, c@example.com" });
  });

  it("I-1 two writes to the same KOL at once make only one mail", async () => {
    const pid = lark.add(T.profiles, { 账号名称: "甲", 公开邮箱: "a@example.com" });
    const fid = lark.add(T.followups, { 账号名称: "甲", 档案: [{ id: pid }], 联系渠道: ["hello@tafu.me"] });
    await data.refresh();
    const both = await Promise.allSettled([writeMail(ctx, data, held(), fid, "", "一"), writeMail(ctx, data, held(), fid, "", "二")]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(lark.table(T.reviews).filter((r) => (r["KOL"] as any)?.[0]?.id === fid)).toHaveLength(1);
  });

  it("P1-1 a mail she answered after approval, but maybe already sent, isn't put back for review by the sender", async () => {
    const pid = lark.add(T.profiles, { 账号名称: "甲", 公开邮箱: "a@example.com" });
    const fid = lark.add(T.followups, { 账号名称: "甲", 档案: [{ id: pid }], 联系渠道: ["hello@tafu.me"] });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"], 收件人: "a@example.com", 审核项: "回她", KOL: [{ id: fid }],
      邮件草稿: "主题：好\n好", 同意时间: "2026-10-27 10:00" });
    lark.add(T.contacts, { 方向: ["收到"], 待处理: true, KOL: [{ id: fid }], 摘要: "又來信", 日期: "2026-10-27 11:00" });
    ctx.journal.mark(`review:${id}`, "unknown", undefined, { approvedAt: "2026-10-27 10:00" });
    const rep = await sendApproved(makeCtx(ctx.cfg, lark, ctx.me, "", false, async () => {}), { dryRun: false, only: [id] });
    expect(row(T.reviews, id)["处理"]).toEqual(["发／同意"]);
    expect(rep.failed[0]?.reason).toMatch(/结果不明/);
  });
});

describe("Astra 第三轮修的问题", () => {
  const held = () => ({ add: () => ({ id: 1, what: "", person: "", state: "排队中", note: "", at: 0 }) }) as any;

  it("P1-2 a card with no mailbox of its own is bound to her mailbox: changing it means looking again", async () => {
    const pid = lark.add(T.profiles, { 账号名称: "甲", 公开邮箱: "a@example.com" });
    const f = lark.add(T.followups, { 账号名称: "甲", 档案: [{ id: pid }], 联系渠道: ["hello@tafu.me"] });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 收件人: "a@example.com", 审核项: "回她", KOL: [{ id: f }], 邮件草稿: "主题：好\n好" });
    await data.refresh();
    const card = decisionCards(data, ctx.cfg, today(ctx.cfg)).cards.find((c) => c.id === id)!;
    row(T.followups, f)["联系渠道"] = ["mei@tafu.me"];
    await data.refresh();
    await expect(approve(ctx, data, held(), id, {}, undefined, card.shown)).rejects.toThrow(/发信邮箱/);
    row(T.followups, f)["联系渠道"] = ["hello@tafu.me"];
    await data.refresh();
    await approve(ctx, data, held(), id, {}, undefined, card.shown);
    expect(row(T.reviews, id)["发送渠道"]).toEqual(["hello@tafu.me"]);
  });

  it("P1-3 a 模板审批 item doesn't approve a template changed after its card was shown, and writes nothing", async () => {
    const tid = lark.table(T.templates).find((r) => r["名称"] === "邀约-草稿")!.record_id;
    const id = lark.add(T.reviews, { 类型: ["模板审批"], 状态: ["待你审核"], 审核项: "批准模板 邀约-草稿", 发送渠道: ["不发邮件"] });
    await data.refresh();
    const card = decisionCards(data, ctx.cfg, today(ctx.cfg)).cards.find((c) => c.id === id)!;
    expect(card.shownTemplate).toBeTruthy();
    row(T.templates, tid)["正文"] = "{稱呼} 偷偷改過";
    await expect(approve(ctx, data, held(), id, {}, undefined, card.shown, card.shownTemplate)).rejects.toThrow(/模板又被改过/);
    expect(row(T.reviews, id)["处理"] ?? null).toBeNull();
    expect(row(T.templates, tid)["状态"]).toEqual(["待审核"]);
  });

  it("P2-4 references by address count: a mailbox named 品牌 with mail to go from hello@ can't change address", async () => {
    const hello = lark.table(T.mailboxes)[0];
    hello["渠道名"] = "品牌";
    const f = lark.add(T.followups, { 账号名称: "甲", 联系渠道: ["hello@tafu.me"] });
    lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 处理: ["发／同意"], 发送渠道: ["hello@tafu.me"], 审核项: "回她", KOL: [{ id: f }] });
    await data.refresh();
    await expect(saveMailbox(ctx, hello.record_id, { 邮箱: "x@tafu.me" })).rejects.toThrow(/不能改地址/);
    expect(await mailboxPending(ctx, data, hello.record_id)).toHaveLength(1);
  });

  it("P2-9 a closed followup's turn can't be set from an old page", async () => {
    const fid = lark.add(T.followups, { 账号名称: "甲", 阶段: ["已回复"], 当前轮到谁: ["KOL"] });
    await data.refresh();
    row(T.followups, fid)["阶段"] = ["结案"];
    await expect(updateFollowup(ctx, data, fid, { 当前轮到谁: "我们" })).rejects.toThrow(/无需动作/);
  });
});

describe("Astra 第四轮修的问题", () => {
  const held = () => ({ add: () => ({ id: 1, what: "", person: "", state: "排队中", note: "", at: 0 }) }) as any;

  it("P1 a 模板审批 card shows the template from the table, the same record its version comes from", async () => {
    const tid = lark.table(T.templates).find((r) => r["名称"] === "邀约-草稿")!.record_id;
    const id = lark.add(T.reviews, { 类型: ["模板审批"], 状态: ["待你审核"], 审核项: "批准模板 邀约-草稿", 发送渠道: ["不发邮件"], 邮件草稿: "主题：旧\n旧的副本" });
    row(T.templates, tid)["正文"] = "{稱呼} 表里现在的";
    await data.refresh();
    const card = decisionCards(data, ctx.cfg, today(ctx.cfg)).cards.find((c) => c.id === id)!;
    expect(card.draft!.body).toBe("{稱呼} 表里现在的");
  });

  it("P2 a refused approval leaves her mail waiting", async () => {
    const pid = lark.add(T.profiles, { 账号名称: "甲", 公开邮箱: "a@example.com" });
    const f = lark.add(T.followups, { 账号名称: "甲", 档案: [{ id: pid }], 联系渠道: ["hello@tafu.me"] });
    const m = lark.add(T.contacts, { 方向: ["收到"], 待处理: true, KOL: [{ id: f }], 摘要: "在嗎", 日期: "2026-10-27 09:00", "Message ID": "m1" });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 发送渠道: ["hello@tafu.me"], 收件人: "a@example.com", 审核项: "回她", KOL: [{ id: f }], 邮件草稿: "主题：在\n在" });
    await data.refresh();
    const card = decisionCards(data, ctx.cfg, today(ctx.cfg)).cards.find((c) => c.id === id)!;
    row(T.reviews, id)["邮件草稿"] = "主题：在\n改过";
    await expect(approve(ctx, data, held(), id, {}, card.seen, card.shown)).rejects.toThrow(/刷新/);
    expect(row(T.contacts, m)["待处理"]).toBe(true);
  });

  it("P2 a 渠道名 written with capitals is still found in use", async () => {
    const hello = lark.table(T.mailboxes)[0];
    hello["渠道名"] = "Brand";
    lark.add(T.followups, { 账号名称: "甲", 联系渠道: ["Brand"] });
    await expect(saveMailbox(ctx, hello.record_id, { 邮箱: "x@tafu.me" })).rejects.toThrow(/不能改地址/);
  });
});

describe("Astra 第五轮修的问题", () => {
  const held = () => ({ add: () => ({ id: 1, what: "", person: "", state: "排队中", note: "", at: 0 }) }) as any;

  it("F1 new mail the card didn't show stops the approval before anything is written", async () => {
    const pid = lark.add(T.profiles, { 账号名称: "甲", 公开邮箱: "a@example.com" });
    const f = lark.add(T.followups, { 账号名称: "甲", 档案: [{ id: pid }], 联系渠道: ["hello@tafu.me"] });
    lark.add(T.contacts, { 方向: ["收到"], 待处理: true, KOL: [{ id: f }], 摘要: "一", 日期: "2026-10-27 09:00", "Message ID": "m1" });
    const id = lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 发送渠道: ["hello@tafu.me"], 收件人: "a@example.com", 审核项: "回她", KOL: [{ id: f }], 邮件草稿: "主题：好\n好" });
    await data.refresh();
    const card = decisionCards(data, ctx.cfg, today(ctx.cfg)).cards.find((c) => c.id === id)!;
    lark.add(T.contacts, { 方向: ["收到"], 待处理: true, KOL: [{ id: f }], 摘要: "二", 日期: "2026-10-27 09:30", "Message ID": "m2" });
    await expect(approve(ctx, data, held(), id, {}, card.seen, card.shown)).rejects.toThrow(/又来信/);
    expect(row(T.reviews, id)["处理"] ?? null).toBeNull();
  });

  it("F2 a reference written in other capitals still counts", async () => {
    const hello = lark.table(T.mailboxes)[0];
    hello["渠道名"] = "Brand";
    lark.add(T.reviews, { 类型: ["回复邮件"], 状态: ["待你审核"], 处理: ["发／同意"], 发送渠道: ["BRAND"], 审核项: "回她" });
    await expect(saveMailbox(ctx, hello.record_id, { 邮箱: "x@tafu.me" })).rejects.toThrow(/不能改地址/);
  });
});

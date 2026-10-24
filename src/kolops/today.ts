import { addDays, day, linkIds, option, text } from "./base.js";
import { mailboxFor } from "./config.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot } from "./data.js";
import { today } from "./ops.js";
import { nextStep } from "./remind.js";

/** `kol today`: the lists a person works from, read-only. Run `kol sync` first for fresh replies. */
export async function todayLists(ctx: Ctx) {
  const cfg = ctx.cfg;
  const t = cfg.tables;
  const d = today(cfg);
  const [s, pendingMail, reviews, trials] = await Promise.all([
    loadSnapshot(ctx.base, cfg),
    ctx.base.records(t.contacts, { filter: { logic: "and", conditions: [["待处理", "==", true], ["方向", "intersects", ["收到"]]] },
      fields: ["摘要", "KOL", "日期", "渠道", "待处理", "方向"] }),
    ctx.base.records(t.reviews, { filter: { logic: "and", conditions: [["状态", "intersects", ["待你审核"]]] },
      fields: ["审核项", "类型", "提出时间", "KOL", "状态", "发送渠道"] }),
    ctx.base.records(t.followups, { filter: { logic: "and", conditions: [["阶段", "intersects", ["体验中", "已约发布"]]] },
      fields: ["账号名称", "阶段", "体验码", "体验码到期", "约定发布日期"] }),
  ]);
  const name = (fid: string) => {
    const f = s.followups.get(fid);
    return f ? displayName(s, f) : fid;
  };

  const pluginChannel = (ch: string) => !ch || Boolean(mailboxFor(cfg, ch));
  const open = [...s.followups.values()].filter((f) => option(f["阶段"]) !== "结案");
  const ourTurn = open
    .filter((f) => option(f["当前轮到谁"]) === "我们" && pluginChannel(option(f["联系渠道"])))
    .map((f) => ({ id: f.record_id, name: displayName(s, f), 阶段: option(f["阶段"]), 下一步: text(f["下一步"]) }));
  // Gmail, IG 私信 and the like: the plugin neither reads nor sends there, so these are handled by hand.
  const otherChannels = open
    .filter((f) => ["我们", "等你审核"].includes(option(f["当前轮到谁"])) && !pluginChannel(option(f["联系渠道"])))
    .map((f) => ({ id: f.record_id, name: displayName(s, f), 渠道: option(f["联系渠道"]), 轮到: option(f["当前轮到谁"]),
      阶段: option(f["阶段"]), 下一步: text(f["下一步"]) }));

  // A preview only: `kol remind` reads how many 催信 each person already got before deciding.
  const due = [...s.followups.values()].filter((f) => nextStep(cfg, f, 0, d).kind === "remind").length;

  return {
    日期: d,
    待处理来信: pendingMail.map((r) => ({ kol: name(linkIds(r["KOL"])[0] ?? ""), 主题: text(r["摘要"]), 日期: day(r["日期"], cfg.timezone), 渠道: option(r["渠道"]) })),
    轮到我们: ourTurn,
    等你审核: reviews.map((r) => {
      const ch = option(r["发送渠道"]);
      return { id: r.record_id, 审核项: text(r["审核项"]), 类型: option(r["类型"]), kol: name(linkIds(r["KOL"])[0] ?? ""),
        ...(ch && ch !== "不发邮件" ? { 发送渠道: ch, 插件能发: pluginChannel(ch) } : {}) };
    }),
    其他渠道要手动处理: otherChannels,
    体验码三天内到期: trials
      .filter((f) => option(f["阶段"]) === "体验中" && day(f["体验码到期"], cfg.timezone) && day(f["体验码到期"], cfg.timezone) <= addDays(d, 3))
      .map((f) => ({ name: text(f["账号名称"]), 体验码: text(f["体验码"]), 到期: day(f["体验码到期"], cfg.timezone) })),
    七天内约定发布: trials
      .filter((f) => option(f["阶段"]) === "已约发布" && day(f["约定发布日期"], cfg.timezone) && day(f["约定发布日期"], cfg.timezone) <= addDays(d, 7))
      .map((f) => ({ name: text(f["账号名称"]), 发布日期: day(f["约定发布日期"], cfg.timezone) })),
    今天到期该催的邀约: due,
  };
}

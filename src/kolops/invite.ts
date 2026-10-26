import { addDays, linkIds, option, text } from "./base.js";
import { approvalProblem } from "./reviews.js";
import { mailboxFor } from "./config.js";
import { contactedElsewhere } from "./crossproject.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot, profileEmails } from "./data.js";
import { stamp, today } from "./ops.js";
import { deliver, type Outgoing, type SendReport, type Skipped } from "./send.js";
import { loadTemplates, MissingValue, render } from "./templates.js";

export interface InviteOpts {
  batch: string;
  template: string;
  mailbox: string;
  profiles: string[];
  /** The 审核队列 record (类型 决定) in which this batch was approved. */
  approval: string;
  dryRun: boolean;
}

/** A decision counts as approved when 处理 or 审核结果 says yes and neither says no. */
export function decisionApproved(r: Record<string, any>): boolean {
  const p = option(r["处理"]);
  const res = option(r["审核结果"]);
  const yes = p === "发／同意" || res === "同意" || res === "确认发送";
  const no = ["改", "不发"].includes(p) || ["退回修改", "先不发", "不同意"].includes(res);
  return yes && !no;
}

/**
 * `kol invite`: sends one approved template to a list of 档案 records and creates their 跟进 rows.
 * Re-running the same batch is safe: people already invited are skipped.
 */
export async function invite(ctx: Ctx, o: InviteOpts): Promise<SendReport & { batch: string }> {
  const t = ctx.cfg.tables;
  const mailbox = mailboxFor(ctx.cfg, o.mailbox);
  if (!mailbox) throw new Error(`${o.mailbox} 不在「发信邮箱」表里，或者没有勾「启用」`);
  const approved = (await loadTemplates(ctx.base, ctx.cfg)).filter((x) => x.purpose === "邀约");
  const tpl = approved.find((x) => x.name === o.template);
  if (!tpl) {
    throw new Error(`「模板」表里没有叫「${o.template}」的已批准邀约模板。已批准的邀约模板：${approved.map((x) => x.name).join("、") || "（没有）"}`);
  }

  const approval = (await ctx.base.records(t.reviews)).find((r) => r.record_id === o.approval);
  if (!approval) throw new Error(`审核队列里找不到 ${o.approval}`);
  if (!decisionApproved(approval)) throw new Error("这批邀约在审核队列里还没有被批准");
  const problem = approvalProblem(ctx.cfg, approval);
  if (problem) throw new Error(problem.reason);
  const said = `${text(approval["审核项"])}\n${text(approval["要你定什么"])}`;
  if (!said.includes(o.batch)) throw new Error(`批准记录里没有写批次「${o.batch}」，不能用它来发这批`);

  // The followup is written after the mail goes out, so a batch name the select doesn't have must be caught first.
  const batches = await ctx.base.fieldOptions(t.followups, "邀约批次");
  if (!batches) throw new Error("读不到「邀约批次」的选项，先不发");
  if (!batches.includes(o.batch)) {
    throw new Error(`「${o.batch}」还不是「邀约批次」的选项。请先在飞书里加上这个选项，或用已有的批次名`);
  }

  const [s, elsewhereProjects] = await Promise.all([loadSnapshot(ctx.base, ctx.cfg), contactedElsewhere(ctx)]);
  const day = today(ctx.cfg);
  const items: Outgoing[] = [];
  const skipped: Skipped[] = [];
  const inThisBatch = new Set<string>();
  for (const pid of new Set(o.profiles)) {
    const p = s.profiles.get(pid);
    const name = text(p?.["账号名称"]) || text(p?.["账号"]) || pid;
    if (!p) {
      skipped.push({ key: pid, name, reason: "档案里找不到这条记录" });
      continue;
    }
    if (linkIds(p["跟进记录"]).length) {
      skipped.push({ key: pid, name, reason: "已经有跟进记录，联系过了" });
      continue;
    }
    const emails = profileEmails(p);
    const email = emails[0];
    if (!email) {
      skipped.push({ key: pid, name, reason: "档案里没有邮箱" });
      continue;
    }
    // The same person can have several 档案 (one per platform); the address is what they'd get twice.
    const elsewhere = emails.flatMap((e) => s.followupsByEmail.get(e) ?? [])[0];
    if (elsewhere) {
      skipped.push({ key: pid, name, reason: `邮箱已经在「${displayName(s, s.followups.get(elsewhere)!)}」的跟进记录里，联系过了` });
      continue;
    }
    const otherProject = emails.map((e) => elsewhereProjects.get(e)).find(Boolean);
    if (otherProject) {
      skipped.push({ key: pid, name, reason: otherProject });
      continue;
    }
    if (emails.some((e) => inThisBatch.has(e))) {
      skipped.push({ key: pid, name, reason: "这一批里已经有人用同一个邮箱" });
      continue;
    }
    emails.forEach((e) => inThisBatch.add(e));
    let mail;
    try {
      mail = render(tpl, { 稱呼: text(p["称呼"]) || name, 称呼: text(p["称呼"]) || name, 账号名称: name });
    } catch (err) {
      if (!(err instanceof MissingValue)) throw err;
      skipped.push({ key: pid, name, reason: err.message });
      continue;
    }
    const tempId = `new:${pid}`;
    s.followups.set(tempId, { record_id: tempId, 档案: [{ id: pid }] });
    const now = stamp(Date.now(), ctx.cfg.timezone);
    items.push({
      key: `invite:${o.batch}:${pid}`, followupId: tempId, name, recipient: email, mailbox,
      subject: mail.subject, body: mail.body, oncePerDay: true, kind: "邀约",
      after: {
        createFollowup: {
          账号名称: name, 档案: [{ id: pid }], 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 联系渠道: [mailbox.channel],
          邀约批次: [o.batch], 首次邀约日期: now, 最近联系日期: now,
          下次跟进日期: `${addDays(day, ctx.cfg.followup.firstAfterDays)} 10:00`,
          下一步: `${day} 用「${o.template}」发出邀约，${ctx.cfg.followup.firstAfterDays} 天后没回就自动催`,
        },
      },
    });
  }
  const report = await deliver(ctx, items, s, o.dryRun);
  report.skipped.unshift(...skipped);
  return { ...report, batch: o.batch };
}

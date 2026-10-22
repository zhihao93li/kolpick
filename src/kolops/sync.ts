import { day, emailsIn, option, text } from "./base.js";
import type { Ctx } from "./ctx.js";
import { displayName, loadSnapshot, type Snapshot } from "./data.js";
import { addressOf, type MailSummary } from "./mail.js";
import { stamp } from "./ops.js";

const BOUNCE_SENDER = /mailer-daemon|postmaster|mail-noreply.*bounce|delivery-?status/i;

export interface SyncReport {
  mailboxes: string[];
  newReplies: { name: string; from: string; subject: string; date: string }[];
  bounces: { name: string; address: string }[];
  unknownSenders: number;
  alreadySynced: number;
}

/**
 * `kol sync`: pulls the last few days of each mailbox's inbox, files mail from known KOLs into 接触记录
 * and flips their followup to 轮到我们. Mail from addresses not in the base is left alone.
 */
export async function syncInbox(ctx: Ctx, opts: { days: number; dryRun: boolean }): Promise<SyncReport> {
  const t = ctx.cfg.tables;
  const since = Date.now() - opts.days * 86_400_000;
  const sinceIso = new Date(since).toISOString().replace("Z", "+00:00");
  const s = await loadSnapshot(ctx.base, ctx.cfg);
  const known = await ctx.base.records(t.contacts, {
    filter: { logic: "and", conditions: [["日期", ">=", `ExactDate(${day(since - 86_400_000, ctx.cfg.timezone)})`]] },
    fields: ["Message ID"],
  });
  const seen = new Set(known.map((r) => text(r["Message ID"])).filter(Boolean));

  const report: SyncReport = { mailboxes: [], newReplies: [], bounces: [], unknownSenders: 0, alreadySynced: 0 };
  const contacts: Record<string, unknown>[] = [];
  const followupChanges: Record<string, Record<string, unknown>> = {};

  for (const mb of ctx.cfg.mailboxes) {
    const mails = await ctx.mail.list(mb.address, { folder: "INBOX", time_range: { start_time: sinceIso } });
    report.mailboxes.push(`${mb.address}：${mails.length} 封`);
    for (const m of mails) {
      if (seen.has(m.message_id)) {
        report.alreadySynced++;
        continue;
      }
      seen.add(m.message_id);
      const from = addressOf(m.from);
      const when = Number.isNaN(Date.parse(m.date)) ? Date.now() : Date.parse(m.date);
      if (BOUNCE_SENDER.test(from)) {
        await handleBounce(ctx, s, mb.address, m, when, report, followupChanges);
        continue;
      }
      const fids = s.followupsByEmail.get(from);
      if (!fids?.length) {
        report.unknownSenders++;
        continue;
      }
      const fid = pickFollowup(s, fids);
      const f = s.followups.get(fid)!;
      contacts.push({
        方向: ["收到"], 渠道: [mb.channel], "Message ID": m.message_id, 摘要: m.subject.slice(0, 200),
        日期: stamp(when, ctx.cfg.timezone), 待处理: true, KOL: [{ id: fid }],
      });
      const stage = option(f["阶段"]);
      followupChanges[fid] = {
        ...followupChanges[fid],
        最后来信日期: stamp(when, ctx.cfg.timezone),
        当前轮到谁: ["我们"],
        ...(stage === "已邀约" ? { 阶段: ["已回复"] } : {}),
      };
      report.newReplies.push({ name: displayName(s, f), from, subject: m.subject, date: m.date });
    }
  }

  ctx.run.counts.处理来信 = report.newReplies.length;
  if (!opts.dryRun) {
    if (contacts.length) await ctx.base.create(t.contacts, contacts);
    if (Object.keys(followupChanges).length) await ctx.base.update(t.followups, followupChanges);
    for (const r of report.newReplies) ctx.run.op({ type: "来信处理", result: "完成", action: `收到来信：${r.name}`, detail: r.subject });
    for (const b of report.bounces) ctx.run.op({ type: "来信处理", result: "退信", action: `退信结案：${b.name}`, detail: b.address });
  }
  return report;
}

/** Several followups can share an address; prefer one that is still open. */
function pickFollowup(s: Snapshot, ids: string[]): string {
  return ids.find((id) => !["结案"].includes(option(s.followups.get(id)?.["阶段"]))) ?? ids[0];
}

async function handleBounce(ctx: Ctx, s: Snapshot, mailbox: string, m: MailSummary, when: number,
                            report: SyncReport, changes: Record<string, Record<string, unknown>>): Promise<void> {
  // The bounce names the failed address in its body, not its headers.
  const data = await ctx.base.lark.json(["mail", "+messages", "--mailbox", mailbox, "--message-ids", m.message_id,
    "--html=false", "--as", "user"]).catch(() => null);
  const body = JSON.stringify(data ?? "");
  for (const addr of new Set(emailsIn(body))) {
    if (addr === mailbox || BOUNCE_SENDER.test(addr)) continue;
    for (const fid of s.followupsByEmail.get(addr) ?? []) {
      const f = s.followups.get(fid)!;
      if (option(f["阶段"]) === "结案") continue;
      changes[fid] = { ...changes[fid], 阶段: ["结案"], 结案原因: ["退信或邮箱无效"], 当前轮到谁: ["无需动作"],
        下一步: `${stamp(when, ctx.cfg.timezone).slice(0, 10)} 发往 ${addr} 的信被退回` };
      report.bounces.push({ name: displayName(s, f), address: addr });
    }
  }
}

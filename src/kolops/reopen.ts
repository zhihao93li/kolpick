import { addDays, day, option } from "./base.js";
import type { Row } from "./lark.js";

/**
 * Noted at the end of 下一步 when a followup closes: the base has no field for the stage it closed from, and
 * writing to her again later goes back to it (R-05).
 */
export function closedFrom(f: Row | undefined): string {
  const stage = option(f?.["阶段"]);
  return stage && stage !== "结案" ? `（结案前：${stage}）` : "";
}

/** The stage a closed followup closed from, when its 下一步 still says. */
function stageBeforeClosing(f: Row): string {
  return String(f["下一步"] ?? "").match(/（结案前：([^）]+)）/)?.[1] ?? "";
}

/**
 * She wrote to a followup that was closed: it opens again at 已回复 (R-05). The close stays in 下一步 as history.
 * Callers leave a 永不联系 followup closed.
 */
export function reopenChanges(f: Row | undefined, today: string): Record<string, unknown> {
  if (!f || option(f["阶段"]) !== "结案") return {};
  const reason = option(f["结案原因"]);
  return { 阶段: ["已回复"], 结案原因: null, 下一步: `${today} 重新联系（之前结案${reason ? `：${reason}` : ""}）` };
}

/**
 * We wrote first to a followup that was closed (R-05, E-29). She hasn't answered, so it must not read 已回复 just
 * for that: it goes back to the stage it closed from, which closing noted in 下一步. Older closes didn't note it;
 * then 已邀约 if she never wrote after the invitation, otherwise 已回复. It waits 结案天数 for her; with no answer
 * by then the reminder rules take it from there (a KOL chased twice is closed again as 无回应).
 */
export function reopenAfterWriting(f: Row | undefined, today: string, timezone: string, closeAfterDays: number): Record<string, unknown> {
  if (!f || option(f["阶段"]) !== "结案") return {};
  const reason = option(f["结案原因"]);
  const invited = day(f["首次邀约日期"], timezone);
  const lastIn = day(f["最后来信日期"], timezone);
  const answered = Boolean(lastIn && (!invited || lastIn >= invited));
  const stage = stageBeforeClosing(f) || (answered || !invited ? "已回复" : "已邀约");
  const next = addDays(today, closeAfterDays);
  return {
    阶段: [stage], 结案原因: null, 下次跟进日期: `${next} 10:00`,
    下一步: `${today} 我们又写信了（之前结案${reason ? `：${reason}` : ""}），${next} 还没回就结案`,
  };
}

/**
 * Noted in 下一步 when a followup is paused: 暂缓 replaces its stage in the base, and resuming goes back to the
 * stage it was paused from, the way a reopen reads 「（结案前：X）」.
 */
export function pausedFrom(f: Row | undefined): string {
  const stage = option(f?.["阶段"]);
  return stage && stage !== "暂缓" && stage !== "结案" ? `（暂缓前：${stage}）` : "";
}

/** The 「（暂缓前：X）」 note on a paused followup, to carry over when its 下一步 is rewritten. */
export function pauseNote(f: Row): string {
  return String(f["下一步"] ?? "").match(/（暂缓前：[^）]+）/)?.[0] ?? "";
}

/** The stage a paused followup goes back to: the one its pause noted, or 已回复 when it didn't. */
export function stageBeforePause(f: Row): string {
  return String(f["下一步"] ?? "").match(/（暂缓前：([^）]+)）/)?.[1] ?? "已回复";
}

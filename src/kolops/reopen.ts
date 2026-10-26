import { option } from "./base.js";
import type { Row } from "./lark.js";

/** A reply to a KOL whose followup was closed opens it again; the close stays in 下一步 as history. */
export function reopenChanges(f: Row | undefined, day: string): Record<string, unknown> {
  if (!f || option(f["阶段"]) !== "结案") return {};
  const reason = option(f["结案原因"]);
  return { 阶段: ["已回复"], 结案原因: null, 下一步: `${day} 重新联系（之前结案${reason ? `：${reason}` : ""}）` };
}

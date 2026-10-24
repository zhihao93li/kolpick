import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Everything the commands need from lark-cli; tests swap in a fake. */
export interface Lark {
  /** Runs `lark-cli <args>` and returns the parsed JSON payload (the envelope's `data` when there is one). */
  json(args: string[]): Promise<any>;
  /** Reads every record of a table that matches `filter`, following pagination. */
  records(table: string, opts?: { filter?: object; fields?: string[] }): Promise<Row[]>;
}

/** One Base record as NDJSON gives it: field name -> value, plus `record_id`. */
export type Row = Record<string, any> & { record_id: string };

/** User scopes the commands use: Base reads and writes, the signed-in user's name, and reading and sending mail. */
export const REQUIRED_SCOPES = [
  "base:record:read", "base:record:create", "base:record:update", "base:field:read",
  "contact:user.basic_profile:readonly",
  "mail:user_mailbox:readonly", "mail:user_mailbox.message:readonly", "mail:user_mailbox.message.address:read",
  "mail:user_mailbox.message.subject:read", "mail:user_mailbox.message.body:read",
  "mail:user_mailbox.message:modify", "mail:user_mailbox.message:send",
];

/** What to tell a colleague whose lark-cli login lacks some scopes. */
export function authHint(missing: string[]): string {
  return `飞书授权缺少权限：${missing.join("、")}。\n`
    + `请在终端运行：lark-cli auth login --scope "${REQUIRED_SCOPES.join(" ")}"\n`
    + "它会给出一个链接，在浏览器里打开并同意。如果授权页说应用没有开通这些权限，"
    + "要先请飞书管理员在开放平台给 lark-cli 用的应用开通邮箱和通讯录权限（详见插件 README）。";
}

export class LarkError extends Error {
  /** True when lark-cli answered with an API error: the call was refused, so nothing happened. */
  constructor(message: string, public definite = false) {
    super(message);
  }
}

export class LarkCli implements Lark {
  constructor(private baseToken: string, private bin = process.env.KOL_LARK_CLI || "lark-cli") {}

  async json(args: string[]): Promise<any> {
    const out = await this.raw(args);
    return unwrap(out, args);
  }

  async records(table: string, opts: { filter?: object; fields?: string[] } = {}): Promise<Row[]> {
    // JSON pages of 200 work on every lark-cli version in use (1.0.73 has no NDJSON export).
    const rows: Row[] = [];
    for (let offset = 0; ; offset += 200) {
      const args = ["base", "+record-list", "--base-token", this.baseToken, "--table-id", table,
        "--format", "json", "--limit", "200", "--offset", String(offset), "--as", "user"];
      if (opts.filter) args.push("--filter-json", JSON.stringify(opts.filter));
      for (const f of opts.fields ?? []) args.push("--field-id", f);
      const page = await this.json(args);
      rows.push(...matrixRows(page));
      if (!page?.has_more) break;
    }
    return rows;
  }

  private async raw(args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await exec(this.bin, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (err: any) {
      if (err.code === "ENOENT") throw new LarkError("这台电脑上找不到 lark-cli。请先按插件 README 安装并登录 lark-cli", true);
      // lark-cli prints its error envelope on stdout or, for auth errors, stderr, and exits non-zero.
      const detail = (err.stdout || err.stderr || err.message || "").toString().trim();
      let envelope: any;
      for (const out of [err.stdout, err.stderr]) {
        try {
          envelope ??= JSON.parse(out);
        } catch {}
      }
      if (envelope?.error?.type === "authorization") {
        const missing: string[] = envelope.error.missing_scopes ?? [];
        throw new LarkError(missing.length ? authHint(missing) : `飞书登录有问题：${envelope.error.message}。请在终端运行 lark-cli auth login 重新登录`, true);
      }
      throw new LarkError(`lark-cli ${args.slice(0, 2).join(" ")} 失败：${detail.slice(0, 800)}`, envelope?.ok === false);
    }
  }
}

/** `+record-list --format json` gives positional rows plus parallel `fields` and `record_id_list`. */
export function matrixRows(page: any): Row[] {
  const fields: string[] = page?.fields ?? [];
  const ids: string[] = page?.record_id_list ?? [];
  return (page?.data ?? []).map((cells: any[], i: number) => {
    const row: Row = { record_id: ids[i] };
    fields.forEach((f, j) => (row[f] = cells[j] ?? null));
    return row;
  });
}

export function unwrap(stdout: string, args: string[] = []): any {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new LarkError(`lark-cli ${args.slice(0, 2).join(" ")} 没有返回 JSON：${stdout.slice(0, 300)}`);
  }
  if (parsed && typeof parsed === "object" && "ok" in parsed) {
    if (!parsed.ok) throw new LarkError(`lark-cli ${args.slice(0, 2).join(" ")} 失败：${JSON.stringify(parsed.error ?? parsed).slice(0, 800)}`, true);
    return parsed.data ?? {};
  }
  return parsed;
}

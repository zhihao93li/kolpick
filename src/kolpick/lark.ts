import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Everything kolpick asks of lark-cli; tests swap in a fake. */
export interface Lark {
  /** Runs `lark-cli <args>` and returns the parsed payload (the envelope's `data` when there is one). */
  json(args: string[]): Promise<any>;
}

export class LarkError extends Error {
  /**
   * definite: Feishu answered with an error, so nothing happened. Otherwise (timeout, dropped connection) the
   * call may or may not have gone through.
   */
  constructor(message: string, public definite = false) {
    super(message);
  }
}

/** lark-cli commands that only read, so a dropped connection can be tried again. */
const READS = new Set(["+triage", "+messages", "+message", "+thread", "user_mailbox.messages", "+table-list", "+field-list", "+record-list"]);

export class LarkCli implements Lark {
  constructor(private bin = process.env.KOLPICK_LARK_CLI || "lark-cli") {}

  async json(args: string[]): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      try {
        return unwrap(await this.once(args), args);
      } catch (err) {
        const retry = err instanceof LarkError && !err.definite && READS.has(args[1]) && attempt < 4;
        if (!retry) throw err;
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
  }

  private async once(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec(this.bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
      return stdout;
    } catch (err: any) {
      if (err.code === "ENOENT") throw new LarkError("这台电脑上找不到 lark-cli，请先安装并登录（npm i -g @larksuite/cli）", true);
      let envelope: any;
      for (const out of [err.stdout, err.stderr]) {
        try {
          envelope ??= JSON.parse(out);
        } catch {}
      }
      if (envelope?.error?.type === "authorization") {
        const missing: string[] = envelope.error.missing_scopes ?? [];
        throw new LarkError(missing.length
          ? `飞书授权缺少权限：${missing.join("、")}。请运行 lark-cli auth login --scope "${missing.join(" ")}"，在浏览器里同意`
          : `飞书登录有问题：${envelope.error.message}。请运行 lark-cli auth login`, true);
      }
      const network = envelope?.error?.type === "network" || err.killed;
      const detail = String(err.stdout || err.stderr || err.message || "").trim().slice(0, 800);
      throw new LarkError(`lark-cli ${args.slice(0, 2).join(" ")} 失败：${detail}`, envelope?.ok === false && !network);
    }
  }
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

/**
 * One-step install on a Mac: copies the bundled kolpick into ~/.kolpick/bin, keeps the local server running
 * (a LaunchAgent: started at login, restarted if it stops), and registers the MCP server with Claude Code and Codex.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { home, loadConfig } from "./config.js";

const LABEL = "me.tafu.kolpick";

function plist(node: string, script: string, logs: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(script)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? "/usr/bin:/bin")}</string><key>HOME</key><string>${esc(homedir())}</string></dict>
  <key>StandardOutPath</key><string>${esc(join(logs, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logs, "server.log"))}</string>
</dict></plist>
`;
}

function tryRun(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err: any) {
    return `失败：${String(err.stderr || err.message).trim().slice(0, 300)}`;
  }
}

export function install(): string[] {
  const out: string[] = [];
  const cfg = loadConfig();
  const bin = join(home(), "bin");
  const logs = join(home(), "logs");
  mkdirSync(bin, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const script = join(bin, "kolpick.mjs");
  const self = fileURLToPath(import.meta.url);
  if (!self.endsWith(".mjs")) throw new Error("请用打包好的 bin/kolpick.mjs 安装（npm run build 后运行 node bin/kolpick.mjs install）");
  if (self !== script) copyFileSync(self, script);
  const launcher = join(bin, "kolpick");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(launcher, 0o755);
  out.push(`命令：${launcher}（可以加进 PATH，或 ln -s ${launcher} /usr/local/bin/kolpick）`);

  const agents = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const file = join(agents, `${LABEL}.plist`);
  writeFileSync(file, plist(process.execPath, script, logs));
  const uid = String(process.getuid?.() ?? "");
  tryRun("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
  const boot = tryRun("launchctl", ["bootstrap", `gui/${uid}`, file]);
  out.push(boot.startsWith("失败") ? `后台服务没起来：${boot}` : `后台服务已启动：http://127.0.0.1:${cfg.port}（开机自动运行，日志在 ${logs}/server.log）`);

  const url = `http://127.0.0.1:${cfg.port}/mcp`;
  if (!tryRun("which", ["claude"]).startsWith("失败")) {
    tryRun("claude", ["mcp", "remove", "--scope", "user", "kolpick"]);
    const r = tryRun("claude", ["mcp", "add", "--transport", "http", "--scope", "user", "kolpick", url]);
    out.push(r.startsWith("失败") ? `Claude Code 注册失败：${r}` : "已注册到 Claude Code（所有项目可用）");
  } else out.push("没找到 claude 命令，跳过 Claude Code");
  if (!tryRun("which", ["codex"]).startsWith("失败")) {
    tryRun("codex", ["mcp", "remove", "kolpick"]);
    const r = tryRun("codex", ["mcp", "add", "kolpick", "--url", url]);
    out.push(r.startsWith("失败") ? `Codex 注册失败：${r}` : "已注册到 Codex");
  } else out.push("没找到 codex 命令，跳过 Codex");
  return out;
}

export function uninstall(): string[] {
  const uid = String(process.getuid?.() ?? "");
  const out = [tryRun("launchctl", ["bootout", `gui/${uid}/${LABEL}`]) || "后台服务已停"];
  out.push(tryRun("claude", ["mcp", "remove", "--scope", "user", "kolpick"]) || "已从 Claude Code 移除");
  out.push(tryRun("codex", ["mcp", "remove", "kolpick"]) || "已从 Codex 移除");
  return out;
}

export function restart(): string {
  const uid = String(process.getuid?.() ?? "");
  return tryRun("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`]) || "已重启后台服务";
}

export function installed(): boolean {
  return existsSync(join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`));
}

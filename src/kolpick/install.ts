/**
 * One-step install on a Mac: copies the bundled kolpick into ~/.kolpick/bin, puts a kolpick.app in ~/Applications
 * (click it to start the service if needed and open the console), and registers the MCP server with Claude Code and
 * Codex. Starting at login is the operator's choice, switched in the console (a LaunchAgent, off by default).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { home, loadConfig } from "./config.js";

const LABEL = "me.tafu.kolpick";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const plistFile = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const appDir = () => join(homedir(), "Applications", "kolpick.app");
const installedScript = () => join(home(), "bin", "kolpick.mjs");

// Started at login; restarted after a crash, but not after the operator closes it (a clean exit).
function plist(node: string, script: string, logs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(script)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? "/usr/bin:/bin")}</string><key>HOME</key><string>${esc(homedir())}</string></dict>
  <key>StandardOutPath</key><string>${esc(join(logs, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(logs, "server.log"))}</string>
</dict></plist>
`;
}

// The app only launches: start the service when it isn't answering, then open the console in its own window.
export function launcher(node: string, script: string, logs: string, port: number): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
URL=http://127.0.0.1:${port}
export PATH=${q(process.env.PATH ?? "/usr/bin:/bin")}
if ! curl -s -o /dev/null --max-time 1 "$URL/api/local"; then
  nohup ${q(node)} ${q(script)} serve >> ${q(join(logs, "server.log"))} 2>&1 &
  i=0
  while [ $i -lt 60 ] && ! curl -s -o /dev/null --max-time 1 "$URL/api/local"; do sleep 0.25; i=$((i+1)); done
fi
if [ -d "/Applications/Google Chrome.app" ]; then open -na "Google Chrome" --args --app="$URL"; else open "$URL"; fi
`;
}

function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>kolpick</string>
  <key>CFBundleDisplayName</key><string>kolpick</string>
  <key>CFBundleIdentifier</key><string>${LABEL}.app</string>
  <key>CFBundleExecutable</key><string>kolpick</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2</string>
  <key>LSUIElement</key><true/>
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

/** Builds ~/Applications/kolpick.app around the installed script. */
export function makeApp(node = process.execPath, script = installedScript()): string {
  const logs = join(home(), "logs");
  mkdirSync(logs, { recursive: true });
  const dir = appDir();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(dir, "Contents", "Info.plist"), infoPlist());
  const exe = join(dir, "Contents", "MacOS", "kolpick");
  writeFileSync(exe, launcher(node, script, logs, loadConfig().port));
  chmodSync(exe, 0o755);
  return dir;
}

/** Whether kolpick starts at login. */
export function loginStart(): boolean {
  return existsSync(plistFile());
}

/**
 * Turns starting at login on or off. Turning it on takes effect at the next login (the running service stays as it
 * is, so two never fight over the port); turning it off leaves the running service alone too.
 */
export function setLoginStart(on: boolean): boolean {
  if (on) {
    if (!existsSync(installedScript())) throw new Error("先在终端运行一次 kolpick install，才能开机自动启动");
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(home(), "logs"), { recursive: true });
    writeFileSync(plistFile(), plist(process.execPath, installedScript(), join(home(), "logs")));
  } else rmSync(plistFile(), { force: true });
  return loginStart();
}

export function install(): string[] {
  const out: string[] = [];
  const cfg = loadConfig();
  const bin = join(home(), "bin");
  mkdirSync(bin, { recursive: true });
  const script = installedScript();
  const self = fileURLToPath(import.meta.url);
  if (!self.endsWith(".mjs")) throw new Error("请用打包好的 bin/kolpick.mjs 安装（npm run build 后运行 node bin/kolpick.mjs install）");
  if (self !== script) copyFileSync(self, script);
  const launcherCmd = join(bin, "kolpick");
  writeFileSync(launcherCmd, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(launcherCmd, 0o755);
  out.push(`命令：${launcherCmd}（可以加进 PATH，或 ln -s ${launcherCmd} /usr/local/bin/kolpick）`);
  out.push(`App：${makeApp(process.execPath, script)}（点开就启动服务并打开决策台，可以拖到 Dock）`);
  // An earlier install's login item is rewritten to this version's rules.
  if (loginStart()) setLoginStart(true);
  out.push(loginStart() ? "开机自动启动：开着（在决策台「设置 → 这台电脑」里可以关）" : "开机自动启动：关着（在决策台「设置 → 这台电脑」里可以开）");

  const url = `http://127.0.0.1:${cfg.port}/mcp`;
  if (!tryRun("which", ["claude"]).startsWith("失败")) {
    tryRun("claude", ["mcp", "remove", "--scope", "user", "kolpick"]);
    const r = tryRun("claude", ["mcp", "add", "--transport", "http", "--scope", "user", "kolpick", url]);
    out.push(r.startsWith("失败") ? `Claude Code 注册失败：${r}` : "已注册到 Claude Code（所有项目可用；服务开着时能用）");
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
  rmSync(plistFile(), { force: true });
  rmSync(appDir(), { recursive: true, force: true });
  out.push("已移除开机启动和 kolpick.app");
  out.push(tryRun("claude", ["mcp", "remove", "--scope", "user", "kolpick"]) || "已从 Claude Code 移除");
  out.push(tryRun("codex", ["mcp", "remove", "kolpick"]) || "已从 Codex 移除");
  return out;
}

export function restart(): string {
  const uid = String(process.getuid?.() ?? "");
  const r = tryRun("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`]);
  return r.startsWith("失败") ? "服务不是开机自动启动的：在决策台「设置 → 这台电脑」里关闭 kolpick，再点 kolpick.app 打开" : r || "已重启后台服务";
}

export function installed(): boolean {
  return existsSync(installedScript());
}

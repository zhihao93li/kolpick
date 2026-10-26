import { randomUUID } from "node:crypto";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import { dataDir } from "./ops.js";

/**
 * The executor: everything that reaches outside the base (sending mail, reading the inbox, creating or
 * extending codes, spending Apify money) runs one thing at a time, on one computer. The decision console and
 * the commands Claude runs all take the same lock file, so two of them never send at once.
 */

export interface Machine {
  id: string;
  name: string;
}

/** This computer's id, made once and kept in ~/.kol-ops/machine.json. */
export function machine(): Machine {
  const file = join(dataDir(), "machine.json");
  if (existsSync(file)) {
    try {
      const m = JSON.parse(readFileSync(file, "utf8"));
      if (m?.id) return { id: String(m.id), name: String(m.name ?? hostname()) };
    } catch {}
  }
  const m = { id: randomUUID().slice(0, 8), name: hostname().replace(/\.local$/, "") };
  writeFileSync(file, JSON.stringify(m, null, 2));
  return m;
}

/** How 设置.执行电脑 names a computer: its name, then its id in brackets; only the id is compared. */
export function machineLabel(m: Machine): string {
  return `${m.name}（${m.id}）`;
}

/** Why this computer must not execute anything for this project, or "" when it may. */
export function notExecutor(cfg: Config, m: Machine = machine()): string {
  if (!cfg.executor || cfg.executor.includes(m.id)) return "";
  return `这台电脑（${machineLabel(m)}）不是这个项目的执行电脑。「设置」表里的执行电脑是「${cfg.executor}」：`
    + "发信、收信、建码、找人只在那台电脑上做。这台电脑可以看、写草稿、提交待决定。"
    + "要换执行电脑，在新电脑上运行 kol executor claim";
}

interface LockFile {
  pid: number;
  machine: string;
  what: string;
  since: number;
  beat: number;
}

/** A holder that stopped beating this long ago is treated as gone. */
const STALE_MS = 90_000;
const BEAT_MS = 20_000;

function lockPath(): string {
  return join(dataDir(), "executor.lock");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** Who holds the lock right now, or null. A holder that died or stopped beating doesn't count. */
export function lockHolder(now = Date.now()): LockFile | null {
  try {
    const l: LockFile = JSON.parse(readFileSync(lockPath(), "utf8"));
    if (now - l.beat > STALE_MS || !alive(l.pid)) return null;
    return l;
  } catch {
    return null;
  }
}

export class ExecutorBusy extends Error {}

export class ExecutorLock {
  private timer: NodeJS.Timeout | null = null;

  private constructor(private what: string) {}

  /**
   * Takes the lock, waiting up to `waitMs` while another run holds it. A lock left by a run that died is taken
   * over. Throws ExecutorBusy when the wait runs out.
   */
  static async acquire(what: string, o: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<ExecutorLock> {
    const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (o.waitMs ?? 0);
    for (;;) {
      if (ExecutorLock.tryTake(what)) {
        const lock = new ExecutorLock(what);
        lock.timer = setInterval(() => lock.beat(), BEAT_MS);
        lock.timer.unref();
        return lock;
      }
      const holder = lockHolder();
      if (Date.now() >= deadline) {
        throw new ExecutorBusy(`执行器正在做「${holder?.what ?? "别的事"}」（${holder ? new Date(holder.since).toLocaleTimeString("zh-CN", { hour12: false }) : ""} 开始），等它做完再试`);
      }
      await sleep(3_000);
    }
  }

  private static tryTake(what: string): boolean {
    const file = lockPath();
    if (existsSync(file) && !lockHolder()) {
      try {
        unlinkSync(file);
      } catch {}
    }
    let fd: number;
    try {
      fd = openSync(file, "wx");
    } catch (err: any) {
      if (err?.code === "EEXIST") return false;
      throw err;
    }
    const now = Date.now();
    const body: LockFile = { pid: process.pid, machine: machine().id, what, since: now, beat: now };
    writeFileSync(fd, JSON.stringify(body));
    closeSync(fd);
    return true;
  }

  private beat(): void {
    try {
      const l: LockFile = JSON.parse(readFileSync(lockPath(), "utf8"));
      if (l.pid !== process.pid) return;
      writeFileSync(lockPath(), JSON.stringify({ ...l, beat: Date.now() }));
    } catch {}
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      const l: LockFile = JSON.parse(readFileSync(lockPath(), "utf8"));
      if (l.pid === process.pid) unlinkSync(lockPath());
    } catch {}
  }

  /** Runs `fn` holding the lock, and lets go however it ends. */
  static async run<T>(what: string, fn: () => Promise<T>, o: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
    const lock = await ExecutorLock.acquire(what, o);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }
}

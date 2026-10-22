import { Base } from "./base.js";
import type { Config } from "./config.js";
import type { Lark } from "./lark.js";
import { Mail } from "./mail.js";
import { Journal, Run, type Me } from "./ops.js";

/** What every command gets: config, the base, mail, who is running it, and this run's log. */
export interface Ctx {
  cfg: Config;
  base: Base;
  mail: Mail;
  me: Me;
  journal: Journal;
  run: Run;
  sleep(ms: number): Promise<void>;
}

export function makeCtx(cfg: Config, lark: Lark, me: Me, title: string, scheduled: boolean, sleep?: (ms: number) => Promise<void>): Ctx {
  const base = new Base(lark, cfg.baseToken);
  return {
    cfg, base, me,
    mail: new Mail(lark),
    journal: new Journal(),
    run: new Run(base, cfg, title, me, scheduled),
    sleep: sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

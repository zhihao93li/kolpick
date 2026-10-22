import type { Child } from "hono/jsx";

// One stylesheet for the whole back office; pages are server-rendered, so there is no front-end build.
const CSS = `
:root {
  --fg:#1d2129; --fg2:#4e5969; --muted:#86909c; --line:#e5e6eb; --line2:#f2f3f5;
  --bg:#f7f8fa; --panel:#fff; --accent:#3370ff; --accent-soft:#e8f0ff; --accent-fg:#245bdb;
  --ok:#00a870; --ok-soft:#e8f8f2; --warn:#d46b08; --warn-soft:#fff4e6; --bad:#e34d59; --bad-soft:#fdecee;
  --radius:10px; --shadow:0 1px 2px rgba(0,0,0,.04), 0 2px 8px rgba(0,0,0,.04);
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; font:14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
       color:var(--fg); background:var(--bg); }
a { color:var(--accent-fg); text-decoration:none; } a:hover { text-decoration:underline; }
h1 { font-size:22px; line-height:1.3; margin:0; font-weight:600; }
h2 { font-size:16px; margin:0 0 12px; font-weight:600; }
h3 { font-size:14px; margin:0 0 8px; font-weight:600; }
p { margin:0 0 8px; }
.muted { color:var(--muted); } .fg2 { color:var(--fg2); } .small { font-size:12px; } .nowrap { white-space:nowrap; }
.num { font-variant-numeric:tabular-nums; }

/* top bar and project tabs */
.topbar { position:sticky; top:0; z-index:20; background:var(--panel); border-bottom:1px solid var(--line); }
.topbar .in { max-width:1240px; margin:0 auto; padding:0 24px; height:56px; display:flex; align-items:center; gap:16px; }
.brand { display:flex; align-items:center; gap:8px; font-weight:600; color:var(--fg); font-size:15px; }
.brand:hover { text-decoration:none; }
.brand i { width:26px; height:26px; border-radius:7px; background:var(--accent); color:#fff; font-style:normal;
           display:grid; place-items:center; font-size:13px; }
.crumb { color:var(--muted); } .crumb b { color:var(--fg); font-weight:500; }
.who { margin-left:auto; display:flex; align-items:center; gap:10px; color:var(--fg2); }
.tabs { max-width:1240px; margin:0 auto; padding:0 24px; display:flex; gap:4px; overflow-x:auto; }
.tabs a { padding:10px 12px; color:var(--fg2); border-bottom:2px solid transparent; white-space:nowrap; }
.tabs a:hover { color:var(--fg); text-decoration:none; }
.tabs a.on { color:var(--accent-fg); border-color:var(--accent); font-weight:500; }
.tabs .count { margin-left:6px; }
main { max-width:1240px; margin:0 auto; padding:24px; }
.pagehead { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
.pagehead .actions { margin-left:auto; display:flex; gap:8px; }
.pagehead .sub { width:100%; color:var(--muted); margin-top:-6px; }

/* building blocks */
.panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); }
.panel > .hd { padding:14px 18px; border-bottom:1px solid var(--line2); display:flex; align-items:center; gap:8px; }
.panel > .hd h2 { margin:0; } .panel > .hd .right { margin-left:auto; }
.panel > .bd { padding:18px; }
.grid { display:grid; gap:16px; }
.g2 { grid-template-columns:repeat(2, minmax(0,1fr)); } .g3 { grid-template-columns:repeat(3, minmax(0,1fr)); }
.g4 { grid-template-columns:repeat(4, minmax(0,1fr)); }
.split { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:20px; align-items:start; }
.stack > * + * { margin-top:16px; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.spacer { flex:1; }

.btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:34px; padding:0 14px; border-radius:8px;
       border:1px solid var(--line); background:var(--panel); color:var(--fg); font:inherit; font-weight:500; cursor:pointer;
       white-space:nowrap; text-decoration:none !important; }
.btn:hover { border-color:#c9cdd4; background:#fafbfc; }
.btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; } .btn.primary:hover { background:#2b63f0; }
.btn.ok { color:var(--ok); } .btn.ok:hover { background:var(--ok-soft); border-color:var(--ok); }
.btn.bad { color:var(--bad); } .btn.bad:hover { background:var(--bad-soft); border-color:var(--bad); }
.btn.ghost { border-color:transparent; background:transparent; color:var(--fg2); } .btn.ghost:hover { background:var(--line2); }
.btn.sm { height:28px; padding:0 10px; font-size:13px; } .btn.lg { height:42px; padding:0 20px; font-size:15px; }
.btn.block { width:100%; }
.btn:disabled { opacity:.5; cursor:not-allowed; }

.badge { display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 8px; border-radius:11px; font-size:12px;
         background:var(--line2); color:var(--fg2); white-space:nowrap; font-weight:500; }
.badge.ok { background:var(--ok-soft); color:var(--ok); } .badge.bad { background:var(--bad-soft); color:var(--bad); }
.badge.warn { background:var(--warn-soft); color:var(--warn); } .badge.info { background:var(--accent-soft); color:var(--accent-fg); }
.badge .dot { width:6px; height:6px; border-radius:50%; background:currentColor; }
.badge.live .dot { animation:pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity:.25; } }
.pf { display:inline-grid; place-items:center; width:20px; height:20px; border-radius:5px; color:#fff; font-size:10px;
      font-weight:700; flex:none; }
.pf.instagram { background:linear-gradient(135deg,#f58529,#dd2a7b 55%,#8134af); } .pf.youtube { background:#ff0033; }
.pf.tiktok { background:#111; }
.flash { padding:10px 14px; border-radius:8px; background:var(--accent-soft); color:var(--accent-fg); margin-bottom:16px; }
.flash.bad { background:var(--bad-soft); color:var(--bad); }
.empty { text-align:center; padding:48px 16px; color:var(--muted); }
.empty b { display:block; color:var(--fg); font-size:15px; margin-bottom:4px; }

.stat { padding:16px 18px; }
.stat .k { color:var(--muted); font-size:13px; }
.stat .v { font-size:26px; font-weight:600; line-height:1.3; font-variant-numeric:tabular-nums; }
.stat .s { color:var(--muted); font-size:12px; }
a.stat:hover { text-decoration:none; background:#fafbfc; }

table.t { border-collapse:collapse; width:100%; }
.t th, .t td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--line2); vertical-align:middle; }
.t th { color:var(--muted); font-weight:500; font-size:12px; white-space:nowrap; background:#fafbfc; }
.t tr:last-child td { border-bottom:0; }
.t tr.link { cursor:pointer; } .t tr.link:hover td { background:#fafbfc; }
.t td.r, .t th.r { text-align:right; }

/* forms */
.field { display:block; }
.field + .field { margin-top:16px; }
.field > .lb { display:block; font-weight:500; margin-bottom:6px; }
.field > .hint { display:block; color:var(--muted); font-size:12px; margin-top:4px; }
.input, textarea.input, select.input { width:100%; height:36px; padding:0 10px; border:1px solid var(--line); border-radius:8px;
  font:inherit; background:var(--panel); color:var(--fg); }
textarea.input { height:auto; min-height:76px; padding:8px 10px; resize:vertical; }
.input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.input.w-s { width:110px; } .input.w-m { width:180px; }
.check { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--line); border-radius:8px; cursor:pointer; }
.check + .check { margin-top:8px; }
.check input { margin-top:4px; } .check .t2 { color:var(--muted); font-size:12px; display:block; }
.choice { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:10px; }
.choice label { border:1px solid var(--line); border-radius:10px; padding:12px 14px; cursor:pointer; display:block; }
.choice label:has(input:checked) { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.choice label { position:relative; } .choice input { position:absolute; opacity:0; pointer-events:none; }
form[data-platform="instagram"] [data-only]:not([data-only~="instagram"]),
form[data-platform="youtube"] [data-only]:not([data-only~="youtube"]),
form[data-platform="tiktok"] [data-only]:not([data-only~="tiktok"]) { display:none; }
.choice .nm { display:flex; align-items:center; gap:8px; font-weight:600; }
.choice .ds { color:var(--muted); font-size:12px; margin-top:4px; }
.chips { display:flex; gap:6px; flex-wrap:wrap; }
.chip { height:28px; padding:0 12px; border-radius:14px; border:1px solid var(--line); background:var(--panel); color:var(--fg2);
        font:inherit; font-size:13px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; text-decoration:none !important; }
.chip:hover { border-color:#c9cdd4; } .chip.on { background:var(--accent-soft); border-color:var(--accent); color:var(--accent-fg); }
details.more > summary { cursor:pointer; color:var(--fg2); list-style:none; user-select:none; }
details.more > summary::before { content:"▸ "; } details.more[open] > summary::before { content:"▾ "; }
details.more > .bd { margin-top:12px; }
.sticky { position:sticky; top:76px; }
.kv { display:grid; grid-template-columns:auto 1fr; gap:6px 16px; } .kv dt { color:var(--muted); } .kv dd { margin:0; }

/* review list */
.toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line2); }
.toolbar .input { height:32px; }
.kol { display:grid; grid-template-columns:28px 44px minmax(0,1.3fr) minmax(0,1.6fr) minmax(0,1.3fr) 168px; gap:14px;
       padding:14px; border-bottom:1px solid var(--line2); align-items:start; outline:none; transition:background .15s, opacity .25s; }
.kol:last-child { border-bottom:0; }
.kol:hover { background:#fafbfc; }
.kol.focus { background:var(--accent-soft); box-shadow:inset 3px 0 0 var(--accent); }
.kol.gone { opacity:0; }
.kol .sel { padding-top:12px; }
.av { width:44px; height:44px; border-radius:50%; display:grid; place-items:center; color:#fff; font-weight:600; font-size:16px; }
.kol .who1 { display:flex; align-items:center; gap:6px; min-width:0; }
.kol .who1 b { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kol .handle { color:var(--muted); font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; }
.kol .fol { font-size:13px; margin-top:4px; } .kol .fol b { font-variant-numeric:tabular-nums; }
.kol .bio { color:var(--fg2); font-size:13px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;
            white-space:pre-line; }
.kol .src { font-size:12px; color:var(--muted); margin-top:6px; }
.mail { display:flex; align-items:center; gap:6px; font-size:13px; min-width:0; }
.mail + .mail { margin-top:4px; }
.mail .addr { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
.mail .ck { width:8px; height:8px; border-radius:50%; flex:none; background:var(--muted); }
.mail .ck.basic_ok { background:var(--ok); } .mail .ck.invalid { background:var(--bad); } .mail .ck.unknown { background:#f7ba1e; }
.nomail { color:var(--muted); font-size:13px; }
.kol .acts { display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap; }
.kol .state { font-size:12px; color:var(--muted); text-align:right; margin-top:6px; }
.kol-head { display:grid; grid-template-columns:28px 44px minmax(0,1.3fr) minmax(0,1.6fr) minmax(0,1.3fr) 168px; gap:14px;
            padding:8px 14px; color:var(--muted); font-size:12px; background:#fafbfc; border-bottom:1px solid var(--line2); }
.bulkbar { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#1d2129; color:#fff; border-radius:12px;
           padding:8px 8px 8px 16px; display:none; align-items:center; gap:10px; box-shadow:0 8px 24px rgba(0,0,0,.2); z-index:30; }
.bulkbar.on { display:flex; }
.bulkbar .btn { border-color:#4e5969; background:#2b2f36; color:#fff; } .bulkbar .btn:hover { background:#3a3f47; }
.toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#1d2129; color:#fff; border-radius:10px;
         padding:10px 10px 10px 16px; display:none; align-items:center; gap:12px; z-index:31; box-shadow:0 8px 24px rgba(0,0,0,.2); }
.toast.on { display:flex; } .toast button { background:none; border:0; color:#8fb0ff; font:inherit; cursor:pointer; font-weight:500; }
.keys { color:var(--muted); font-size:12px; } .keys kbd { display:inline-block; min-width:18px; padding:0 4px; border:1px solid var(--line);
        border-bottom-width:2px; border-radius:4px; background:var(--panel); font:11px/16px ui-monospace, monospace; text-align:center; }
.pager { display:flex; gap:8px; align-items:center; justify-content:center; padding:14px; border-top:1px solid var(--line2); }

/* job progress */
.steps { list-style:none; margin:0; padding:0; }
.steps li { display:grid; grid-template-columns:24px 1fr auto; gap:10px; padding:10px 0; border-bottom:1px solid var(--line2); align-items:center; }
.steps li:last-child { border-bottom:0; }
.steps .ic { width:22px; height:22px; border-radius:50%; display:grid; place-items:center; font-size:12px; background:var(--line2); color:var(--muted); }
.steps .ic.done { background:var(--ok-soft); color:var(--ok); } .steps .ic.run { background:var(--accent-soft); color:var(--accent); }
.steps .ic.fail { background:var(--bad-soft); color:var(--bad); }
.callout { display:flex; gap:16px; align-items:center; padding:18px 20px; border-radius:var(--radius);
           background:linear-gradient(90deg, #eef3ff, #f6f9ff); border:1px solid #d6e2ff; }
.callout .big { font-size:28px; font-weight:600; color:var(--accent-fg); font-variant-numeric:tabular-nums; }
.bar { height:6px; border-radius:3px; background:var(--line2); overflow:hidden; } .bar > i { display:block; height:100%; background:var(--accent); }

/* login */
.login { min-height:100vh; display:grid; place-items:center; padding:24px; }
.login .panel { width:100%; max-width:380px; }

@media (max-width: 960px) {
  .split, .g2, .g3 { grid-template-columns:1fr; } .g4 { grid-template-columns:repeat(2, minmax(0,1fr)); }
  .choice { grid-template-columns:1fr; }
  .kol, .kol-head { grid-template-columns:28px 40px minmax(0,1fr); }
  .kol-head { display:none; } .kol > .c-bio, .kol > .c-mail, .kol > .c-act { grid-column:3 / -1; }
  .kol .acts { justify-content:flex-start; } .kol .state { text-align:left; }
  .sticky { position:static; }
  main, .topbar .in, .tabs { padding-left:16px; padding-right:16px; }
}
`;

export interface Nav {
  project: { id: number; name: string };
  tab: "overview" | "kols" | "jobs" | "settings";
  pending?: number;
}

export function Layout(props: { title: string; operator?: string | null; nav?: Nav; children?: Child }) {
  const n = props.nav;
  const tab = (key: Nav["tab"], href: string, label: string, count?: number) => (
    <a href={href} class={n?.tab === key ? "on" : ""}>
      {label}{count ? <span class="badge info count">{count}</span> : null}
    </a>
  );
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · KOL 平台</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        {props.operator ? (
          <>
            <div class="topbar">
              <div class="in">
                <a class="brand" href="/"><i>K</i>KOL 平台</a>
                {n && <span class="crumb">/ <b>{n.project.name}</b></span>}
                <div class="who">
                  <span class="small">{props.operator}</span>
                  <form method="post" action="/logout"><button class="btn ghost sm">退出</button></form>
                </div>
              </div>
              {n && (
                <nav class="tabs">
                  {tab("overview", `/projects/${n.project.id}`, "概览")}
                  {tab("kols", `/projects/${n.project.id}/kols`, "审核名单", n.pending)}
                  {tab("jobs", `/projects/${n.project.id}/jobs`, "找人任务")}
                  {tab("settings", `/projects/${n.project.id}/settings`, "项目设置")}
                </nav>
              )}
            </div>
            <main>{props.children}</main>
          </>
        ) : props.children}
      </body>
    </html>
  );
}

/** "29.4 万" style follower counts, the way ops people read them. */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, "")} 亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1).replace(/\.0$/, "")} 万`;
  return n.toLocaleString("en-US");
}

/** "3 分钟前", falling back to a date after a week. */
export function ago(d: Date | string | null, now = Date.now()): string {
  if (!d) return "";
  const t = new Date(d).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} 天前`;
  return new Date(d).toLocaleDateString("zh-CN", { timeZone: "Asia/Taipei" });
}

export function PlatformIcon(props: { platform: string }) {
  const label: Record<string, string> = { instagram: "IG", youtube: "YT", tiktok: "TT" };
  return <span class={`pf ${props.platform}`} title={props.platform}>{label[props.platform] ?? "?"}</span>;
}

const AVATAR_COLORS = ["#3370ff", "#00a870", "#f77234", "#7b61ff", "#e34d59", "#0fc6c2", "#d25f00", "#245bdb"];

export function Avatar(props: { name: string; seed: number }) {
  const ch = [...(props.name.trim() || "?")][0].toUpperCase();
  return <div class="av" style={`background:${AVATAR_COLORS[props.seed % AVATAR_COLORS.length]}`}>{ch}</div>;
}

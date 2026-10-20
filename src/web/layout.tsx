import type { Child } from "hono/jsx";

const CSS = `
:root { --fg:#1f2329; --muted:#646a73; --line:#dee0e3; --bg:#fff; --soft:#f5f6f7; --accent:#3370ff; --ok:#2ea121; --bad:#d83931; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color:var(--fg); background:var(--bg); }
header { display:flex; gap:16px; align-items:center; padding:10px 20px; border-bottom:1px solid var(--line); }
header a.brand { font-weight:600; color:var(--fg); text-decoration:none; }
header .who { margin-left:auto; color:var(--muted); }
main { max-width:1200px; margin:0 auto; padding:20px; }
a { color:var(--accent); }
h1 { font-size:20px; margin:0 0 16px; } h2 { font-size:16px; margin:24px 0 8px; }
table { border-collapse:collapse; width:100%; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { background:var(--soft); font-weight:500; white-space:nowrap; }
td.bio { max-width:360px; color:var(--muted); font-size:12px; }
form.stack label { display:block; margin:10px 0 2px; color:var(--muted); }
input[type=text], input[type=number], input[type=password], textarea, select { width:100%; max-width:560px; padding:6px 8px; border:1px solid var(--line); border-radius:6px; font:inherit; }
textarea { min-height:64px; }
button { padding:6px 14px; border:1px solid var(--line); border-radius:6px; background:var(--bg); cursor:pointer; font:inherit; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
.tag { display:inline-block; padding:0 6px; border-radius:4px; background:var(--soft); font-size:12px; }
.ok { color:var(--ok); } .bad { color:var(--bad); } .muted { color:var(--muted); }
.cards { display:flex; gap:12px; flex-wrap:wrap; } .card { border:1px solid var(--line); border-radius:8px; padding:10px 14px; min-width:120px; }
.card b { display:block; font-size:20px; }
.flash { padding:8px 12px; background:#fff7e6; border:1px solid #ffd591; border-radius:6px; margin-bottom:12px; }
`;

export function Layout(props: { title: string; operator?: string | null; children?: Child }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · KOL 平台</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        {props.operator && (
          <header>
            <a class="brand" href="/">KOL 平台</a>
            <span class="who">{props.operator}</span>
            <form method="post" action="/logout"><button>退出</button></form>
          </header>
        )}
        <main>{props.children}</main>
      </body>
    </html>
  );
}

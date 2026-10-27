# kolpick · KOL 运营插件

KOL 外联工具：找人和公开邮箱、发邀约、收信、审核后发信、催信和结案、发码、追踪发布。运营电脑上的通用 agent（Claude、Codex）当大脑，做决定和起草；找人、查邮箱、收发信、建码等做成工具，agent 和运营都能用；运营在本机决策台审核，通过了就执行。数据放在 Zeabur 上的 Postgres；收发信用飞书邮箱（经本机 lark-cli）；找人和查邮箱调用 Apify 上的现成 actor。产品设计见 [docs/design.md](docs/design.md)。

现状（2026-10-27）：正式项目还由旧版插件 kol-ops 跑在飞书多维表格上；新版按 design.md 重新设计数据库后一次切换，旧版代码和说明届时一起替换。

安装和使用说明见 [plugins/kol-ops/README.md](plugins/kol-ops/README.md)。

## 代码结构

| 位置 | 内容 |
| --- | --- |
| `plugins/kol-ops/` | 插件本体：技能（`skills/`）、共同规则和字段说明（`reference/`），以及打包好的脚本 `scripts/kol.mjs`。项目专属的设置、发信邮箱和邮件模板不在这里，在各项目自己的表里 |
| `src/kolops/` | `kol.mjs` 的源码：各个命令、发信前的检查、执行器，以及项目表的标准结构（`schema.ts`） |
| `src/kolops/console/` | 决策台（`kol console`）的本机服务和页面 |
| `src/kolops/store/` | 存储层：项目表放在 Postgres 时，由它接住所有读写表的命令（`pg.ts`），加上本机副本、备份和 `kol db` 命令 |
| `src/discovery/` | 找人和查邮箱：actor 列表和价格（`apify.ts`）、各平台步骤（`pipeline.ts`）、整体流程（`run.ts`）；为什么这样选见 design.md「找人和查邮箱」 |
| `src/scripts/build-plugin.ts` | 把 `src/kolops/cli.ts` 打包成 `plugins/kol-ops/scripts/kol.mjs` |
| `.claude-plugin/marketplace.json` | 让 `/plugin marketplace add zhihao93li/kolpick#stable` 能找到插件 |

## 开发

需要 Node.js 22。

```bash
npm ci
npm test               # 包括直接运行打包后的 kol.mjs 的冒烟测试
npm run typecheck
npm run build:plugin   # 改了 src/ 之后重新打包
```

改完源码要重新打包，并把 `plugins/kol-ops/.claude-plugin/plugin.json` 的版本号加一。

## 发布

两条线：所有开发都在 `main` 上；同事从 `stable` 分支安装插件（`zhihao93li/kolpick#stable`），`stable` 只往前快进，不在上面直接改。在试用副本上验证过的版本，这样发布：

```bash
git switch stable && git merge --ff-only main && git push origin stable && git switch main
```

再给发布的版本打标签（版本号和 `plugin.json` 一致），然后告诉同事运行 `/plugin marketplace update kolpick` 并新开一个会话：

```bash
git tag kol-ops-v0.12.1 stable && git push origin kol-ops-v0.12.1
```

`main` 上有还没验证完的改动、又要急修线上时，只把那个修复挑到 `stable`：

```bash
git switch stable && git cherry-pick <修复的提交号> && git push origin stable && git switch main
```


## 文档

一种作用只有一份文档。要写的内容已经有归属，就改那一份，不另开新文档；方向变了，先改 `docs/design.md`，再顺着改其他文档里受影响的地方，旧的说法直接删掉，不留「以前是这样」。

| 文档 | 管什么 | 给谁看 |
| --- | --- | --- |
| [docs/design.md](docs/design.md) | 产品设计和已定的事：原则、怎么接 agent、各块怎么做、必须守住的规则、数据、上线步骤、和 TAFU 的分工、找人和查邮箱 | 你和开发 |
| [docs/data-api.md](docs/data-api.md) | 项目后台要开的 `kol-data` 接口约定 | 项目后台的开发 |
| 本文件 | 仓库结构、开发、发布 | 开发 |
| [plugins/kol-ops/README.md](plugins/kol-ops/README.md)、`reference/`、`skills/` | 现行旧版插件的安装、用法、规则和字段；切换时随新代码重写 | 运营同事、agent |

`output/` 下的复审报告和临时记录不进 git，不算文档。

## 历史

最早是一个找邮箱的 Python 脚本，后来做过一个部署在 Zeabur 的独立平台，2026 年 10 月改成插件，平台代码已删除。2026-10-27 按新的产品原则重新定了设计，之前的设计文档见 git 历史。

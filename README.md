# kolpick · KOL 运营插件

一个 Claude 桌面版插件（kol-ops），给运营同事做 KOL 外联：找人和公开邮箱、发邀约、收信、审核后发信、催信和结案。人在本机的决策台网页上做决定，执行器排队执行，Claude 只做准备。数据现在在飞书多维表格（测试项目 tafu-test 在 Postgres），以后所有项目一次切换到新的关系数据库（见 [docs/database-design.md](docs/database-design.md)）；收发信用飞书邮箱（经本机 lark-cli）。找人和查邮箱调用 Apify 上的现成 actor，支持 Instagram、YouTube、TikTok。

安装和使用说明见 [plugins/kol-ops/README.md](plugins/kol-ops/README.md)。

## 代码结构

| 位置 | 内容 |
| --- | --- |
| `plugins/kol-ops/` | 插件本体：技能（`skills/`）、共同规则和字段说明（`reference/`），以及打包好的脚本 `scripts/kol.mjs`。项目专属的设置、发信邮箱和邮件模板不在这里，在各项目自己的表里 |
| `src/kolops/` | `kol.mjs` 的源码：各个命令、发信前的检查、执行器，以及项目表的标准结构（`schema.ts`） |
| `src/kolops/console/` | 决策台（`kol console`）的本机服务和页面 |
| `src/kolops/store/` | 存储层：项目表放在 Postgres 时，由它接住所有读写表的命令（`pg.ts`），加上本机副本、备份和 `kol db` 命令 |
| `src/discovery/` | 找人和查邮箱：actor 列表和价格（`apify.ts`）、各平台步骤（`pipeline.ts`）、整体流程（`run.ts`）；为什么这样选见 design.md 第十一节 |
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
| [docs/design.md](docs/design.md) | 系统设计、规则、找人和查邮箱为什么这样选、已定的事、接下来做什么、改过的方向 | 你和开发 |
| [docs/behavior.md](docs/behavior.md) | 产品行为规格：状态、事件、闸门、自动规则和优先级、决策台卡片、编号场景（测试按编号写） | 你、开发、Claude 和 GPT 评审 |
| [docs/ui.md](docs/ui.md) | 决策台界面说明：每个页面、卡片、表单的布局和控件，各种状态怎么显示（按钮引用行为规格的编号） | 你和开发 |
| [docs/database-design.md](docs/database-design.md) | 数据库设计v1.11定稿：22张关系表、所有发送入口的约束、历史提醒迁移、收信补扫、一次切换与回退；尚未实施 | 产品、开发、测试与数据分析 |
| [docs/data-api.md](docs/data-api.md) | 项目后台要开的 `kol-data` 接口约定 | 项目后台的开发 |
| 本文件 | 仓库结构、开发、发布 | 开发 |
| [plugins/kol-ops/README.md](plugins/kol-ops/README.md) | 安装、接入项目、日常用法、切换到新数据库时要做什么 | 运营同事 |
| `plugins/kol-ops/reference/rules.md` | Claude 必须遵守的共同规则 | Claude |
| `plugins/kol-ops/reference/fields.md` | 项目表的表名、字段、选项 | Claude |
| `plugins/kol-ops/skills/*/SKILL.md` | 每个技能的步骤 | Claude |

`output/` 下的复审报告和临时记录不进 git，不算文档。

## 历史

最早是一个找邮箱的 Python 脚本，后来做过一个部署在 Zeabur 的独立平台，2026 年 10 月改成插件，平台代码已删除。方向怎么变过，见 [docs/design.md](docs/design.md)「改过的方向」。

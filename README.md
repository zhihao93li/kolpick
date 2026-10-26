# kolpick · KOL 运营插件

一个 Claude 桌面版插件（kol-ops），给运营同事做 KOL 外联：找人和公开邮箱、发邀约、收信、审核后发信、催信和结案。数据放在飞书多维表格，发信用飞书邮箱，都通过本机的 lark-cli 操作。找人和查邮箱调用 Apify 上的现成 actor，支持 Instagram、YouTube、TikTok。

安装和使用说明见 [plugins/kol-ops/README.md](plugins/kol-ops/README.md)。

## 代码结构

| 位置 | 内容 |
| --- | --- |
| `plugins/kol-ops/` | 插件本体：技能（`skills/`）、共同规则和字段说明（`reference/`），以及打包好的脚本 `scripts/kol.mjs`。项目专属的设置、发信邮箱和邮件模板不在这里，在各项目的飞书表里 |
| `src/kolops/` | `kol.mjs` 的源码：各个命令（`today`、`sync`、`send`、`invite`、`remind`、`find`、`check`、`project`、`setup-base`）、发信前的检查，以及项目飞书表的标准结构（`schema.ts`） |
| `src/discovery/` | 找人和查邮箱：actor 列表和价格（`apify.ts`）、各平台步骤（`pipeline.ts`）、整体流程（`run.ts`） |
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

为什么这样管、网页版怎么并行开发，见 [docs/web-db-design.md](docs/web-db-design.md) 第十一节。

## 历史

最早是一个找邮箱的 Python 脚本，后来做过一个部署在 Zeabur 的独立平台（PostgreSQL + 后台网页），2026 年 10 月改成现在的插件方案，平台代码已删除。当时的技术方案见 [docs/plan.md](docs/plan.md)，其中找人和查邮箱的实测结论仍然适用。

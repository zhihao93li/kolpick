---
name: kol-find
description: 运营同事要「找一批新 KOL」「按关键词/对标账号找人和邮箱」时使用：用 Apify 在 Instagram、YouTube、TikTok 上找人和公开邮箱，新人写进 KOL 档案。
---

# 找 KOL

先读 `${CLAUDE_PLUGIN_ROOT}/reference/rules.md`。

需要 Apify token，只存在这台电脑上：`~/.kol-ops/apify-token`（或环境变量 APIFY_TOKEN）。没有就请同事向 Emma 要，自己存进去；不要把 token 贴进对话或写进任何文件以外的地方。

1. 和同事确认：平台（instagram / youtube / tiktok）、找法（关键词 `--keywords`、对标账号 `--seeds`、或直接给账号 `--handles`）、粉丝范围、预算（美元）、入库批次名。入库批次请同事先在「KOL 档案」的「入库批次」里加好选项。
2. 试跑：

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/kol.mjs" find --platform instagram --keywords 親子,育兒 \
     --min-followers 5000 --max-followers 200000 --budget 20 --batch <入库批次> --job <这次的名字> --dry-run
   ```

3. 讲清楚参数和预算上限，同事同意后去掉 `--dry-run`。会跑一阵子，跑之前告诉同事。
4. 汇报：新入库几人、其中有邮箱几人、跳过多少（已在库里、不符合条件）、花了多少钱、是否因预算提前停。
5. 中途断了用同一个 `--job` 名重跑，已完成的 Apify 步骤不会再花钱。

找到的人直接进档案，没有额外的筛选步骤；没邮箱的也入库，免得下次重复花钱。要发邀约就接着用 kol-invite。

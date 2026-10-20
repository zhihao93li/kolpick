# kolpick

批量找 KOL 并查联系邮箱的脚本，支持 Instagram、YouTube、TikTok，底层调用 Apify 上的现成 actor。

每个平台的步骤和顺序来自 2026-10-20 对 150 人名单的实测：

| 平台 | 找人 | 查邮箱（从便宜到贵，找到就停） |
| --- | --- | --- |
| Instagram | 相似账号（种子账号扩展）+ 短关键词搜索 | 旧 actor 读商业号联系邮箱字段和简介 → 简介外链页面 |
| YouTube | 频道关键词搜索（结果自带简介） | 简介 → 外链页面 → 隐藏商务邮箱（可选，找到一个约 12 美分） |
| TikTok | 用户关键词搜索 | 简介 → 外链页面 |

实测结论：TikTok 按关键词搜出来的人混杂度很高（日本、大陆、小号都有），有邮箱的很少，建议 TikTok 主要用 `--handles-file` 直接查已知账号。

## 安装

```bash
pip install -r requirements.txt
export APIFY_TOKEN=...   # Apify Console > Settings > API & Integrations
```

令牌只从环境变量读取，不要写进代码或提交到仓库。

## 用法

```bash
# Instagram：用 10 个种子扩相似账号，再加关键词搜索，只要 3000 粉以上
python -m kolpick --platform instagram \
  --seeds fly_to_tang kikimakeup37 hanah.hk \
  --keywords 新秘 婚禮攝影 親子 \
  --min-followers 3000 --max-followers 300000 \
  --exclude contacted.csv \
  --max-spend 10

# YouTube：台湾区关键词搜频道，简介里没有邮箱的再查隐藏邮箱
python -m kolpick --platform youtube --keywords 新秘 婚禮攝影 親子 --youtube-hidden

# TikTok：直接查一批已知账号
python -m kolpick --platform tiktok --handles-file tiktok.txt

# 先看会花多少钱，不实际调用
python -m kolpick --platform instagram --seeds a b c --keywords 新秘 --dry-run
```

常用参数：

- `--handles` / `--handles-file`：直接查这些账号。文件可以是一行一个账号，也可以是带 `handle` 列的 CSV（有 `platform` 列时只取对应平台的行）。
- `--exclude`：已经联系过的人，CSV 里有 `handle` 或 `email` 列即可，可以给多个文件。
- `--per-seed`、`--per-keyword`：每个种子、每个关键词最多取多少人。
- `--chinese-only`：去掉名字和简介里没有中文（或带日文假名）的账号。
- `--no-link-pages`：不爬简介外链页面。
- `--max-spend`：本次最多花多少美元，达到后停止启动新任务，已找到的结果照样写出。

## 输出

默认写到 `output/<平台>-<时间>.csv`（UTF-8 带 BOM，Excel 可直接打开），有邮箱的排前面，按粉丝数从高到低：

| 列 | 说明 |
| --- | --- |
| email / email_source | 首选邮箱及来源：`platform_field`（IG 商业号联系邮箱）、`bio`（简介）、`link_page`（外链页面）、`youtube_hidden`（YouTube 隐藏邮箱） |
| all_emails | 找到的所有邮箱 |
| status | `has_email`、`no_email`、`filtered:<原因>`（私人账号、粉丝数不符、非中文）、`excluded:email_already_contacted` |
| discovered_by | `related`（相似账号）、`search:<关键词>`、`input`（自己给的名单） |

同目录下的 `.runs.json` 记录每次调用的 actor、run ID、dataset ID 和估算花费，方便回到 Apify 后台查原始数据。

## 花费参考（Bronze 档）

- Instagram：相似账号约 0.3 美分/人，查邮箱 0.45 美分/人 + 每次 4 美分启动费；实测每个找到的邮箱 1.5～2 美分。
- YouTube：搜索 0.07 美分/频道；隐藏邮箱 12 美分/个（找不到不收费）。
- TikTok：搜索 0.5 美分/人，查主页约 0.2 美分/人。

价格写在 `kolpick/apify.py` 的 `ACTORS` 里，用来估算和设置每次调用的花费上限；Apify 调价后改这里即可。

## 测试

```bash
python -m pytest -q
```

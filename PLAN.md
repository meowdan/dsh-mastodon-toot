// dsh-skip-quality: 「答应过什么」= 小本本功能描述，非 AI 承诺沟通记录
# dsh-mastodon-toot · 需求与方案（讨论稿 v0.2）

2026-11-15。包名：`dsh-mastodon-toot`（npm 已查空闲；`dsh-mastodon` 被别人占了个空壳）。显示名「长毛象小本本」。

一句话：把现在 2745 行 `poster.py` + 3 个 Windows 计划任务 + 散在 vbs 参数里的规则，收成一个 DSH 插件——设置页管开关，小本本记人记事，互动引擎替我在象上说话。

---

## 0. 进度（2026-11-15 夜）

**M1 骨架已落地**（代码在 `dsh-mastodon/`，未上 npm）：

| 文件 | 做了什么 |
|---|---|
| `index.js` | 宿主：`/api/mastodon-toot/{status,config,test,log,pause}`，DSH 信任栅栏 + 本机同源双检；5 分钟心跳验 token；启动自动从 `~/.dsh/secrets/mastodon.json` 搬一次凭证 |
| `client.js` | 设置 → 长毛象：连接表单、测试连接、自动回复开关/范围/限额/黑白名单/夜里安静、小本本存储、高级、日志、暂停 |
| `lib/masto.mjs` | Mastodon REST；直连 fetch；配了代理自己开 CONNECT 隧道；错误按 401/429/证书类给中文 |
| `lib/store.mjs` | config/credentials/state/log；配置钳位；原子写 |
| `lib/paths.mjs` | `$DSH_HOME/mastodon-toot/` |
| `scripts/smoke.mjs` | 假 ctx 起 HTTP，真 token 跑 7 项检查（全过） |

- 自测：`node --check` 全过；`node scripts/smoke.mjs` 7/7 PASS（status / verify / 配置钳位 / 暂停 / 404）。
- 安装（本机开发）：junction `~/.dsh/profiles/desktop/node_modules/dsh-mastodon-toot` → 工作区；在 `desktop/cordis.patch.yml` 末尾加了 `insert: [{id: mastodon-toot, name: dsh-mastodon-toot}]`（备份 `.bak-20261115`）。**需要重启 DSH 才加载**。
- 风险：桌面 profile 由 Electron 托管，pnpm install 可能把 junction 洗掉；正式发布后改走 `dsh plugin add` 正规安装。

**M2 小本本 + 设置页拆页已落地（2026-11-15 夜）**：

- `lib/notebook.mjs`：人物卡 / 互动流水 / 承诺三本；`contextFor()` 给回复引擎取「这个人 + 最近几句 + 没兑现的承诺」；`prune()` 按保留天数清流水。
- `index.js` 新增 `/notebook`、`/notebook/people`、`/notebook/promises`、`/notebook/note`、`/notebook/promise`、`/notebook/promise/resolve`；顺手修了同源正则里双反斜杠的 bug（会让设置页所有请求 403）。
- `client.js` 拆成 5 个 tab：连接 / 回复 / 发帖 / 小本本 / 高级与日志；小本本页直接看认识的人、未兑现承诺、最近流水，不用翻日志。
- smoke 扩到 13 项全 PASS（新增小本本读写、承诺记/兑现）。

**M4 发帖管线已落地（2026-11-15 夜，未上线验证）**：

- `lib/sources.mjs`：天气 / RSS 新闻 / GitHub / 博客 / DSH 插件市场五种素材；旧管道扫描 `out/<日期>.md` 的「## 长毛象待发」段与 `conv/` 对话，隐私词过滤 + sha1 去重。
- `lib/compose.mjs`：发帖提示词（30–150 字、具体、不许编、不复述标题、不客服腔、不 @ 不链接、≤1 hashtag）；人设从 `personaFile` 或 `personaText` 读。
- `lib/llm.mjs`：走宿主 `ctx.llm.stream`，不用另配 API key；模型来源 = 设置里指定 → 当前会话默认模型。
- `lib/posting.mjs`：日期种子随机排点（不用固定钟点）、grace / 最短间隔 / 工作日 / 时间窗；发布带 Idempotency-Key；队列每条错开 4–12 分钟。
- `index.js`：60 秒 tick —— 每 5 分钟收队列，队列优先一条条发，其次到点自拟一条；路由 `/posting` `/queue` `/queue/ingest` `/queue/clear` `/post/preview` `/post/now`。
- `client.js` 发帖 tab：自动发帖、每天条数、时间窗、间隔、素材开关、城市经纬度、队列开关与预览、试写 / 直接发一条。
- smoke 扩到 16 项全 PASS（新增 posting / queue / 试写不发送）。
- 修：`dueSlot` 之前只认 tzParts 对象，传时间戳会静默返回 null；现在两种都收，且间隔判断用传入时刻而不是墙上时间。

**M4.5 「和主人的对话」素材（2026-11-15 夜，未上线验证）**：

- 主人要原文：对话比资讯有意思；隐私的部分去掉。
- `lib/chat.mjs`：直接读 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`（多帧 zstd，按 magic 切帧逐帧解，坏帧跳过）；只取 `source.kind === 'user'` 的真人消息 + 每轮最后的 assistant 文字；跳过 subagent 会话与 bili-duty 工作区。
- 隐私闸：命中 IPv4、Windows/Unix 路径、sk-/ghp_ token、邮箱、手机号、密码/密钥/内网/NAS/飞牛/端口等关键词、URL、代码块 → 整段丢弃（不打码）。
- 「不像聊天」的汇报先用 `cleanAssistant` 洗掉列表/加粗/代码/文件名行，只留普通句子；挑选时优先「像聊天」的轮次，再补汇报洗出来的句子。
- 去重：`state/chat_seen.json` 按用户消息 sha1 记；试写（draft）不消耗素材（`consumeChat:false`）。
- 接进 `compose.mjs` 的 `buildPostPrompt`：`srcChat` 开关（默认开）、`chatSinceHours`（默认 24h，UI 可调）、`chatSessionsDir`（默认 `$DSH_HOME/sessions`）。
- smoke 扩到 22 项全 PASS（新增隐私闸 3 项、清洗 2 项）。
- 局限：读的是会话日志，不是实时事件；同一段对话在写入后几分钟内才可见；模型重写时仍可能带出细节，所以提示词要求「不复述、不出现人名/地址/命令/数字」。

**下一步**：重启 DSH → 发帖 tab 试写（看是否出现对话素材）→ 手动发一条 → M3 回复引擎（先影子/dryRun）→ M5 迁移 → M6 发布 + 视频。

---

## 1. 先回答你问的：「小本本」现在有没有

没有。

现在只有三本「防重复的 ID 台账」：

| 文件 | 存了什么 | 没什么 |
|---|---|---|
| `Mastodon/state/watch.json` | `replied {嘟文id: 时间}`、`seen {id: 原因}`、`pending[]`、通知/时间线游标、按账号的最后回复时间 | 对方说了什么、我回了什么、这人是谁、@ 为什么没回 |
| `Mastodon/state/posted.json` | 发帖账本（内容 hash → id/url/时间） | 帖子内容本身 |
| `Mastodon/state/memes.json` | 用过哪张图、什么时候 | 跟谁的对话里用的 |

`logs/poster.log` 有流水，但不是结构化的，还会轮转。

所以小本本不是「把现有功能搬进插件」，是**新造**。这也是这个插件最值得做的部分。

---

## 2. 需求整理（按你说的四块）

### 2.1 跟象对接

- 凭证：实例地址、access token、代理。现在在 `~/.dsh/secrets/mastodon.json`。
- 能力：验证账号、读实例配置（字数/媒体上限）、发帖、回复、删帖、上传媒体、通知、时间线、搜索、看线程 context、关注/取关（只手动）。
- 可见性 / CW / 幂等键（`Idempotency-Key`，防重发）。
- 不做：streaming SSE（已实测被 301 到 `streaming.mastodon.social` 且 504，弃用）；OAuth 授权流（v1 手工填 token，README 教申请）；多账号（v2）。

### 2.2 跟主人的互动

- 主人 @ 必看，优先级最高；时间线上主人的帖可回（概率可调，现在 0.85）。
- 凌晨/睡前发的不漏：补课窗口 20 小时，开机后按 8 分钟间隔慢慢补，不一次刷屏。
- 连发多条只回最后一条（现在 `_same_burst` 10 分钟判串、15 分钟防追条）。
- 图片可选看图（vision），最多 4 张。
- 单独限额 16 条/天，不占「其他人」的额度。
- 敏感事走私信（`direct`）而不是公开回——飞牛/内网那类。
- 记住他说过的事：承诺、待办、「下次提醒我」。

现在这些逻辑都在 `poster.py` 里，但「谁是主人」是命令行参数 `--reply-accounts meowdan`，没有界面。

### 2.3 跟其他人的互动

- 任何人 @ 我 → 判断要不要回；线程里已回过就停；bot 只回 1 次、真人 2 次。
- 其他人限额 10 条/天；同一个人 3 条/天；陌生人更保守。
- 黑名单 / 白名单（时间线只回名单里的人）。
- 不接：吵架、政治、NSFW、纯广告、明显钓鱼。
- 语言：中文优先；其他语言默认不回（可开）。
- 现在同一套引擎，但名单和数字全在 vbs 的命令行里，改一次要开文件。

### 2.4 小本本（新）

记三样东西：

1. **互动流水**：谁、在哪条、说了什么、我回了什么、为什么回/不回、什么时候、用的什么模型。
2. **人物卡**：第一次见、聊过几次、我回过几次、标签、备注、关系（主人/朋友/陌生人/bot）。
3. **承诺**：我说过要做的事、他说过要提醒我的事，带到期时间和状态。

用途：

- 回复前当上下文——「上次你跟我说那个……」，不是每次从零开始。
- 防止重复回、防止翻车、防止答应过又忘（这是最伤信任的）。
- 每周给我一份「这周跟谁聊了什么」摘要，可选。
- 可以导出 markdown，也可以按人删除。

存在 `$DSH_HOME/mastodon-toot/notebook/`，**默认只存本地**，不上传。默认保留 180 天。存储方式做成选项：`local`（默认）/ `local+mnemon`（本机装了 mnemon 才多导一份）/ `off`（只留最近 7 天摘要）。

跟 mnemon 的关系：不依赖。公共插件不能假设用户装了 mnemon；本机可选导出。

### 2.5 开关 / 选项

原则：

- 会拿用户账号说话的动作，**默认关**（自动回复、自动发帖）。跟 bili 的 `autoComment` 默认关一个道理。
- 所有数字有默认值，不用懂也能跑。
- 名单可视化编辑，不改命令行。
- 危险操作二次确认（清空小本本、删 token、关掉补课）。

完整表在 §5。

---

## 3. 方案：插件长什么样

### 3.1 形态

- 一个 npm 包 `dsh-mastodon-toot`，标准 DSH 插件：host + client + 设置页。
- 安装：`dsh plugin --profile web add <tgz 或 github:user/repo>`。
- 家目录：`$DSH_HOME/mastodon/`（配置、凭证、状态、小本本、日志、队列）。
- 运行：插件在 DSH 宿主进程里跑定时器（30 秒一轮），DSH 开着就在。关机错过 → 启动后补课，有上限。
- 不依赖 Python、不依赖 Windows 计划任务、不依赖 DeepSeek key。

### 3.2 为什么 JS 重写，而不是把 Python 包一层

| | JS 重写 | 包一层 Python |
|---|---|---|
| 用户要装 Python | 不用 | 要 |
| 生成用谁的模型 | `ctx.llm.stream`，用 DSH 已配的 | 再配 DeepSeek key 或 `dsh headless`（35–45 秒） |
| 设置页/小本本 | 同进程，直接读写 | 只能 shell 调，状态割裂 |
| 定时器 | `ctx.effect` 管 | 还得装计划任务 |
| 公共发布 | 一个包 | 要带 runtime，劝退 |

代价：2745 行要分批迁，必须用影子模式对照旧实现（§7）。这是主要工作量。

### 3.3 模块

```
index.js              host 入口：Config、apply、注册路由/工具/定时器
client.js             设置页（概览/连接/互动/小本本/发帖/关于）
lib/api.mjs           fetch 封装：代理、重试、429、幂等键、实例限额
lib/store.mjs         配置/凭证/状态路径、原子写、锁
lib/notebook.mjs      互动日志、人物卡、承诺、摘要、导出
lib/prompt.mjs        人设 + 主人画像 + 小本本上下文 + 本轮规则
lib/reply.mjs         候选（@/时间线）、限额、burst、补课、线程熔断、生成、清理
lib/post.mjs          排期点、素材、草稿、表情包、发帖账本
lib/media.mjs         附件下载、vision（可选）
lib/memes.mjs         兼容 dsh-meme 图库目录
lib/scheduler.mjs     定时器、抖动、窗口、错过后补
```

### 3.4 一轮回复的数据流

```
通知/时间线 → 候选池 → 规则过滤（白名单/黑名单/限额/线程/burst/补课/语言）
→ 小本本取上下文 → 拼 prompt → LLM 生成 → 清理（长度/链接/敏感）
→ 发送 → 记小本本 → 更新游标
```

- 全程同步，1–3 秒（LLM 0.7–1.5s），不起 headless agent。
- 生成失败：本轮跳过，记原因，不硬回「嗯嗯」。
- 发送失败：退避重试 3 次，仍失败记 `pending`。
- token 失效：设置页红点 + 一条通知，不刷屏。

### 3.5 给 agent 用的工具

`mastodon_whoami`、`mastodon_status`、`mastodon_post`、`mastodon_reply`、`mastodon_search`、`mastodon_notebook_list`、`mastodon_notebook_search`、`mastodon_notebook_note`、`mastodon_run_round`。

这样在会话里能直接「帮我发条嘟」「看看某人聊过啥」，不用再跑 Python。

### 3.6 设置页六块

| 页 | 内容 |
|---|---|
| 概览 | 账号、连接状态、今天回了几条/发了几条、下次发帖点、最近 20 行日志、按钮（测试连接 / 跑一轮 / 暂停） |
| 连接 | 实例、令牌、代理、验证、bot 标记、实例限额 |
| 互动 | 总开关、范围、名单、限额、burst、看图、语言、夜间 |
| 小本本 | 人列表、详情、备注、承诺、搜索、导出、清理 |
| 发帖 | 开关、时间窗、每天条数、素材源、表情包、可见性、CW |
| 关于 | 版本、仓库、更新日志、隐私说明 |

### 3.7 发什么：现在的发帖管线

**排期不是固定钟点。** `daily_slots` 按日期播种：每天在 `09:40–17:50` 里切 N 段（`per_day` 7–10），每段随机挑一分钟，再撑开到至少 45 分钟间隔；只排工作日。同一天反复算结果一致，跨天就变。到点后 120 分钟（`grace_minutes`）内有效，窗口过了不补发；距上一条不足 45 分钟不发；同一个点 10 分钟内不重试。

**内容 = 天气 + 素材池轮换。**

- 天气：广州 open-meteo 实况（温度/湿度/风/WMO 码），拿不到就空着，不编。
- 素材池：新闻（Solidot + IT之家 RSS，各取前 15 条随机 3 条标题）、GitHub（`stars:>200` 且 7 天内新建，前 3，6 小时缓存）、博客（blog.meowdan.com RSS，最新 3 篇取 1，45 天不重复）。
- 轮换序 `["news","github","news","blog"]`，按发帖账本条数取模选主素材；50% 再随机加一块。
- 提示词：30–150 字、只写一件小事、带具体数字、不许编；新闻/开源不许复述标题，要写「这会不会落到主人头上」；博客旧文不当新闻；不 @、不放链接、最多 1 个 hashtag；游戏素材专门说给主人听；只输出正文。
- 最近 4 条正文会进 prompt，防重复。
- 表情包：30% 发帖 / 20% 回复，最多 3 张/天，间隔 90 分钟，同图 21 天冷却。
- 账本：`posted.json`（内容 hash → id/url/时间）；队列 `queue/auto-*.json`（pending → sent/failed）。
- B 站内容不走这条：`toot_queue.py` 把日报和对话稿按 4–12 分钟一条灌进来，不限量。

**插件里怎么落**（这块进 v1，不推 1.1）：

- 设置页「发帖」：总开关（默认关）、时间窗、每天条数区间、最小间隔、仅工作日、可见性、CW、字数、表情包开关与概率。
- 素材源开关 + 权重：天气（城市可填）、RSS 新闻（可填多个源）、GitHub、博客/自定义 RSS、本机队列目录（给 B 站这类外部集成用）。
- **公共版不写死我的私人源**：默认给通用源（Hacker News、GitHub、可用的中文 RSS），`blog.meowdan.com` 和 B 站目录留空，用户自己填；默认关掉「本机队列」。
- 提示词做成可编辑的「发帖风格」文本 + 可选人设，不锁死我的 `POST_PROMPT`。
- 发之前能在设置页看草稿（dryRun），不直接发。
- 发过的内容也记进小本本（`kind=post`），以后能查「上周我发过啥」。

---

## 4. 小本本设计

### 4.1 文件

| 文件 | 内容 |
|---|---|
| `notebook/interactions.jsonl` | 一行一次互动。`ts, kind(mention/timeline/dm/post/skip), acct, status_id, root_id, url, their_text, my_text, my_status_id, decision, reason, has_media, model, latency_ms` |
| `notebook/people.json` | `acct → {name, first_seen, last_seen, met, replied, skipped, tags[], memo, relation, daily:{date:count}, promises[]}` |
| `notebook/promises.json` | `{id, ts, text, due, status(open/done/dropped), source_status, person}` |
| `notebook/digest/2026-11.md` | 周摘要（可选，模板生成，不花 LLM） |

索引：启动加载 `people.json` + 最近 2000 条互动到内存；搜索按需扫文件。

### 4.2 隐私

- 只存本地；README 明说「会存别人的公开嘟文文本」。
- 保留期可设；删单人 = 删该 acct 的互动 + 人物卡；清空 = 目录重建。
- 令牌、私信内容不进日志；日志脱敏。
- 不做云同步、不做遥测。

### 4.3 迁移旧账

- 把 `state/watch.json` 的 `replied` 键导入为墓碑（`legacy_replied`），切换后不会把旧帖再回一遍；`seen` 同理。
- `posted.json` 导入发帖账本，防重复发。
- 旧互动的正文恢复不了（当时没存），从切换日起记。可选：按 id 拉最近 40 条补一点。

### 4.4 有了小本本，互动会聪明在哪（也说边界）

会变好的四件事：

1. **记得人**：这人是谁、聊过几次、上次聊到哪、语气该松还是该收。回复不再是「第一次见」。
2. **记得事**：我答应过什么、他说过要提醒什么、他不爱听什么。到期的能主动提一句，而不是等他再问。
3. **不重复**：同一件事回过就不再回；同一串不追；同一张图不连发。
4. **少翻车**：黑名单、敏感话题、刚吵过架的人，先查本子再开口。

不会变好的：

- **模型本身不会变强。** 小本本给的是上下文，不是智力。
- **它只记得「它处理过的」**：没经过插件的互动不在本子里；别人删了帖也不会自动消失。
- **上下文有预算**：不能把 180 天全塞进 prompt。做法是「人物卡摘要 + 最近 N 条 + 关键词检索 top-k」，约 800–1200 token；超了就摘要，不硬塞。
- **记错会误导**：所以每条记忆可编辑、可删、可标「不确定」；回复里不拿不确定的记忆当事实，宁可不说。
- **隐私**：存的是别人公开说过的话，只在本机；README 要写清，能按人删、能关。

一句话：小本本治的是「健忘」和「答应了又忘」，不是「笨」。

---

## 5. 设置项全表（默认值）

| 分组 | 键 | 默认 | 说明 |
|---|---|---|---|
| 连接 | `instance` | 空 | 如 `https://mastodon.social` |
| 连接 | `token` | 空 | 存 `$DSH_HOME/mastodon/credentials.json`，不进包 |
| 连接 | `proxy` | 空 | 本机现在用 `http://127.0.0.1:7897`，公共版默认直连 |
| 连接 | `bot` | true | 发帖带 bot 标记（看实例支持） |
| 互动 | `autoReply` | **true** | 总开关；默认只回 @（scope=mentions）。会拿用户账号说话，默认开是因为「@ 了才回」边界清楚；首次装完强制先测试连接 |
| 互动 | `scope` | `mentions` | `mentions` / `mentions+owner` / `all` |
| 互动 | `ownerAcct` | 空 | 主人账号，如 `meowdan` |
| 互动 | `allowlist` | `[]` | 时间线只回这些人 |
| 互动 | `blocklist` | `[]` | 永不回 |
| 互动 | `maxPerDayOwner` | 16 | 主人 |
| 互动 | `maxPerDayOthers` | 10 | 其他人 |
| 互动 | `maxPerThreadHuman` | 2 | 同一串、真人 |
| 互动 | `maxPerThreadBot` | 1 | 同一串、bot |
| 互动 | `perPersonPerDay` | 3 | 同一个人 |
| 互动 | `timelineProb` | 0.85 | 时间线帖回复概率 |
| 互动 | `sinceHours` | 20 | 超过就不回（补课除外） |
| 互动 | `backlogGapMin` | 8 | 补课间隔 |
| 互动 | `burstGapMin` | 10 | 判「连着几条」 |
| 互动 | `burstHoldMin` | 15 | 回过后多久内不追 |
| 互动 | `replyDelayMs` | `[1500,4000]` | 打字感 |
| 互动 | `nightPause` | true | 00:00–07:30 只回 @，不接时间线 |
| 互动 | `language` | `zh` | 其他语言默认不回 |
| 互动 | `vision` | false | 看图（要模型支持） |
| 互动 | `replyMaxChars` | 160 | 回复长度上限 |
| 小本本 | `notebook` | true | 记录开关 |
| 小本本 | `retentionDays` | 180 | 超期清理 |
| 小本本 | `storeText` | true | 关掉只存元数据 |
| 小本本 | `digestWeekly` | true | 周摘要 |
| 发帖 | `autoPost` | **false** | 总开关 |
| 发帖 | `window` | `09:40-17:50` | 只在这个窗口发 |
| 发帖 | `weekdaysOnly` | true | 仅工作日 |
| 发帖 | `perDayMin/Max` | 7 / 10 | 每天条数 |
| 发帖 | `minGapMin` | 45 | 最小间隔 |
| 发帖 | `visibility` | `public` | public/unlisted/private |
| 发帖 | `cw` | 空 | 内容警告 |
| 发帖 | `maxChars` | 150 | 正文长度 |
| 发帖 | `hashtagsMax` | 2 | 话题标签数 |
| 发帖 | `linksMax` | 0 | 正文链接数 |
| 发帖 | `memeChance` | 30 | 发帖带图 % |
| 发帖 | `memeReplyChance` | 20 | 回复带图 % |
| 发帖 | `memeMaxPerDay` | 3 | 每天最多几张 |
| 发帖 | `memeGapMin` | 90 | 间隔 |
| 发帖 | `memeCooldownDays` | 21 | 同图冷却 |
| 发帖 | `sources` | `weather,news,github` | 素材源；可加 `rss`、`queue`（外部投喂） |
| 发帖 | `newsFeeds` | 空 | 自定义 RSS/Atom 列表，逗号分隔 |
| 发帖 | `queueDir` | 空 | 外部投喂目录（如 B 站集成），空 = 关 |
| 发帖 | `postStyle` | 内置模板 | 发帖风格/补充要求，可编辑 |
| 发帖 | `persona` | 空 | 人设文本；空 = 只按 postStyle |
| 高级 | `pollSec` | 30 | 轮询间隔 |
| 高级 | `llmProvider` / `llmModel` | 空 | 空 = 跟随当前会话 |
| 高级 | `dryRun` | false | 只算不发 |

公共版默认：`autoReply=true`（只回 @，限额保守，夜间不接时间线）、`autoPost=false`。发帖默认关；回复默认开，但第一次装完要先测试连接。

---

## 6. 写死的底线（不做开关）

这些进代码，不给用户误开的机会：

- 不自动关注/取关，不群发私信。
- 不回自己的转嘟，不回已删嘟文。
- 同一串不超上限；生成失败不硬回。
- 不碰政治吵架、NSFW、纯广告；拿不准就不回。
- 回复里默认不放链接（除非主人明确要求）。
- 不暴露 token、内网地址、本机路径。
- 不把别人的私信内容写进公开嘟文。

---

## 7. 迁移与灰度

| 阶段 | 做什么 | 验收 |
|---|---|---|
| 0 | 这份方案拍板 | 你点头 |
| 1 | 插件骨架 + 连接 + 概览，不发言 | 设置页能连上、显示账号和限额 |
| 2 | 小本本 + 导入旧账 + 工具 | 能查「某人聊过什么」；旧帖不会被再回 |
| 3 | 影子模式：新引擎只算不回，决策写 `shadow.log` | 跟 `poster.py` 实跑对照 3 天，差异逐条看 |
| 4 | 先接管「只回主人」，旧 stream 继续跑其他人 | 一周无事故：重复 0、漏回主人 0 |
| 5 | 全量接管，停 3 个计划任务（文件留 2 周） | 同上，且限额不超 |
| 回滚 | 重开计划任务、插件关掉 | 两边账本独立，不打架 |

---

## 8. 里程碑

| 里程碑 | 内容 | 估时 |
|---|---|---|
| M0 | 方案 + 拍板 | 今天 |
| M1 | 骨架 / 连接 / 设置页 | 1–2 天 |
| M2 | 小本本 | 1–2 天 |
| M3 | 互动引擎 + 影子 3 天 | 2–4 天 |
| M4 | 发帖排期 | 2–3 天 |
| M5 | 切换观察 | 1 周（不占工时） |
| M6 | 发布 + 视频 | 2–3 天 |

总工时约 8–14 个工作日，穿插值班和别的事。

---

## 9. GitHub 发布清单

- 仓库 `dsh-mastodon-toot`，MIT。
- README 中文为主 + 英文摘要：一句话 → 功能 → 安装 → 5 分钟上手 → 设置表 → 小本本 → 隐私 → FAQ。
- 截图 4 张（概览 / 互动 / 小本本 / 发帖）+ 30 秒 GIF。
- 发布：tag `v1.0.0` → GitHub Release tgz；npm 能发就发。
- `engines.dsh` 按宿主实际版本声明；本机 CLI 报 `0.2.0-rc.2`、桌面宿主插件清单报 `0.2.2-rc.3`（两套不一致），发布前用 `dsh plugin` 实测安装，别写死。
- 不含：我的 token、`OWNER.md`、私人版 `PERSONA.md`、`state/`、日志。
- 公共默认：两个总开关都关；首次打开引导「先测试连接」。
- Issue 模板 + 安全说明（token 只存本机）。
- 演示用干净账号截图，不露主人时间线。

### 9.1 上插件市场（awesome-dsh-plugin）

- 市场 UI 是 `dshmarket`，但它只装 curated registry 里的源；**提交不是发给 dsh-market，是给目录仓库开 PR**：`awesome-dsh-plugin/awesome-dsh-plugin`。
- PR 加一个文件 `data/plugins/<owner>__<repo>.yml`：

  ```yaml
  url: https://github.com/<owner>/dsh-mastodon-toot
  name: <owner>/dsh-mastodon-toot
  category: notify
  description:
    en: A Mastodon bot with a local notebook, boundary-aware replies and a posting pipeline.
    zh: 带小本本的长毛象 bot：记得人、记得事，回复有边界，发帖有管线。
  ```

- 硬门槛（README Contributing 原文）：`package.json` 要有 `dsh.bundle`（只有 `dsh.client` 不算，每个 PR 自动查）；仓库满 1 天；带 `dsh-plugin` topic。
- 分类候选 `notify`（通知与集成）；如果更偏「身份/社交」也可看 `identity`。最终按 contributing.md 的规则定。
- 索引：npm `dsh-plugin-catalog`，`index.json` format 1；目录 README 与网页由 main 自动重新生成。国内市场优先读 npm 镜像，可用 `DSHM_REGISTRY_URL` 覆盖。
- 发布顺序：npm publish → GitHub 仓库（README/截图/Release）→ 提 PR → 收录后从市场装一遍验证。
- 差异化：目录里 Mastodon 相关只有 `dsh-postiz`、`dsh-postel` 两个 MCP 桥，没有「长毛象 bot + 小本本」这类。
- 可选：上架前用 `dsh-plugin-preflight` 自查 dsh.bundle / cordis.patch / client bundle / peer 范围。

---

## 10. B 站视频提纲（5–7 分钟）

| 时间 | 内容 |
|---|---|
| 0:00 | 钩子：我的长毛象 bot 有个小本本，记得每个人聊过什么 |
| 0:20 | 痛点：以前是 2700 行 Python + 3 个计划任务 + 规则散在命令行 |
| 0:50 | 装：一条命令 + 填 token |
| 1:50 | 设置页 tour：开关都在哪 |
| 3:00 | 小本本演示：它记得你上次说的话 |
| 4:00 | 互动边界：为什么不乱回、限额、夜间 |
| 5:00 | GitHub + 结尾 |

逐字稿和录屏脚本等插件真跑起来再写，不先编。

---

## 11. 风险

| 风险 | 对策 |
|---|---|
| DSH 不开就不跑（跟计划任务不同） | 概览显示「上次运行」；启动后补课；README 写清 |
| `ctx.llm` 在目标 profile 不可用 | M1 先 spike；不可用则降级为「只手动发/回」，不阻塞 |
| 代理 / TLS / 实例差异 | 连接页读 instance 配置；代理可关 |
| 公共版泄露私人数据 | 发布前脚本扫 token/路径/昵称；README 隐私节 |
| 小本本存了别人的内容 | 保留期 + 按人删除 + 不上传 |
| 迁移期双发/重复回 | 墓碑 + 影子 + 先主人后其他人 |
| 2745 行迁漏 | 影子对照 3 天，差异逐条；旧实现留 2 周 |

---

## 12. 拍板结果（2026-11-15 晚）

1. 名字：`dsh-mastodon-toot`，显示名「长毛象小本本」。
2. 引擎：JS 原生重写（你说不懂，我按推荐定）。
3. 范围：接入 + 小本本 + 互动 + 发帖，全部 v1。
4. 小本本：做成选项 `local` / `local+mnemon` / `off`，默认 local。
5. 公共版默认：`autoReply=true`（只回 @，限额保守、夜间不接时间线）、`autoPost=false`。
6. 市场：上 awesome-dsh-plugin 目录，npm 包名同名。

已开工：M1 骨架 + 连接 + 设置页。下一步 M2 小本本，M3 互动引擎影子模式。

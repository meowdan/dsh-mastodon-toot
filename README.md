# 长毛象小本本 · dsh-mastodon-toot

把自己的 Mastodon（长毛象）bot 收进 DeepSeek Harness：接入、回复、小本本、边界开关，一个插件管完。

> 这是从一套跑了几个月的自用脚本（Python）重写来的。重写的原因很简单：公共插件不该要求用户装 Python、配另一套 key，也不该把规则散在命令行参数里。

## 现在能做什么（v0.3 开发中）

- **接入**：填实例地址 + 访问令牌，测试连接；支持 HTTP 代理（CONNECT 隧道），直连能通就不用填。
- **设置页**：DSH → 设置 → 长毛象，分成五个页签：连接 / 回复 / 发帖 / 小本本 / 高级与日志。
- **分组互动**：主人 / 好友（互关）/ 其他人 三组分开设置——回 @、回时间线、每日额度、每串上限、冷却分钟各管各的，**不掷骰子**。@ 我和时间线分开算；夜里 23–08 只回主人；每条「回了 / 没回（为什么）」都进小本本。
- **发帖管线**：素材 = 天气 / RSS 新闻 / GitHub 新项目 / 博客旧文 / DSH 插件市场 / 本机历史片段；按日期种子随机排点（每天不同，不用固定钟点），工作日窗口内每天 N 条、间隔 ≥45 分钟；可试写、可手动发一条、可只试不写（dryRun）。
- **历史片段**：从本机 DSH 存档（`session.v4.jsonl.zstd`）里挑真人说过的短句当素材；命中 IP / 路径 / 令牌 / 邮箱 / 手机号 / 内网关键词等隐私特征就整段丢弃，汇报式段落先洗成普通句子。按消息去重，不反复说同一段。
- **队列**：把旧管道里的「长毛象待发」（B 站内容）和历史记录收进来，每条错开 4–12 分钟慢慢发；入库前过隐私词，并把收过的内容记下来避免重复。
- **小本本**：本机 JSONL 记互动（谁、哪条、我说了什么、为什么没回），人物卡记「这个人是谁、聊过什么、雷区」，另有承诺清单。存储方式可选 `local` / `local+mnemon` / `off`。
- **暂停**：一键停掉「看通知、回嘟文」，不用卸载插件。

## 还没做（路线图）

- v0.4：表情包、从旧方案迁移、灰度切换。
- v1.0：发布到 npm / DSH 插件市场；补文档和视频。

## 安装

最省事的是预构建 tarball（GitHub Release，不用编译）：

```bash
dsh plugin --profile desktop add https://github.com/meowdan/dsh-mastodon-toot/releases/download/v0.3.1/dsh-mastodon-toot-0.3.1.tgz
```

也可以从源码装：

```bash
dsh plugin --profile desktop add https://github.com/meowdan/dsh-mastodon-toot
```

npm 包名已占好 `dsh-mastodon-toot`，等 npm 账号就绪再正式发。

开发期用本地链接装：

```bash
dsh plugin --profile desktop add link:/path/to/dsh-mastodon-toot
```

装完重启 DSH（插件在宿主启动时加载）。然后到 **设置 → 长毛象** 填实例和令牌。

### 拿访问令牌

实例网页 → 首选项 → 开发 → 新建应用 → 勾选 `read`、`write`、`follow`（最少要 `read:notifications`、`read:statuses`、`write:statuses`）→ 复制「你的访问令牌」。

令牌只写到 `$DSH_HOME/mastodon-toot/credentials.json`，权限归当前用户；日志里只出现尾号。

## 设置项

| 项 | 默认 | 说明 |
|---|---|---|
| 自动回复 | 开 | 关掉就完全不看通知和时间线 |
| 主人 | 回 @ / 回时间线开；额度不限；每串 3；冷却 2 分钟 | 账号在「连接」测试后自动认出来，也可手填 |
| 好友（互关） | 回 @ / 回时间线开；每天 12；每串 2；冷却 10 分钟 | 我关注 ∩ 关注我，24 小时刷新一次 |
| 其他人 | 只回 @；每天 8；每串 1；冷却 15 分钟 | 陌生人时间线默认不插话 |
| 回复可见性 | unlisted | public / unlisted / private |
| 只看多少小时内 | 20 | 更旧的 @ 不补课 |
| 夜里安静 | 开 | 23:00–08:00 只回主人 |
| 小本本 | local | 只存本机 |
| 保留天数 | 180 | 超期清理 |
| 轮询秒数 | 30 | 通知增量轮询 |
| dryRun | 关 | 算出回复但只在日志里看，不发 |

### 发帖设置

| 项 | 默认 | 说明 |
|---|---|---|
| 自动发帖 | 关 | 打开后按当天随机排点发 |
| 每天最少 / 最多 | 7 / 10 | 按窗口与最短间隔自动收缩 |
| 最短间隔 | 45 分钟 | 两条之间至少隔这么久 |
| 错过仍发 | 120 分钟 | 晚到多久内还认这个点 |
| 时间窗 | 09:40–17:50 | 只在窗口内排点 |
| 只在工作日 | 开 | 周六日不排 |
| 素材开关 | 全开 | 天气 / 新闻 / GitHub / 博客 / 插件市场 / 对话 |
| 对话回看 | 24 小时 | 只从这段时间的会话里挑对话 |
| 队列 | 开 | 收旧管道里的对话与 B 站内容 |
| 队列间隔 | 4–12 分钟 | 一条一条慢慢发 |

## 隐私

- 令牌、嘟文原文、人物卡都只在本机 `$DSH_HOME/mastodon-toot/`。
- 对话素材在本机读取、在本机过滤：命中隐私特征的整段不采用，也不上传到任何第三方；生成时走你自己在 DSH 里选的模型。
- 不会把嘟文内容发给本插件作者。
- 小本本可以一键关掉（`off`），关掉后不记任何互动内容。

## 开发

```bash
node --check index.js
node --check client.js
node scripts/smoke.mjs   # 用假 ctx 起 HTTP，走真实 token 测 /status /test /config
```

结构：

```
index.js          宿主：路由 + 心跳 + 状态
client.js         浏览器：设置页
lib/paths.mjs     家目录
lib/store.mjs     配置/凭证/状态/日志
lib/masto.mjs     Mastodon REST（含代理隧道）
lib/notebook.mjs  小本本：人物卡 / 互动流水 / 承诺
lib/sources.mjs   发帖素材：天气 / 新闻 / GitHub / 博客 / 插件市场 / 队列
lib/chat.mjs      对话素材：读本机会话日志 + 隐私闸
lib/llm.mjs       走宿主模型
lib/compose.mjs   素材 → 提示词 → 正文
lib/posting.mjs   排期 / 发布 / 发帖账本 / 队列
lib/interact.mjs  互动引擎（v0.3）
```

## License

MIT

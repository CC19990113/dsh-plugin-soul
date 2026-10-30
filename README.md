# dsh-plugin-soul

> A writable, git-versioned **self** for DeepSeek Harness — persona files injected every turn, gated self-editing, journal→dream reflection, and a **Settings › 人格** tab.

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）一个**可写、可回滚、每轮在场**的自我：不是一个设定一次的人格，而是能长的那种。

### 记忆层：只管「性格 + 对话」

```
MEMORY.md          长期人格记忆（注入，3000 字符预算）
memory/YYYY-MM-DD.md  日笔记（不注入，soul_recall 检索）
```

记什么：**关于我**（自我认识）· **关于你**（对你的认识）· **对话里的事** · **我学到的教训** · **偏好怎么变**。
不记什么：项目代码、技术决策、环境配置、踩坑 —— 那些归项目记忆，塞进来会把每轮注入的预算吃光。

journal 聚合按**主题 key**（如 `identity:name`）走，不按整句 —— 否则每次换个措辞就变成新候选，永远凑不够 3 次。没给 key 的旧观察仍按整句归一化（向后兼容）。

每次升格成功会补一次 git 提交（`soul: promote N 条日记忆 → MEMORY.md`），所以长期记忆也 `git log` 可追、`soul_rollback` 可退。

升格规则抄的是「被反复用到才毕业」：日笔记不注入，只有被 `soul_recall` 命中 **≥3 次** 的条目才够格，
`action:"promote"` 时按维度写进 `MEMORY.md` 对应小节（带 `来源 memory/...#L3；命中 4 次`）。

### 人类评分决定写入闸门

每条 assistant 回复的操作栏里多三档：**👎 / 😑 / 👍**（挂在 `conversation.chat.assistant-actions` 槽位，官方 👍👎 旁边）。

```
weight = Σ(score × 0.5^(ageDays/7)) / Σ(decay)  → 映射到 [0,1]
score ∈ {-1, 0, +1}；只取最近 20 条；样本 <3 时不设闸门（冷启动不拦）
```

| 权重 | 效果 |
|---|---|
| 无样本 / <0.35… | 样本不足 → 不设闸门；<0.35 → **拒绝写人格**（只许写 journal / 日笔记） |
| 0.35 ~ 0.6 | 只许小修（单次 ≤300 字符） |
| ≥0.6 | 正常写入（≤800 字符） |
| ≥0.75 | 日笔记升格门槛从 3 次降到 **2 次**（好评加速毕业） |

每次写入都把当时的 `rating=` 记进 CHANGELOG，事后可回查"这条人格是在什么评价下写进去的"。

## 为什么不用 `@deepseek-ai/dsh-persona`

官方 persona 插件的 config 只有 `prefix / suffix / complete / includeRuntimeContext`，**全是静态字符串**——改一次人格要动 profile patch 并重启。

而 `dsh-system-prompt` 的 `section.text` 支持**函数**（每次 assembly 求值）。本插件就是吃这个口子：**每轮重新读文件**，所以改 Markdown 立刻生效，不用重启。

## 能力

| 层 | 做什么 |
|---|---|
| **注入** | 每轮把 `~/.dsh/soul/*.md` 读进 system prompt（约 2.1k 字符 ≈ 535 tok） |
| **自改** | `soul_update` 改可写文件：RULES 只读 / 单次 ≤800 字符 / 每日 ≤3 次 / `why` 必填；每次落 git + CHANGELOG，可回滚 |
| **反思** | `soul_journal` 记观察 → `soul_candidates` 聚合（**按主题 key**，≥3 次且跨 ≥2 天才够格）→ `soul_dream` 合并升格进 SOUL，并写 `DREAMS.md` |
| **升级** | `soul_propose_upgrade` 落提案（含改前快照）→ `soul_apply_upgrade` 必须 `confirm:"APPLY"`；白名单 + 逐个 `node --check`，语法不过整体还原 |
| **评分** | 每条回复下面 👍/😑/👎 三档；加权算成权重，**决定人格文件能不能写、能动多大** |

外加设置页一个 **「人格」tab**：看配置、就地编辑（带 why）、看记忆/评分/候选池/提交/diff。

## 安装

**推荐：DSH 内置安装器**

设置 → 插件 → 添加插件，填：

```
CC19990113/dsh-plugin-soul
```

也可以填完整仓库地址 `https://github.com/CC19990113/dsh-plugin-soul`，或 npm 包名 `dsh-plugin-soul`（[npm](https://www.npmjs.com/package/dsh-plugin-soul)）。装完**重启 DSH**。

**手动（开发用）**

```bash
git clone https://github.com/CC19990113/dsh-plugin-soul ~/www/dsh-plugin-soul
cd ~/www/dsh-plugin-soul
node install.mjs          # 预演：建 symlink + 追加 patch 行（自动备份）
node install.mjs --apply
```

然后重启 DSH。卸载：删 symlink + patch 里 `id: soul` 那段。

## 首次使用

首次加载会在 `~/.dsh/soul/` 播种四份文件并 `git init`：

```
~/.dsh/soul/
  IDENTITY.md   名字 / 化身 / 口癖          （可写，1200 字符预算）
  SOUL.md       声音 / 立场 / 边界          （可写，4000）
  USER.md       对用户的模型（指令式）      （可写，2500）
  MEMORY.md     长期人格记忆                （可写，3000）
  RULES.md      硬规则（只读锚点）          （2000，agent 改不了）
  journal/      日间观察
  memory/       日笔记（不注入，可检索）
  DREAMS.md     反思记录
  CHANGELOG.md  每次自改的 why
```

直接说人话就行：

- 「把 `IDENTITY.md` 里的名字定成 XX」
- 「以后都用中文，记到 USER.md」
- 「跑一次 soul_dream 看看有什么值得沉淀的」

## 两条记忆，别混

| | 记什么 | 谁管 |
|---|---|---|
| **人格记忆** | 我对自己的认识 · 对你的认识 · 对话里发生过的事 · 我学到的教训 · 偏好怎么变 | 本插件（`~/.dsh/soul/MEMORY.md` + `memory/`） |
| **项目记忆** | 代码结构、技术决策、环境配置、踩坑 | 别的地方（项目记忆 / 你自己的知识库）——**不归人格插件** |

为什么要划这条线：`MEMORY.md` 每轮注入、有 3000 字符预算，塞技术台账会把预算吃光，也会让人格记忆变成第二个 README。

## 工具

| 工具 | 用途 |
|---|---|
| `soul_status` | 文件字符/预算、今日额度、候选数、最近反思 |
| `soul_read` | 读原文（带行号），也支持 `DREAMS.md` / `CHANGELOG.md` |
| `soul_history` | 最近提交、某文件 diff、升级提案 |
| `soul_update` | 改可写文件（`content` 或 `append`，`why` 必填） |
| `soul_rollback` | 回到历史提交 |
| `soul_journal` | 记一条观察（便宜、不限次）；**同一主题用同一个 `key`** 才能跨天聚合 |
| `soul_candidates` | 看候选池（是否够格、证据行号） |
| `soul_dream` | 跑反思；默认预览，`apply:true` 才写 SOUL；可传 `narrative` |
| `soul_remember` | 记一条人格记忆（kind: self/user/talk/lesson/pref） |
| `soul_recall` | 检索人格记忆；命中即 +1 hit，是升格的唯一依据 |
| `soul_memory` | 记忆状态 / `action:"promote"` 把够格的写进 MEMORY.md |
| `soul_ratings` | 看评分样本、权重、写入闸门与升格门槛 |
| `soul_propose_upgrade` | 落升级提案（含 before 快照） |
| `soul_apply_upgrade` | `confirm:"APPLY"` 才写；语法不过整体还原 |
| `soul_upgrade_rollback` | 从提案 `before/` 还原 |

## 设置页「人格」tab

客户端插件注册 `settings.section`（`id: soul`、`order: 25`、`label: () => "人格"`），数据走同源 HTTP：

```
GET  /dsh-plugin-soul/api/state        文件 + 候选 + 提交 + lastDream
GET  /dsh-plugin-soul/api/file?name=   原文
POST /dsh-plugin-soul/api/file         写（同一套四道校验）
POST /dsh-plugin-soul/api/dream        跑一次反思
GET  /dsh-plugin-soul/api/diff?name=   相对上一提交的 diff
GET  /dsh-plugin-soul/api/dreams       DREAMS.md 全文
POST /dsh-plugin-soul/api/rating       {sessionId, messageId, score}
GET  /dsh-plugin-soul/api/ratings      权重 + 闸门
```

浏览器半侧是 CJS factory（`window.__ModuleLoader__.load`），只 `require("react")`，没有构建步骤。

## 自动反思（可选）

本插件不自带定时器。想要每晚自己反思一次，用 DSH 的 `schedule_create` 建一个 daily 任务，prompt 例如：

```
夜间自我反思：1) soul_candidates 看候选；2) 用 80-180 字写一段第一人称自省；
3) soul_dream({apply:true, narrative:"<那段>"})，然后一句话汇报。
```

## 设计取舍

- **确定性管资格，模型管措辞**：能不能升格由次数/跨天/证据决定，不是模型自觉。
- **写入是安全边界**：`RULES.md` 只读；升级只允许 `lib/**.js`、`templates/**.md`；`package.json`、patch、README 一律改不了。
- **攒着改**：每次改自我都会让 system prompt 的 KV cache 前缀失效（成本略涨），所以按天/按次收敛，而不是每轮追加。
- **自我升级必须重启才生效**，插件不会自己重启 DSH。

## 发版（维护者）

- 打 tag `vX.Y.Z` 并在 GitHub 发布 Release → `.github/workflows/publish.yml` 会先跑 `npm test`，再用 **Trusted Publishing（OIDC）** `npm publish --provenance`，不需要 `NPM_TOKEN`、不需要 OTP。
- 一次性前置：npm 包设置 → Trusted publishing → 绑定 GitHub Actions（user `CC19990113` / repo `dsh-plugin-soul` / workflow `publish.yml`）。

## 开发

```bash
npm test        # 64 项：存储 17 + 反思/升级 16 + 记忆 18 + 评分 13
```

```
lib/index.js      入口：注入段 + 11 工具 + HTTP API
lib/soul-store.js 存储：播种/预算/四道校验/git/CHANGELOG/回滚
lib/journal.js    日志与候选池：归一化、跨天计数、证据、闸门
lib/memory.js     记忆：日笔记、检索打分、命中计数、升格闸门
lib/ratings.js    人类评分：权重、写入闸门、升格门槛
lib/dream.js      反思：light 重算 → deep 合并升格 → DREAMS.md
lib/upgrade.js    自我升级：提案、白名单、node --check、整体还原
lib/client.js     设置页「人格」tab
templates/*.md    首次播种的初版人格
test/*.mjs        smoke(17) + features(16) + memory(18) + ratings(13)
install.mjs       幂等安装（--dry / --apply）
```

## 已知边界

- **真实浏览器渲染**：客户端用 vm mock + 最小 React 桩验证过加载/注册/交互分支，但没在真实浏览器里逐像素看过。
- **通过仓库地址安装**：走的是 DSH 官方安装器路径，本机开发用的是 symlink 安装；GitHub 安装形态未在本仓库实测。
- **版本兼容**：对 DSH `0.2.1-rc.2` 标 `unknown`（本机验证过，但没做跨版本矩阵）。
- **Windows**：未测。
- **记忆范围**：只覆盖性格与对话（自我认识 / 对你的认识 / 对话里的事 / 教训 / 偏好），**不含项目**；项目记忆请用别的通道。
- `/diff` 是 `git diff HEAD~1 -- <file>`，不是"那次提交"的差异。

## License

MIT

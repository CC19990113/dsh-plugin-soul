/**
 * dsh-plugin-soul —— 让 DSH 有一个可写、可回滚、每轮在场的「自我」。
 *
 * 四层能力：
 *   1. 注入   每轮把 ~/.dsh/soul 下的 Markdown 重新读一遍进 system prompt
 *             （section.text 是函数，每次 assembly 求值 → 改文件即生效，不用重启）
 *   2. 自改   soul_update 受四道约束（RULES 只读 / 单次 ≤800 字符 / 每日 ≤3 次 / why 必填）
 *   3. 反思   soul_journal 记观察 → soul_dream 把够格的候选升格进 SOUL，并写 DREAMS.md
 *   4. 升级   soul_propose_upgrade → soul_apply_upgrade（白名单 + node --check + 整体还原）
 *
 * 另外在设置页暴露一个「人格」tab（lib/client.js + /dsh-plugin-soul/api/*）。
 *
 * 为什么不用 @deepseek-ai/dsh-persona：它的 config 是静态字符串，改一次要动 patch + 重启；
 * 而 systemPrompt 的 section.text 支持函数（dsh-system-prompt/lib/index.js:187），每轮求值。
 *
 * @module dsh-plugin-soul
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_ROOT,
  FILES,
  MAX_DIFF_CHARS,
  MAX_WRITES_PER_DAY,
  describeStatus,
  ensureSeed,
  readAll,
  readFile,
  readNumbered,
  renderSoulBlock,
  rollback,
  status,
  updateFile,
} from './soul-store.js'
import {
  MIN_CANDIDATE_COUNT,
  MIN_CANDIDATE_DAYS,
  appendJournal,
  collectObservations,
  describeCandidates,
  isEligible,
  listCandidates,
  refreshCandidates,
} from './journal.js'
import { fileSummaries, lastDream, readDreams, runDream } from './dream.js'
import { applyUpgrade, listUpgrades, proposeUpgrade, rollbackUpgrade } from './upgrade.js'
import { appendRating, describeRatings, ratingWindow, writeGate } from './ratings.js'
import {
  MIN_PROMOTE_HITS,
  appendMemory,
  describeMemory,
  memoryStatus,
  promoteMemories,
  recall,
} from './memory.js'

export const name = 'soul'

/** 需要系统提示段位与工具注册表；webServer 走条件注入，缺了不影响其它能力 */
export const inject = ['systemPrompt', 'tools']

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ROUTE_PREFIX = '/dsh-plugin-soul/api'
/** 注入预算提示（与 soul-store 的 INJECT_BUDGET 对齐） */
const INJECT_BUDGET_HINT = 7000

function resolveRoot(config) {
  const fromConfig = config && typeof config.root === 'string' && config.root.trim() ? config.root.trim() : ''
  const fromEnv = process.env.DSH_SOUL_DIR ? String(process.env.DSH_SOUL_DIR).trim() : ''
  return fromConfig || fromEnv || DEFAULT_ROOT
}

/** 注入段的兜底：任何异常都不能让整轮失败 */
function safeSoulBlock(root) {
  try {
    const block = renderSoulBlock(root)
    if (!block) return ''
    return `${block}\n\n[自我状态] 改之前先 soul_read；why 必填；额度见 soul_status。`
  } catch (err) {
    return `[SELF 读取失败] ${err && err.message ? err.message : err}（用 soul_status 排查；本轮照常回答）`
  }
}

function textOf(value) {
  return [{ type: 'text', text: String(value && value.text != null ? value.text : '') }]
}

function out(text, extra = {}) {
  return { text, ...extra }
}

/** 最近提交（给 UI / soul_history） */
function recentCommits(root, limit = 5) {
  try {
    const raw = execFileSync('git', ['-C', root, 'log', `-${limit}`, '--format=%h\x1f%ad\x1f%s', '--date=format:%Y-%m-%d %H:%M'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return String(raw)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, date, subject] = line.split('\x1f')
        return { sha, date, subject }
      })
  } catch {
    return []
  }
}

/** 某个文件相对上一个提交的 diff */
function fileDiff(root, rel) {
  try {
    return (
      execFileSync('git', ['-C', root, 'diff', 'HEAD~1', '--', rel], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || ''
    )
  } catch {
    return ''
  }
}

// ---------------- HTTP API（设置页「人格」tab 用） ----------------

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

function statePayload(root) {
  ensureSeed(root)
  const candidates = listCandidates(root, { includeClosed: false })
  const block = renderSoulBlock(root)
  return {
    root,
    injectChars: block.length,
    injectTokens: Math.round(block.length / 4),
    injectBudget: INJECT_BUDGET_HINT,
    writesToday: status(root).writesToday,
    maxWritesPerDay: MAX_WRITES_PER_DAY,
    journalDays: new Set(collectObservations(root).map((o) => o.day)).size,
    files: fileSummaries(root),
    candidates: {
      total: candidates.length,
      eligible: candidates.filter(isEligible).length,
      rows: candidates.slice(0, 30).map((c) => ({
        text: c.text,
        count: c.count,
        days: c.days,
        status: c.status,
        evidence: c.evidence,
      })),
    },
    commits: recentCommits(root, 5),
    lastDream: lastDream(root),
    memory: memoryStatus(root),
    ratings: { ...ratingWindow({ root }), gate: writeGate({ root }) },
    upgrades: listUpgrades(root).slice(0, 10),
  }
}

function registerRoutes(ctx, root) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
            const method = (req.method ?? 'GET').toUpperCase()

            if (sub === '/state' && method === 'GET') return json(res, 200, statePayload(root))

            if (sub === '/file' && method === 'GET') {
              const file = url.searchParams.get('name') || ''
              if (!FILES[file]) return json(res, 400, { ok: false, message: `未知文件：${file}` })
              return json(res, 200, { ok: true, name: file, content: readFile(root, file), numbered: readNumbered(root, file) })
            }

            if (sub === '/file' && method === 'POST') {
              const body = await readBody(req)
              try {
                const r = updateFile({
                  name: String(body.name || ''),
                  content: body.content == null ? undefined : String(body.content),
                  append: body.append == null ? undefined : String(body.append),
                  why: String(body.why || ''),
                  root,
                })
                return json(res, 200, {
                  ok: true,
                  message: `已写入 ${r.name}（${r.chars}/${r.budget} 字符，Δ${r.delta}）`,
                  chars: r.chars,
                  budget: r.budget,
                  commit: r.commit,
                  writesToday: r.writesToday,
                })
              } catch (err) {
                return json(res, 400, { ok: false, message: `未写入：${err && err.message ? err.message : err}` })
              }
            }

            if (sub === '/dream' && method === 'POST') {
              const body = await readBody(req)
              const r = runDream({ root, apply: body.apply !== false })
              return json(res, 200, { ok: true, summary: r.summary, promoted: r.promoted, eligible: r.eligible })
            }

            if (sub === '/diff' && method === 'GET') {
              const file = url.searchParams.get('name') || ''
              if (!FILES[file]) return json(res, 400, { ok: false, message: `未知文件：${file}` })
              return json(res, 200, { ok: true, name: file, diff: fileDiff(root, file) })
            }

            if (sub === '/dreams' && method === 'GET') {
              return json(res, 200, { ok: true, content: readDreams(root) })
            }

            if (sub === '/rating' && method === 'POST') {
              const body = await readBody(req)
              try {
                const r = appendRating({
                  root,
                  sessionId: body.sessionId == null ? null : String(body.sessionId),
                  messageId: body.messageId == null ? null : String(body.messageId),
                  score: body.score,
                  note: body.note,
                })
                return json(res, 200, { ok: true, ...r, window: ratingWindow({ root }), gate: writeGate({ root }) })
              } catch (err) {
                return json(res, 400, { ok: false, message: String(err && err.message ? err.message : err) })
              }
            }

            if (sub === '/ratings' && method === 'GET') {
              return json(res, 200, { ok: true, ...ratingWindow({ root }), gate: writeGate({ root }) })
            }

            if (sub === '/memory' && method === 'GET') {
              return json(res, 200, { ok: true, ...memoryStatus(root) })
            }

            if (sub === '/memory/promote' && method === 'POST') {
              const body = await readBody(req)
              try {
                const r = promoteMemories({ root, keys: Array.isArray(body.keys) ? body.keys.map(String) : undefined })
                return json(res, 200, {
                  ok: true,
                  promoted: r.done.length,
                  eligible: r.eligible,
                  message:
                    r.done.length > 0
                      ? `已升格 ${r.done.length} 条进 MEMORY.md`
                      : '没有够格的：日笔记要被 soul_recall 召回 ≥3 次才算',
                  failed: r.failed.map((f) => f.error),
                })
              } catch (err) {
                return json(res, 400, { ok: false, message: String(err && err.message ? err.message : err) })
              }
            }

            return json(res, 404, { ok: false, message: `未知端点：${method} ${sub}` })
          } catch (err) {
            return json(res, 500, { ok: false, message: String(err && err.message ? err.message : err) })
          }
        },
      }),
    'soul: settings api',
  )
}

// ---------------- 插件入口 ----------------

export function apply(ctx, config) {
  const root = resolveRoot(config)

  try {
    ensureSeed(root)
  } catch (err) {
    console.error('[soul] 自我目录初始化失败：', err && err.message ? err.message : err)
  }

  // 1) 每轮注入（改文件即生效）
  ctx.systemPrompt.section({
    name: 'soul:self',
    order: 245,
    text: () => safeSoulBlock(root),
  })

  // 2) 设置页 API（webServer 不存在时自动跳过，不影响其它能力）
  try {
    ctx.inject(['webServer'], (child) => registerRoutes(child, root))
  } catch (err) {
    console.error('[soul] webServer 不可用，设置页 tab 将无法取数：', err && err.message ? err.message : err)
  }

  const tool = (spec) => {
    try {
      ctx.tools.register(
        defineTool({
          ...spec,
          output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => textOf(v) },
        }),
      )
    } catch (err) {
      console.error(`[soul] 工具注册失败 ${spec.name}:`, err && err.message ? err.message : err)
    }
  }

  // ---------- 看 ----------
  tool({
    name: 'soul_status',
    description:
      '查看「自我」当前状态：目录、每个文件的字符数与预算、今日自改额度、候选池数量、最近一次反思与提交。准备改自我之前先看它。',
    parameters: {},
    async execute() {
      const d = lastDream(root)
      const cand = listCandidates(root, { includeClosed: false })
      const tail = [
        '',
        `候选：${cand.length} 条（够格 ${cand.filter(isEligible).length} 条；闸门 ≥${MIN_CANDIDATE_COUNT} 次且跨 ≥${MIN_CANDIDATE_DAYS} 天）`,
        d ? `最近反思：${d.at}（升格 ${d.promoted} 条）` : '最近反思：还没跑过（soul_dream）',
      ].join('\n')
      return out(describeStatus(root) + tail)
    },
    presentCall: () => ({ card: 'generic', title: 'soul_status · 看自我', kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_read',
    description:
      '读「自我」文件原文（带行号）。可用：IDENTITY.md、SOUL.md、USER.md、RULES.md（只读），以及 CHANGELOG.md、DREAMS.md。省略 file 返回清单。',
    parameters: { file: { type: 'string', description: '文件名，如 SOUL.md' } },
    async execute(args) {
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      try {
        if (!file) {
          const rows = readAll(root)
            .map((f) => `- ${f.name}（${f.chars}/${f.budget} 字符，${f.writable ? '可写' : '只读'}）：${f.label}`)
            .join('\n')
          return out(
            `自我目录：${root}\n${rows}\n\n其它：CHANGELOG.md（自我改动史）、DREAMS.md（反思记录）、journal/<日期>.md（日间观察）`,
          )
        }
        if (file === 'DREAMS.md') return out(`# DREAMS.md\n${readDreams(root)}`)
        if (file === 'CHANGELOG.md') {
          const p = path.join(root, 'CHANGELOG.md')
          return out(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '（还没有 CHANGELOG，说明还没改过自我）')
        }
        return out(`# ${file}（${root}）\n${readNumbered(root, file)}`)
      } catch (err) {
        return out(`读取失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `soul_read · ${String((args && args.file) || '清单')}`, kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_history',
    description: '看自我文件的演化历史：最近提交、某个文件的 diff、以及待处理的升级提案。',
    parameters: {
      file: { type: 'string', description: '可选：看某个文件相对上一提交的 diff' },
      limit: { type: 'number', description: '提交条数，默认 8' },
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 8))
      const lines = [`自我目录：${root}`, '', '最近提交：']
      const commits = recentCommits(root, limit)
      if (commits.length === 0) lines.push('- （无 git 历史或尚未提交）')
      for (const c of commits) lines.push(`- ${c.sha} · ${c.date} · ${c.subject}`)
      const ups = listUpgrades(root).slice(0, 10)
      lines.push('', `升级提案 ${ups.length} 份：`)
      if (ups.length === 0) lines.push('- （无）')
      for (const u of ups) lines.push(`- ${u.id} · ${u.state}`)
      const file = typeof args.file === 'string' ? args.file.trim() : ''
      if (file) {
        if (!FILES[file]) return out(`未知文件：${file}`)
        const diff = fileDiff(root, file)
        lines.push('', `### ${file} 的 diff`, diff || '（与上一提交无差异，或没有历史）')
      }
      return out(lines.join('\n'))
    },
    presentCall: () => ({ card: 'generic', title: 'soul_history', kind: 'other', rawInput: {} }),
  })

  // ---------- 写 ----------
  tool({
    name: 'soul_update',
    description: `改「自我」可写文件（IDENTITY.md / SOUL.md / USER.md）。四道约束：RULES.md 只读；单次变更 ≤ ${MAX_DIFF_CHARS} 字符；每天最多 ${MAX_WRITES_PER_DAY} 次；why 必填（基于外部事实）。成功落 git + CHANGELOG，可回滚。攒着改——每次改都会打破 system prompt 缓存前缀。`,
    parameters: {
      file: { type: 'string', description: 'IDENTITY.md / SOUL.md / USER.md 之一' },
      content: { type: 'string', description: '全量替换内容（与 append 二选一）' },
      append: { type: 'string', description: '追加到末尾的片段（与 content 二选一）' },
      why: { type: 'string', description: '为什么改：基于哪条外部事实 / 主人哪句话（≥4 字符）' },
    },
    async execute(args) {
      try {
        const r = updateFile({
          name: String(args.file || '').trim(),
          content: args.content == null ? undefined : String(args.content),
          append: args.append == null ? undefined : String(args.append),
          why: String(args.why || ''),
          root,
        })
        return out(
          [
            `已写入 ${r.name}（${r.chars}/${r.budget} 字符，本次 Δ${r.delta}）`,
            `git 提交：${r.commit}｜今日自改 ${r.writesToday}/${MAX_WRITES_PER_DAY}`,
            '自我变了 → 下一轮 system prompt 缓存前缀失效，略贵一点，属预期。',
          ].join('\n'),
        )
      } catch (err) {
        return out(`未写入：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `soul_update · ${String((args && args.file) || '')}`, kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_rollback',
    description: '把某个可写自我文件回滚到历史提交（默认 HEAD~1），并记 CHANGELOG。改坏了自己时用。',
    parameters: {
      file: { type: 'string', description: 'IDENTITY.md / SOUL.md / USER.md 之一' },
      sha: { type: 'string', description: '目标提交，默认 HEAD~1' },
    },
    async execute(args) {
      try {
        const r = rollback({ name: String(args.file || '').trim(), sha: String(args.sha || 'HEAD~1'), root })
        return out(`已回滚 ${r.name} → ${r.sha}（${r.chars} 字符）`)
      } catch (err) {
        return out(`回滚失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `soul_rollback · ${String((args && args.file) || '')}`, kind: 'other', rawInput: {} }),
  })

  // ---------- 反思 ----------
  tool({
    name: 'soul_journal',
    description:
      '往今天的 journal 记一条观察（便宜、不限次）：发生了什么、主人说了什么、哪次判断错了。dream 从这里聚合候选。**同一个反复出现的事，要用同一个 key**（如 identity:name、memory:boundary），否则换个措辞就是新候选、永远凑不够升格门槛。',
    parameters: {
      text: { type: 'string', description: '一条基于事实的观察（≤400 字符）' },
      tag: { type: 'string', description: '可选标签：preference / mistake / goal / observe …' },
      key: {
        type: 'string',
        description: '稳定主题 key（a-z 0-9 : . _ -，≤64）。同一个主题每次都用同一个，才能跨天聚合到 ≥3 次',
      },
    },
    async execute(args) {
      try {
        const r = appendJournal({
          text: String(args.text || ''),
          tag: String(args.tag || 'observe'),
          key: args.key == null ? undefined : String(args.key),
          root,
        })
        return out(`已记入 ${r.file}：${r.line}`)
      } catch (err) {
        return out(`记录失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'soul_journal', kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_candidates',
    description: `查看候选池：从 journal 聚合出的候选，按「是否够格升格」排序。闸门：≥${MIN_CANDIDATE_COUNT} 次且跨 ≥${MIN_CANDIDATE_DAYS} 天。`,
    parameters: { all: { type: 'boolean', description: 'true 时连已升格/已丢弃的一起显示' } },
    async execute() {
      refreshCandidates(root)
      return out(describeCandidates(root))
    },
    presentCall: () => ({ card: 'generic', title: 'soul_candidates', kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_dream',
    description:
      '跑一次反思：重算候选 → 够格的合并升格进 SOUL.md（受四道写入约束）→ 追加 DREAMS.md。默认只预览，apply=true 才真写。可传 narrative 写一段自己的反思。',
    parameters: {
      apply: { type: 'boolean', description: 'true 才真的改 SOUL；省略=预览' },
      narrative: { type: 'string', description: '可选：你自己写的一段第一人称反思（≤1200 字），会追加到 DREAMS.md 的「叙事」段' },
      promoteMemory: { type: 'boolean', description: '顺带把「被 recall ≥3 次」的日笔记升格进 MEMORY.md' },
    },
    async execute(args) {
      try {
        const apply = args.apply === true
        const r = runDream({
          root,
          apply,
          narrative: args.narrative == null ? undefined : String(args.narrative),
          promoteMemory: args.promoteMemory === true,
        })
        return out(`${apply ? '已应用' : '预览完成'}\n\n${r.summary}`)
      } catch (err) {
        return out(`反思失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'soul_dream · 反思', kind: 'other', rawInput: {} }),
  })

  // ---------- 记忆 ----------
  tool({
    name: 'soul_remember',
    description: `记一条**人格记忆**到今天的日笔记（memory/YYYY-MM-DD.md）——只管「关于我 / 关于你 / 关于我们」，**不记项目**（代码、技术决策、环境、踩坑归项目记忆，别放这里）。和 soul_journal 的区别：journal 是当天随手观察（喂 dream 沉淀人格），memory 是跨会话要能查回来的关系性事实。日笔记不注入上下文，靠 soul_recall 查；被召回 ≥${MIN_PROMOTE_HITS} 次才够格升格进 MEMORY.md。`,
    parameters: {
      text: { type: 'string', description: '一条事实（≤400 字符，写具体：路径/命令/结论/日期）' },
      kind: {
        type: 'string',
        description:
          'self（我对自己的认识）| user（对你的认识）| talk（对话里发生的事，默认）| lesson（我学到的教训）| pref（偏好变化）',
      },
    },
    async execute(args) {
      try {
        const r = appendMemory({ text: String(args.text || ''), kind: String(args.kind || 'talk'), root })
        return out(`已记入 ${r.file}：${r.line}`)
      } catch (err) {
        return out(`记录失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'soul_remember', kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_recall',
    description:
      '按关键词检索**人格记忆**：长期 MEMORY.md + 日笔记（不含项目记忆）。命中的日笔记会计一次 hit——这是它将来能否升格的唯一依据。查「他说过喜欢什么」「我答应过什么」「上次被纠正的是哪件」这类关系性问题。',
    parameters: {
      query: { type: 'string', description: '关键词（中文会按双字切分，英文按词）' },
      limit: { type: 'number', description: '返回条数，默认 8' },
    },
    async execute(args) {
      const query = String(args.query || '').trim()
      if (!query) return out('要给 query')
      try {
        const r = recall({ query, root, limit: Math.max(1, Math.min(30, Number(args.limit) || 8)) })
        if (r.rows.length === 0) return out(`没有命中「${query}」。切词：${r.tokens.join(' ')}`)
        const lines = [`查询「${query}」→ ${r.rows.length} 条（切词：${r.tokens.join(' ')}）`, '']
        for (const row of r.rows) {
          lines.push(`- [${row.tier}${row.kind ? '·' + row.kind : ''}] ${row.text}`)
          lines.push(`  来源 ${row.source}｜分 ${row.score}｜已命中 ${row.hits} 次`)
        }
        return out(lines.join('\n'))
      } catch (err) {
        return out(`检索失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `soul_recall · ${String((args && args.query) || '')}`.slice(0, 60), kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_ratings',
    description:
      '看人类对最近回复的评分（👍/😑/👎）与它算出的权重：权重决定「能不能改人格文件、能动多大」，也决定日笔记升格进 MEMORY.md 的门槛（好评降到 2 次，差评暂停升格）。',
    parameters: {},
    async execute() {
      try {
        return out(describeRatings(root))
      } catch (err) {
        return out(`读评分失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'soul_ratings · 评分', kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_memory',
    description: `人格记忆状态与升格。action=status 看统计与待升格清单；action=promote 把够格（被 soul_recall 召回 ≥${MIN_PROMOTE_HITS} 次）的日笔记写进 MEMORY.md（受 3000 字符预算）。只处理「关于我 / 关于你 / 关于我们」，不处理项目技术记忆。`,
    parameters: {
      action: { type: 'string', description: 'status | promote' },
      keys: { type: 'array', items: { type: 'string' }, description: '只升格这些来源键（如 memory/2026-10-26.md#L3）；省略=全部够格的' },
      limit: { type: 'number', description: '最多升格几条，默认 5' },
    },
    async execute(args) {
      const action = String(args.action || 'status').trim()
      try {
        if (action === 'promote') {
          const r = promoteMemories({
            root,
            keys: Array.isArray(args.keys) ? args.keys.map(String) : undefined,
            limit: Math.max(1, Math.min(20, Number(args.limit) || 5)),
          })
          const lines = [
            r.done.length > 0 ? `已升格 ${r.done.length} 条 → MEMORY.md` : '没有升格（没有够格的，或预算满了）',
          ]
          for (const d of r.done) lines.push(`- （命中 ${d.hits}）${d.text.slice(0, 80)}`)
          for (const f of r.failed) lines.push(`- 失败：${f.error}`)
          lines.push('', describeMemory(root))
          return out(lines.join('\n'))
        }
        return out(describeMemory(root))
      } catch (err) {
        return out(`记忆操作失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `soul_memory · ${String((args && args.action) || 'status')}`, kind: 'other', rawInput: {} }),
  })

  // ---------- 自我升级 ----------
  tool({
    name: 'soul_propose_upgrade',
    description:
      '为「改自己的代码」落一份提案（不直接写）：只允许 lib/**.js 与 templates/**.md，最多 6 个文件；含改前快照，可回滚。人确认后用 soul_apply_upgrade。',
    parameters: {
      title: { type: 'string', description: '一句话标题' },
      why: { type: 'string', description: '为什么改（基于什么需求/事实，≥4 字符）' },
      files: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: '要改的文件：[{ path: "lib/journal.js", content: "新全文" }]',
      },
    },
    async execute(args) {
      try {
        const files = Array.isArray(args.files)
          ? args.files.map((f) => ({
              path: String(f && f.path ? f.path : ''),
              content: String(f && f.content != null ? f.content : ''),
            }))
          : []
        const r = proposeUpgrade({
          pluginRoot: PLUGIN_ROOT,
          title: String(args.title || '升级'),
          why: String(args.why || ''),
          files,
          root,
        })
        return out(
          [
            `提案已落：${r.id}`,
            `目录：${r.dir}`,
            '',
            '改动：',
            ...r.rows,
            '',
            '下一步：人看过之后调 soul_apply_upgrade({ id, confirm: "APPLY" })',
          ].join('\n'),
        )
      } catch (err) {
        return out(`提案失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'soul_propose_upgrade', kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_apply_upgrade',
    description:
      '应用一份升级提案：必须 confirm="APPLY"；逐个文件 node --check，任何一个语法不过就整体还原；成功落 git，但需要重启 DSH 才生效（不会自己重启）。',
    parameters: {
      id: { type: 'string', description: '提案 id（soul_propose_upgrade 返回）' },
      confirm: { type: 'string', description: '必须传字符串 APPLY' },
    },
    async execute(args) {
      try {
        const r = applyUpgrade({ pluginRoot: PLUGIN_ROOT, id: String(args.id || ''), confirm: String(args.confirm || ''), root })
        return out(
          [`已应用 ${r.id}`, ...r.files.map((f) => `- ${f}`), `git：${r.commit}`, '⚠️ 需要重启 DSH 才生效。'].join('\n'),
        )
      } catch (err) {
        return out(`应用失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'soul_apply_upgrade', kind: 'other', rawInput: {} }),
  })

  tool({
    name: 'soul_upgrade_rollback',
    description: '把某个升级提案还原到改前快照（从提案目录 before/ 还原），并做语法检查。需要重启 DSH 生效。',
    parameters: { id: { type: 'string', description: '提案 id' } },
    async execute(args) {
      try {
        const r = rollbackUpgrade({ pluginRoot: PLUGIN_ROOT, id: String(args.id || ''), root })
        return out([`已还原 ${r.id}`, ...r.restored.map((f) => `- ${f}`), '⚠️ 需要重启 DSH 才生效。'].join('\n'))
      } catch (err) {
        return out(`还原失败：${err && err.message ? err.message : err}`)
      }
    },
    presentCall: () => ({ card: 'generic', title: 'soul_upgrade_rollback', kind: 'other', rawInput: {} }),
  })
}

export { FILES, DEFAULT_ROOT }

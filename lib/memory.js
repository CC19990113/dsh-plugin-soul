/**
 * dsh-plugin-soul · 记忆层
 *
 * 只管「性格 + 对话」这一层记忆，**不管项目**：
 *   记：我对自己的认识、对你的认识、对话里发生过的事、我学到的教训、偏好怎么变的
 *   不记：项目代码/技术决策/环境配置/踩坑 —— 那些属于项目记忆（别的地方管），
 *         混进来会把人格记忆变成技术台账，而且每轮注入的预算会被技术细节吃掉。
 *
 * 和 journal 的区别：journal 是当天随手观察（喂 dream 沉淀人格），
 * memory 是跨会话要能查回来的关系性事实。
 *
 * 两级：
 *   MEMORY.md            长期事实（curated，每轮注入，有预算）
 *   memory/YYYY-MM-DD.md 日笔记（episodic，不注入，靠 soul_recall 检索）
 *
 * 升格规则（照 OpenClaw 的核心洞察）：**因为被反复用到，才毕业**。
 * 每次 soul_recall 命中一条日笔记就给它记一次 hit；hits ≥ 3 才允许升格进 MEMORY.md。
 * 不靠模型自觉说"这条很重要"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { promoteGate } from './ratings.js'

export const MEMORY_FILE = 'MEMORY.md'
export const MEMORY_DIR = 'memory'
/** MEMORY.md 预算（字符） */
export const MEMORY_BUDGET = 3000
/** 一条记忆最多多少字符 */
const MAX_ENTRY_CHARS = 400
/** 升格闸门：至少被召回几次 */
export const MIN_PROMOTE_HITS = 3
/** recency 半衰期（天） */
const HALF_LIFE_DAYS = 30
/** 命中计数文件 */
const HITS = '.memory-hits.json'

function pad(n) {
  return String(n).padStart(2, '0')
}

export function dayStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function clock(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

/** 合法 kind：全部是「关于我 / 关于你 / 关于我们」的维度，不含技术类 */
const KINDS = new Set(['self', 'user', 'talk', 'lesson', 'pref'])
const DEFAULT_KIND = 'talk'

/** 写一条日记忆 */
export function appendMemory({ text, kind = DEFAULT_KIND, root, now = new Date() }) {
  const clean = String(text == null ? '' : text).trim()
  if (clean.length < 2) throw new Error('记忆内容太短（≥2 字符）')
  if (clean.length > MAX_ENTRY_CHARS) throw new Error(`记忆太长（≤${MAX_ENTRY_CHARS} 字符），拆成几条`)
  const k = KINDS.has(String(kind)) ? String(kind) : DEFAULT_KIND
  const day = dayStamp(now)
  const file = path.join(root, MEMORY_DIR, `${day}.md`)
  const line = `- ${clock(now)} [${k}] ${clean}`
  const head = readIfExists(file)
  write(file, head == null ? `# ${day}\n\n${line}\n` : head.endsWith('\n') ? `${head}${line}\n` : `${head}\n${line}\n`)
  return { file: path.relative(root, file), line, day }
}

/** 读全部日记忆（带来源行号） */
export function collectMemories(root) {
  const dir = path.join(root, MEMORY_DIR)
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort()
  } catch {
    return []
  }
  const rows = []
  for (const name of names) {
    const day = name.slice(0, 10)
    const rel = `${MEMORY_DIR}/${name}`
    const lines = (readIfExists(path.join(dir, name)) ?? '').split('\n')
    lines.forEach((raw, idx) => {
      const m = raw.match(/^\s*-\s*(\d{2}:\d{2})\s*\[([a-z]+)\]\s*(.+)$/)
      if (!m) return
      rows.push({ day, time: m[1], kind: m[2], text: m[3].trim(), file: rel, line: idx + 1 })
    })
  }
  return rows
}

/** 读 curated 记忆 */
export function readCurated(root) {
  return readIfExists(path.join(root, MEMORY_FILE)) ?? ''
}

/** 日记忆的天数 */
export function memoryDays(root) {
  return new Set(collectMemories(root).map((r) => r.day)).size
}

// ---------------- 检索 ----------------

/**
 * 切词：中文按双字滑窗（不依赖分词库），英文/数字按词。
 * 查询为空返回 []，调用方据此跳过检索。
 */
export function tokenize(query) {
  const q = String(query || '').toLowerCase()
  const out = new Set()
  for (const m of q.matchAll(/[a-z0-9][a-z0-9._-]+/g)) out.add(m[0])
  const cjk = q.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue
    if (seg.length === 1) out.add(seg)
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2))
  }
  return [...out]
}

function hitsOf(root) {
  const raw = readIfExists(path.join(root, HITS))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed.entries : {}
  } catch {
    return {}
  }
}

function saveHits(root, entries) {
  write(path.join(root, HITS), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2) + '\n')
}

function entryKey(row) {
  return `${row.file}#L${row.line}`
}

function ageDays(day, now) {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (Number.isNaN(t)) return 999
  return Math.max(0, (now.getTime() - t) / 86400000)
}

/**
 * 检索：MEMORY.md 的小节条目 + 日记忆逐行，按
 *   覆盖 0.6 + 命中数 0.2 + recency 0.2（再乘 hitBoost）
 * 打分排序。命中的日记忆顺手 +1 hit（这才是升格的依据）。
 *
 * @returns {{query:string, tokens:string[], rows:Array}}
 */
export function recall({ query, root, limit = 8, now = new Date(), countHits = true }) {
  const tokens = tokenize(query)
  if (tokens.length === 0) return { query, tokens, rows: [] }
  const entries = hitsOf(root)
  const scored = []

  // 1) 日记忆
  for (const row of collectMemories(root)) {
    const text = row.text.toLowerCase()
    let covered = 0
    for (const t of tokens) if (text.includes(t)) covered += 1
    if (covered === 0) continue
    const key = entryKey(row)
    const h = entries[key]?.hits ?? 0
    const cover = Math.min(1, covered / tokens.length)
    const density = Math.min(1, covered / Math.max(3, row.text.length / 40))
    const rec = Math.pow(0.5, ageDays(row.day, now) / HALF_LIFE_DAYS)
    const hitBoost = 1 + Math.min(1, Math.log1p(h) / Math.log1p(10)) * 0.5
    scored.push({
      text: row.text,
      source: key,
      kind: row.kind,
      day: row.day,
      // 覆盖 0.6 + 命中密度 0.2 + 新近 0.2，再乘 hitBoost（1~1.5）；各项已 clamp，分数落在 0~1.5
      score: Number(((cover * 0.6 + density * 0.2 + rec * 0.2) * hitBoost).toFixed(4)),
      hits: h,
      tier: 'episodic',
    })
  }

  // 2) curated MEMORY.md 的小节条目（每行一条）
  const curated = readCurated(root).split('\n')
  curated.forEach((raw, idx) => {
    const m = raw.match(/^\s*-\s+(.+)$/)
    if (!m) return
    const text = m[1].trim()
    const lower = text.toLowerCase()
    let covered = 0
    for (const t of tokens) if (lower.includes(t)) covered += 1
    if (covered === 0) return
    const key = `${MEMORY_FILE}#L${idx + 1}`
    const h = entries[key]?.hits ?? 0
    const cover = covered / tokens.length
    scored.push({
      text,
      source: key,
      kind: 'curated',
      day: null,
      score: Number((cover * 0.6 + 0.2 + Math.pow(0.5, 0.1) * 0.2).toFixed(4)),
      hits: h,
      tier: 'curated',
    })
  })

  scored.sort((a, b) => b.score - a.score)
  const rows = scored.slice(0, limit)

  if (countHits && rows.length > 0) {
    const next = { ...entries }
    for (const r of rows) {
      const prev = next[r.source] ?? { hits: 0, firstHitAt: now.toISOString() }
      next[r.source] = { hits: prev.hits + 1, firstHitAt: prev.firstHitAt, lastHitAt: now.toISOString() }
    }
    saveHits(root, next)
  }
  return { query, tokens: tokens.slice(0, 12), rows }
}

/** 够格升格的日记忆（被召回 ≥ MIN_PROMOTE_HITS 次、且还没进 curated） */
export function promotableMemories(root, { minHits = MIN_PROMOTE_HITS } = {}) {
  const entries = hitsOf(root)
  const curated = readCurated(root)
  return collectMemories(root)
    .map((row) => {
      const key = entryKey(row)
      const hits = entries[key]?.hits ?? 0
      return { ...row, key, hits }
    })
    .filter((r) => r.hits >= minHits && !curated.includes(r.text.slice(0, 40)))
    .sort((a, b) => b.hits - a.hits)
}

/**
 * 把 MEMORY.md 的这次升格提交进 git。
 *
 * 为什么单独一个函数：addCurated 是纯文件写，没有版本痕迹；
 * 而「可回滚」的承诺要求每次长期记忆变更都能 git log 查到、能 soul_rollback 回去。
 * 只 add MEMORY.md，不 add -A —— 别把 .candidates.json / .ratings.json 这些派生态搅进提交。
 */
function commitMemory(root, message) {
  try {
    execFileSync('git', ['-C', root, 'add', MEMORY_FILE], { stdio: 'ignore' })
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.name=dsh-soul', '-c', 'user.email=soul@localhost', 'commit', '-q', '-m', message],
      { stdio: 'ignore' },
    )
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'no-git'
  }
}

const SECTION_BY_KIND = {
  self: '## 关于我',
  user: '## 关于你',
  talk: '## 对话里的事',
  lesson: '## 我学到的',
  pref: '## 偏好变化',
}

/** 往 MEMORY.md 里加一行（按 kind 归小节，超预算就拒） */
export function addCurated({ text, kind = DEFAULT_KIND, source, hits, root, now = new Date() }) {
  const section = SECTION_BY_KIND[kind] ?? SECTION_BY_KIND.talk
  const current = readCurated(root)
  const day = dayStamp(now)
  const tail = [`${day}：${String(text).trim()}`, source ? `来源 ${source}` : '', hits ? `命中 ${hits} 次` : '']
    .filter(Boolean)
    .join('；')
  const line = `- ${tail}`
  let next
  if (current.includes(section)) {
    next = current.replace(section, `${section}\n\n${line}`).replace(/\n{3,}/g, '\n\n')
  } else {
    next = `${current.replace(/\s+$/, '')}\n\n${section}\n\n${line}\n`
  }
  if (!next.trim().startsWith('#')) next = `# MEMORY\n\n${next}`
  if (next.length > MEMORY_BUDGET) {
    throw new Error(`MEMORY.md 会超出预算：${next.length} > ${MEMORY_BUDGET} 字符。先合并/删旧条目再升格`)
  }
  write(path.join(root, MEMORY_FILE), next)
  return { section, line, chars: next.length, budget: MEMORY_BUDGET }
}

/**
 * 升格：把够格的日记忆写进 MEMORY.md。
 * @param {object} opts
 * @param {string[]} [opts.keys] 只升格这些来源键；省略=全部够格的（最多 limit 条）
 */
export function promoteMemories({ root, keys, limit = 5, now = new Date() }) {
  // 人类评分决定升格门槛：好评降到 2 次，差评暂停升格
  const gate = promoteGate({ root, now })
  if (!gate.allow) return { done: [], failed: [{ error: gate.reason }], eligible: 0, gate }
  const eligible = promotableMemories(root, { minHits: gate.minHits })
  const picked = (Array.isArray(keys) && keys.length > 0 ? eligible.filter((r) => keys.includes(r.key)) : eligible).slice(0, limit)
  const done = []
  const failed = []
  for (const row of picked) {
    try {
      addCurated({ text: row.text, kind: row.kind, source: row.key, hits: row.hits, root, now })
      done.push(row)
    } catch (err) {
      failed.push({ row, error: err && err.message ? err.message : String(err) })
      break // 预算/长度问题：后面的不用试了
    }
  }
  // 有变更就提交：MEMORY.md 也要有版本历史，才能回滚
  const commit = done.length > 0 ? commitMemory(root, `soul: promote ${done.length} 条日记忆 → MEMORY.md`) : null
  return { done, failed, eligible: eligible.length, gate, commit }
}

/** 记忆层状态（给 UI / 工具） */
export function memoryStatus(root, now = new Date()) {
  const rows = collectMemories(root)
  const curated = readCurated(root)
  const pg = promoteGate({ root, now })
  const promotable = promotableMemories(root, { minHits: pg.minHits })
  const days = new Set(rows.map((r) => r.day))
  const recent = rows.slice(-5).reverse()
  return {
    curatedChars: curated.length,
    curatedBudget: MEMORY_BUDGET,
    entries: rows.length,
    days: days.size,
    promotable: promotable.length,
    minPromoteHits: pg.minHits,
    ratingWeight: pg.weight,
    ratingSamples: pg.samples,
    promoteAllowed: pg.allow,
    promoteReason: pg.reason,
    recent,
    promotableRows: promotable.slice(0, 8).map((r) => ({ text: r.text, hits: r.hits, key: r.key })),
  }
}

/** 人看的状态文本 */
export function describeMemory(root) {
  const s = memoryStatus(root)
  const lines = [
    `长期记忆：MEMORY.md ${s.curatedChars}/${s.curatedBudget} 字符｜日记忆 ${s.entries} 条 / ${s.days} 天`,
    `待升格：${s.promotable} 条（闸门：被 soul_recall 召回 ≥${s.minPromoteHits} 次）`,
    `评分：${s.ratingSamples} 条样本｜权重 ${s.ratingWeight === null ? '—' : s.ratingWeight}｜${s.promoteAllowed ? '可升格' : '暂停升格'}`,
  ]
  if (s.promotableRows.length > 0) {
    lines.push('', '够格未升格：')
    for (const r of s.promotableRows) lines.push(`- （命中 ${r.hits}）${r.text.slice(0, 70)} · ${r.key}`)
    lines.push('', '升格：soul_memory({action:"promote"})')
  }
  if (s.recent.length > 0) {
    lines.push('', '最近记的：')
    for (const r of s.recent) lines.push(`- ${r.day} [${r.kind}] ${r.text.slice(0, 70)}`)
  }
  return lines.join('\n')
}

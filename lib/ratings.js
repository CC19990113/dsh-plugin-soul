/**
 * dsh-plugin-soul · 人类评分层
 *
 * 一条回复下面的 👍/😑/👎 不是闸门，是**权重**：
 * 它不阻塞任何写入，只做两件事 —— 好评把升格门槛降低（3 次 → 2 次）、
 * 把写入时的 rating 记进 CHANGELOG 供事后回查。差评不等于禁止。
 *
 * 算法（全部确定性、可解释）：
 *   weight = Σ(score × decay) / Σ(decay)   → 映射到 [0,1]
 *   score  ∈ {-1, 0, +1}（差/中/好）
 *   decay  = 0.5 ^ (ageDays / 7)           → 一周半衰
 *   只取最近 MAX_SAMPLES 条；样本 < MIN_SAMPLES 时不给闸门（不拦）
 *
 * 接入点：
 *   · soul-store.updateFile  → 写 SOPUL/USER/IDENTITY/MEMORY 前过 writeGate()
 *   · memory.promoteMemories → 日笔记升格进 MEMORY.md 时按评分调门槛
 *   · 每次写入把当时的 weight 记进 CHANGELOG，事后可回查
 */

import fs from 'node:fs'
import path from 'node:path'

export const RATINGS_FILE = '.ratings.json'
/** 参与计算的最近评分数 */
export const MAX_SAMPLES = 20
/** 少于此数不给闸门（冷启动不拦） */
export const MIN_SAMPLES = 3
/** 衰减半衰期（天） */
const HALF_LIFE_DAYS = 7
/** 三档分数 */
export const SCORES = { bad: -1, ok: 0, good: 1 }

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

function clampScore(score) {
  const n = Number(score)
  if (n === 1 || n === -1) return n
  return 0
}

/** 评分备注的最大长度（字符），防止长文本灌满 .ratings.json */
const MAX_NOTE = 2000

function clampNote(note) {
  if (note === null || note === undefined) return null
  const text = String(note).trim()
  return text ? text.slice(0, MAX_NOTE) : null
}

/** 记一条评分（同一条消息重复打分 → 覆盖）；note 传 undefined 保留旧备注，传空串清空 */
export function appendRating({ root, sessionId, messageId, score, note, now = new Date() }) {
  const file = path.join(root, RATINGS_FILE)
  let store = { version: 1, ratings: [] }
  const raw = readIfExists(file)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.ratings)) store = parsed
    } catch {
      /* 坏文件重建 */
    }
  }
  const key = `${sessionId ?? ''}|${messageId ?? ''}`
  const value = clampScore(score)
  const noteValue = clampNote(note)
  const prev = store.ratings.find((r) => r.key === key)
  if (prev) {
    prev.score = value
    prev.at = now.toISOString()
    prev.updatedAt = now.toISOString()
    // 备注：传了就用新值（空串=清空），没传就保留旧备注
    if (note !== undefined) prev.note = noteValue
  } else {
    store.ratings.push({
      key,
      sessionId: sessionId ?? null,
      messageId: messageId ?? null,
      score: value,
      note: noteValue,
      at: now.toISOString(),
    })
  }
  // 只保留最近 500 条，防无限增长
  store.ratings = store.ratings.slice(-500)
  write(file, JSON.stringify({ ...store, version: 1, updatedAt: now.toISOString() }, null, 2) + '\n')
  return { key, score: value, count: store.ratings.length }
}

/** 读评分（按时间倒序） */
export function listRatings(root) {
  const raw = readIfExists(path.join(root, RATINGS_FILE))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    const rows = Array.isArray(parsed.ratings) ? parsed.ratings : []
    return [...rows].sort((a, b) => String(b.at).localeCompare(String(a.at)))
  } catch {
    return []
  }
}

/**
 * 加权评分。
 * @returns {{samples:number, avg:number|null, weight:number|null, recent:Array}}
 *   weight: 0~1（0=全是差评，1=全好评）；样本不足时为 null（表示「不设闸门」）
 */
export function ratingWindow({ root, now = new Date(), limit = MAX_SAMPLES } = {}) {
  const rows = listRatings(root).slice(0, limit)
  if (rows.length === 0) return { samples: 0, avg: null, weight: null, recent: [] }
  let num = 0
  let den = 0
  for (const r of rows) {
    const t = Date.parse(r.at)
    const ageDays = Number.isNaN(t) ? 0 : Math.max(0, (now.getTime() - t) / 86400000)
    const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
    num += clampScore(r.score) * decay
    den += decay
  }
  const avg = den === 0 ? 0 : num / den // 落在 [-1, 1]
  const weight = (avg + 1) / 2 // 映射到 [0, 1]
  return {
    samples: rows.length,
    avg: Number(avg.toFixed(4)),
    weight: Number(weight.toFixed(4)),
    recent: rows.slice(0, 10).map((r) => ({
      messageId: r.messageId,
      score: r.score,
      note: typeof r.note === "string" ? r.note : null,
      at: r.at,
    })),
  }
}

/**
 * 写入评估：**不做闸门**。
 *
 * 早期版本按权重拒绝写入（<0.35 禁写、0.35~0.6 只许 300 字符），实测这个方向是错的：
 * 打分是「锦上添花」的加权信号，不该变成「不许改人格」的否决权。
 * 现在恒 allow、恒 800 字符上限（这是防误操作的硬上限，与评分无关），
 * 只把权重返回给调用方记录与展示。
 *
 * @returns {{allow:true, maxDelta:number, weight:number|null, samples:number, avg:number|null, reason:string}}
 */
export function writeGate({ root, now = new Date() } = {}) {
  const w = ratingWindow({ root, now })
  const shown = w.weight === null ? '—' : w.weight
  const thin = w.samples < MIN_SAMPLES
  return {
    allow: true,
    maxDelta: 800,
    weight: w.weight,
    samples: w.samples,
    avg: w.avg,
    reason: thin
      ? `样本不足（${w.samples} < ${MIN_SAMPLES}），评分暂不参与加权；写入不受限`
      : `评分权重 ${shown}（仅作加权，不阻塞写入）`,
  }
}

/** 升格评估：好评把门槛从 3 次降到 2 次；差评不加速、也不禁止（维持 3 次） */
export function promoteGate({ root, now = new Date() } = {}) {
  const w = ratingWindow({ root, now })
  const enough = w.weight !== null && w.samples >= MIN_SAMPLES
  const minHits = enough && w.weight >= 0.75 ? 2 : 3
  return {
    allow: true,
    minHits,
    weight: w.weight,
    samples: w.samples,
    reason:
      minHits === 2
        ? `评分权重 ${w.weight} ≥0.75，升格门槛降到 2 次（加速）`
        : enough
          ? `评分权重 ${w.weight}，默认门槛 3 次`
          : `样本不足（${w.samples} < ${MIN_SAMPLES}），默认门槛 3 次`,
  }
}

/** 人读状态 */
export function describeRatings(root) {
  const w = ratingWindow({ root })
  const gate = writeGate({ root })
  const pg = promoteGate({ root })
  const lines = [
    `评分：${w.samples} 条样本｜权重 ${w.weight === null ? '—' : w.weight}（0=全差评，1=全好评）｜均值 ${w.avg === null ? '—' : w.avg}`,
    `写入：不受评分限制（单次硬上限 ≤${gate.maxDelta} 字符）— ${gate.reason}`,
    `升格门槛：≥${pg.minHits} 次召回 — ${pg.reason}`,
  ]
  if (w.recent.length > 0) {
    lines.push('', '最近评分：')
    for (const r of w.recent.slice(0, 8)) lines.push(`- ${r.at} ${r.score > 0 ? '👍' : r.score < 0 ? '👎' : '😑'} ${String(r.messageId ?? '').slice(0, 18)}`)
  }
  return lines.join('\n')
}

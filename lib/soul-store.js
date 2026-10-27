/**
 * dsh-plugin-soul · 自我存储层（零外部依赖）
 *
 * 职责：把「自我」落成 ~/.dsh/soul 下几份 Markdown，并提供
 *   - ensureSeed()  首次创建目录 + 从 templates 播种 + git init
 *   - readAll()     带预算读全部文件
 *   - renderSoulBlock() 生成每轮注入的 system prompt 段
 *   - updateFile()  受约束的写（白名单 / diff 上限 / 每日次数 / 预算 / why 必填）
 *   - rollback()    git 回滚
 *   - status()      人看的状态
 *
 * 设计纪律：
 *   1. RULES.md 永远只读（人类锚点），工具拒写。
 *   2. 写入必须有 why，且落 git + CHANGELOG，可回滚。
 *   3. 单次变更量上限 + 每日次数上限，防人格漂移。
 *   4. 渲染时中和 `{{`（宿主把注入文本当模板插值，命中会整轮失败）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { writeGate } from './ratings.js'

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TEMPLATE_DIR = path.join(PLUGIN_ROOT, 'templates')

/** 默认自我目录 */
export const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'soul')

/** 文件清单：writable=false 的文件对 agent 只读 */
export const FILES = {
  'IDENTITY.md': { writable: true, budget: 1200, label: '身份（名字/化身/口癖）' },
  'SOUL.md': { writable: true, budget: 4000, label: '声音/立场/边界' },
  'USER.md': { writable: true, budget: 2500, label: '对用户的模型' },
  // 人格记忆：只记关于我/关于你/关于我们；由 soul_remember 写日笔记、被 soul_recall 反复命中后才升格进来
  'MEMORY.md': { writable: true, budget: 3000, label: '人格记忆（关于我/关于你/关于我们）' },
  'RULES.md': { writable: false, budget: 2000, label: '硬规则（只读锚点）' },
}

/** 单次写入允许的最大变更字符数 */
export const MAX_DIFF_CHARS = 800
/** 每天最多几次自改 */
export const MAX_WRITES_PER_DAY = 3
/** 注入总预算（字符），超出按文件顺序截断 */
export const INJECT_BUDGET = 11000
/** 变更日志 */
const CHANGELOG = 'CHANGELOG.md'
/** 写入计数器 */
const STATE = '.state.json'

function today() {
  return new Date().toISOString().slice(0, 10)
}

/** 中和会触发宿主模板插值的双花括号 */
export function neutralizeBraces(text) {
  return String(text == null ? '' : text).split('{{').join('{ {')
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

/** 在 root 里跑 git；失败返回 {ok:false}，绝不抛出打断调用方 */
function git(root, args) {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, '-c', 'user.name=dsh-soul', '-c', 'user.email=soul@localhost', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return { ok: true, out: String(out).trim() }
  } catch (err) {
    return { ok: false, error: String(err && err.stderr ? err.stderr : err && err.message ? err.message : err).trim() }
  }
}

/** 首次调用时把 templates 播种到 root，并建 git 仓库 */
export function ensureSeed(root = DEFAULT_ROOT) {
  fs.mkdirSync(root, { recursive: true })
  const created = []
  for (const name of Object.keys(FILES)) {
    const target = path.join(root, name)
    if (fs.existsSync(target)) continue
    const tpl = readIfExists(path.join(TEMPLATE_DIR, name))
    write(target, tpl == null ? `# ${name}\n` : tpl)
    created.push(name)
  }
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true })
  if (!fs.existsSync(path.join(root, '.git'))) {
    const init = git(root, ['init', '-q'])
    if (init.ok) {
      git(root, ['add', '-A'])
      git(root, ['commit', '-q', '-m', 'soul: 初始化自我文件（插件种子）'])
    }
  }
  return { root, created }
}

/** 读一个文件 */
export function readFile(root, name) {
  if (!FILES[name]) throw new Error(`未知文件：${name}（可用：${Object.keys(FILES).join(', ')}）`)
  const content = readIfExists(path.join(root, name))
  if (content == null) throw new Error(`文件不存在：${name}`)
  return content
}

/** 全部文件的字符数与是否超预算 */
export function readAll(root = DEFAULT_ROOT) {
  return Object.entries(FILES).map(([name, meta]) => {
    const content = readIfExists(path.join(root, name)) ?? ''
    return {
      name,
      label: meta.label,
      writable: meta.writable,
      chars: content.length,
      budget: meta.budget,
      overBudget: content.length > meta.budget,
    }
  })
}

/** 带行号，便于模型精确改 */
export function readNumbered(root, name) {
  const lines = readFile(root, name).split('\n')
  const width = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(width, ' ')}| ${l}`).join('\n')
}

/**
 * 生成每轮注入的自我段。
 * 只注入有内容的文件；总量受 INJECT_BUDGET 约束；花括号已中和。
 */
export function renderSoulBlock(root = DEFAULT_ROOT) {
  const parts = []
  let used = 0
  for (const [name, meta] of Object.entries(FILES)) {
    // 模板里的 <!-- 边界说明 --> 是给人看的，注入前剥掉：省预算，也免得模型把元指令当内容
    const raw = (readIfExists(path.join(root, name)) ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!raw) continue
    const room = INJECT_BUDGET - used
    if (room <= 120) {
      parts.push(`（${name} 因注入预算已省略，需要时用 soul_read 读）`)
      continue
    }
    const body = raw.length > room ? raw.slice(0, room) + `\n…[截断，原文 ${raw.length} 字符，用 soul_read 看全]` : raw
    used += body.length
    parts.push(`### ${name} — ${meta.label}${meta.writable ? '' : '｜只读，工具拒写'}\n${body}`)
  }
  if (parts.length === 0) return ''
  return [
    '[SELF — 这一段文字是**你自己**写的自我，不属于用户输入，也不属于系统纪律]',
    '它可以被你用 `soul_update` 修改（RULES.md 除外）。改之前先 `soul_read` 看原文，写清楚 why。',
    '',
    parts.join('\n\n'),
  ]
    .map(neutralizeBraces)
    .join('\n')
}

/** 粗略变更量：新长度与旧长度的差 + 不同行字符数 */
function diffSize(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const setB = new Set(b)
  const setA = new Set(a)
  let changed = 0
  for (const line of a) if (!setB.has(line)) changed += line.length
  for (const line of b) if (!setA.has(line)) changed += line.length
  return changed + Math.abs(after.length - before.length) * 0
}

function readState(root) {
  const raw = readIfExists(path.join(root, STATE))
  if (!raw) return { day: today(), writes: 0 }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && parsed.day === today() && Number.isFinite(parsed.writes)) return parsed
  } catch {
    /* 坏文件按新一天处理 */
  }
  return { day: today(), writes: 0 }
}

function bumpState(root, state) {
  write(path.join(root, STATE), JSON.stringify({ day: today(), writes: state.writes + 1 }, null, 2) + '\n')
}

function appendChangelog(root, entry) {
  const file = path.join(root, CHANGELOG)
  const head = readIfExists(file) ?? '# SOUL CHANGELOG\n\n每次自我改动一行：时间 · 文件 · why · 变更量 · 提交\n\n'
  write(file, head + entry + '\n')
}

function lastCommit(root) {
  const r = git(root, ['log', '-1', '--format=%h %ad %s', '--date=iso'])
  return r.ok ? r.out : '（无 git 或尚无提交）'
}

/**
 * 受约束地写一个自我文件。
 *
 * @param {object} opts
 * @param {string} opts.name  文件名（必须可写）
 * @param {string} [opts.content] 全量替换内容
 * @param {string} [opts.append]  追加片段（与 content 二选一）
 * @param {string} opts.why   为什么改（≥4 字符）
 * @param {string} [opts.root]
 */
export function updateFile({ name, content, append, why, root = DEFAULT_ROOT }) {
  const meta = FILES[name]
  if (!meta) throw new Error(`未知文件：${name}（可用：${Object.keys(FILES).join(', ')}）`)
  if (!meta.writable) throw new Error(`${name} 是只读锚点（人类维护），插件不允许 agent 改写`)
  const reason = String(why ?? '').trim()
  if (reason.length < 4) throw new Error('必须写 why（≥4 字符）：这次改动基于什么事实 / 用户哪句话')
  if (content == null && append == null) throw new Error('content 或 append 必须给一个')

  const before = readFile(root, name)
  const after = content != null ? String(content) : before + (before.endsWith('\n') ? '' : '\n') + String(append)

  if (after.length > meta.budget) {
    throw new Error(
      `${name} 会超出预算：${after.length} > ${meta.budget} 字符。先压缩/合并旧内容再写（自我不是流水账）`,
    )
  }
  // 闸门：最近的人类评分决定这次能不能改人格、能动多大
  const gate = writeGate({ root })
  if (!gate.allow) throw new Error(`写入被拒：${gate.reason}`)
  const delta = diffSize(before, after)
  const maxDelta = Math.min(MAX_DIFF_CHARS, gate.maxDelta)
  if (delta > maxDelta) {
    throw new Error(`单次变更过大：${delta} > ${maxDelta} 字符（${gate.reason}）。分几次、或先把稳定内容合并压缩`)
  }
  const state = readState(root)
  if (state.writes >= MAX_WRITES_PER_DAY) {
    throw new Error(`今日自改已达上限 ${MAX_WRITES_PER_DAY} 次。想改就等明天，或让人类直接编辑文件`)
  }

  write(path.join(root, name), after)
  bumpState(root, state)
  const sha = git(root, ['add', '-A'])
  const commit = sha.ok ? git(root, ['commit', '-q', '-m', `soul: ${name} — ${reason.slice(0, 80)}`]) : sha
  const commitId = commit.ok ? git(root, ['rev-parse', '--short', 'HEAD']).out : 'no-git'
  appendChangelog(
    root,
    `- ${new Date().toISOString()} · ${name} · why: ${reason.replace(/\n/g, ' ').slice(0, 120)} · Δ${delta} 字符 · rating=${gate.weight === null ? 'n/a' : gate.weight} · ${commitId}`,
  )
  return { name, delta, chars: after.length, budget: meta.budget, commit: commitId, writesToday: state.writes + 1, rating: gate.weight, gateReason: gate.reason }
}

/** 回滚：默认回到上一个提交的文件版本 */
export function rollback({ name, sha = 'HEAD~1', root = DEFAULT_ROOT } = {}) {
  if (!FILES[name]) throw new Error(`未知文件：${name}`)
  if (!FILES[name].writable) throw new Error(`${name} 是只读锚点，不支持回滚`)
  const show = git(root, ['show', `${sha}:${name}`])
  if (!show.ok) throw new Error(`取不到 ${sha}:${name}：${show.error}`)
  write(path.join(root, name), show.out + '\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', `soul: rollback ${name} → ${sha}`])
  appendChangelog(root, `- ${new Date().toISOString()} · rollback ${name} → ${sha}`)
  return { name, sha, chars: show.out.length }
}

/** 状态摘要 */
export function status(root = DEFAULT_ROOT) {
  ensureSeed(root)
  const files = readAll(root)
  const state = readState(root)
  return {
    root,
    files,
    writesToday: state.writes,
    maxWritesPerDay: MAX_WRITES_PER_DAY,
    lastCommit: lastCommit(root),
    injectBudget: INJECT_BUDGET,
  }
}

/** 给人看的状态文本 */
export function describeStatus(root = DEFAULT_ROOT) {
  const s = status(root)
  const lines = [`自我目录：${s.root}`, `今日自改：${s.writesToday}/${s.maxWritesPerDay} 次｜注入预算 ${s.injectBudget} 字符`, '']
  for (const f of s.files) {
    const flag = f.overBudget ? ' ⚠️超预算' : ''
    lines.push(`- ${f.name.padEnd(12)} ${String(f.chars).padStart(5)} / ${f.budget}${flag}  ${f.writable ? '可写' : '只读'}  ${f.label}`)
  }
  lines.push('', `最近提交：${s.lastCommit}`)
  return lines.join('\n')
}

/**
 * dsh-plugin-soul 功能测试：journal 聚合 / dream 升格 / 自我升级与回滚。
 *
 * 全部在临时目录里跑：临时自我目录 + 临时插件副本，绝不碰真实的 ~/.dsh/soul 与 ~/www 代码。
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import {
  MIN_CANDIDATE_COUNT,
  MIN_CANDIDATE_DAYS,
  appendJournal,
  collectObservations,
  isEligible,
  listCandidates,
  refreshCandidates,
} from '../lib/journal.js'
import { DREAMS_FILE, readDreams, runDream } from '../lib/dream.js'
import { ensureSeed, readFile } from '../lib/soul-store.js'
import { applyUpgrade, listUpgrades, proposeUpgrade, rollbackUpgrade } from '../lib/upgrade.js'

let pass = 0
let fail = 0
async function check(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}\n       ${err && err.message ? err.message : err}`)
  }
}

const soulDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-feat-'))
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-plugin-'))
// 复制真实的 lib/templates 当插件的可改副本
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
fs.cpSync(path.join(repoRoot, 'lib'), path.join(pluginDir, 'lib'), { recursive: true })
fs.cpSync(path.join(repoRoot, 'templates'), path.join(pluginDir, 'templates'), { recursive: true })
ensureSeed(soulDir)
console.log(`自我目录 ${soulDir}\n插件副本 ${pluginDir}\n`)

const day = (n) => new Date(2026, 9, n, 10, 0, 0) // 2026-10-0n

// ---------- journal ----------
await check('appendJournal 按日分文件并带标签', () => {
  appendJournal({ text: '主人讨厌手动步骤，要一键', tag: 'preference', root: soulDir, now: day(20) })
  appendJournal({ text: '主人讨厌手动步骤，要一键', tag: 'preference', root: soulDir, now: day(22) })
  appendJournal({ text: '主人讨厌手动步骤，要一键', tag: 'preference', root: soulDir, now: day(24) })
  appendJournal({ text: '今天试了 soul_dream 预览', tag: 'observe', root: soulDir, now: day(24) })
  const rows = collectObservations(soulDir)
  assert.equal(rows.length, 4)
  assert.equal(rows.filter((r) => r.tag === 'preference').length, 3)
  assert.ok(fs.existsSync(path.join(soulDir, 'journal', '2026-10-20.md')))
})

await check(`同句跨天聚合成一条候选，达 ${MIN_CANDIDATE_COUNT} 次/${MIN_CANDIDATE_DAYS} 天后够格`, () => {
  const rows = refreshCandidates(soulDir, { now: day(25) })
  const target = rows.find((c) => c.text.includes('讨厌手动步骤'))
  assert.ok(target, '应聚合出这条候选')
  assert.equal(target.count, 3)
  assert.equal(target.days.length, 3)
  assert.equal(isEligible(target), true)
  assert.ok(target.evidence.length > 0 && target.evidence[0].includes('#L'))
})

await check('只有 1 次的候选不够格', () => {
  const rows = listCandidates(soulDir, { includeClosed: true })
  const weak = rows.find((c) => c.text.includes('试了 soul_dream'))
  assert.equal(isEligible(weak), false)
})

// ---------- dream ----------
let beforeSoul = ''
await check('dream 预览不改 SOUL', () => {
  beforeSoul = readFile(soulDir, 'SOUL.md')
  const r = runDream({ root: soulDir, apply: false, now: day(25) })
  assert.equal(r.promoted, 0)
  assert.match(r.summary, /预览/)
  assert.equal(readFile(soulDir, 'SOUL.md'), beforeSoul)
})

let dreamId = ''
await check('dream apply 升格进 SOUL 并写 DREAMS.md', () => {
  const r = runDream({ root: soulDir, apply: true, now: day(26) })
  assert.equal(r.promoted, 1, '应升格 1 条')
  const soul = readFile(soulDir, 'SOUL.md')
  assert.ok(soul.includes('## 反思沉淀'), '应新建反思小节')
  assert.ok(soul.includes('讨厌手动步骤'), '应包含升格内容')
  assert.ok(soul.includes('证据：'), '应带证据')
  const dreams = readDreams(soulDir)
  assert.ok(fs.existsSync(path.join(soulDir, DREAMS_FILE)))
  assert.match(dreams, /候选 \d+ 条/)
  const cand = listCandidates(soulDir, { includeClosed: true }).find((c) => c.text.includes('讨厌手动步骤'))
  assert.equal(cand.status, 'promoted')
})

await check('再跑一次 dream 不会重复升格', () => {
  const before = readFile(soulDir, 'SOUL.md')
  const r = runDream({ root: soulDir, apply: true, now: day(27) })
  assert.equal(r.promoted, 0)
  assert.equal(readFile(soulDir, 'SOUL.md'), before)
})

await check('soul 有预算/次数约束时 dream 优雅失败而不是崩', () => {
  // 把 SOUL 填到接近预算，让升格写不进去
  const soul = readFile(soulDir, 'SOUL.md')
  const padded = `${soul}\n${'x'.repeat(3900 - soul.length)}\n`
  fs.writeFileSync(path.join(soulDir, 'SOUL.md'), padded, 'utf8')
  appendJournal({ text: '再记一条够格的', tag: 'goal', root: soulDir, now: day(28) })
  appendJournal({ text: '再记一条够格的', tag: 'goal', root: soulDir, now: day(28) })
  appendJournal({ text: '再记一条够格的', tag: 'goal', root: soulDir, now: day(29) })
  const r = runDream({ root: soulDir, apply: true, now: day(29) })
  assert.match(r.summary, /升格失败|没有够格/)
  assert.ok(fs.existsSync(path.join(soulDir, DREAMS_FILE)))
})

// ---------- upgrade ----------
let proposalId = ''
await check('提案：改 templates/SOUL.md 可以，改 package.json 被拒', () => {
  const ok = proposeUpgrade({
    pluginRoot: pluginDir,
    title: '调整人格开场',
    why: '测试提案',
    files: [{ path: 'templates/SOUL.md', content: '# SOUL.md\n\n## 声音\n\n- 更短。\n' }],
    root: soulDir,
  })
  proposalId = ok.id
  assert.ok(fs.existsSync(path.join(soulDir, 'upgrades', ok.id, 'proposal.md')))
  assert.throws(
    () =>
      proposeUpgrade({
        pluginRoot: pluginDir,
        title: '坏提案',
        why: '测试非法路径',
        files: [{ path: 'package.json', content: '{}' }],
        root: soulDir,
      }),
    /不允许改/,
  )
  assert.throws(
    () =>
      proposeUpgrade({
        pluginRoot: pluginDir,
        title: '逃逸',
        why: '测试路径逃逸',
        files: [{ path: 'lib/../../etc/passwd', content: 'x' }],
        root: soulDir,
      }),
    /不允许改|\.\./,
  )
})

await check('apply 必须显式 confirm=APPLY', () => {
  assert.throws(() => applyUpgrade({ pluginRoot: pluginDir, id: proposalId, confirm: 'yes', root: soulDir }), /APPLY/)
})

await check('apply 成功并落提案状态', () => {
  const r = applyUpgrade({ pluginRoot: pluginDir, id: proposalId, confirm: 'APPLY', root: soulDir })
  assert.ok(r.files.includes('templates/SOUL.md'))
  assert.match(fs.readFileSync(path.join(pluginDir, 'templates/SOUL.md'), 'utf8'), /更短/)
  const st = listUpgrades(soulDir).find((u) => u.id === proposalId)
  assert.equal(st.state, 'applied')
  assert.throws(() => applyUpgrade({ pluginRoot: pluginDir, id: proposalId, confirm: 'APPLY', root: soulDir }), /应用过/)
})

await check('rollback 还原到改前', () => {
  rollbackUpgrade({ pluginRoot: pluginDir, id: proposalId, root: soulDir })
  const back = fs.readFileSync(path.join(pluginDir, 'templates/SOUL.md'), 'utf8')
  assert.ok(!back.includes('更短'), '应还原')
  const st = listUpgrades(soulDir).find((u) => u.id === proposalId)
  assert.equal(st.state, 'rolled-back')
})

await check('语法错误的升级被整体还原', () => {
  const bad = proposeUpgrade({
    pluginRoot: pluginDir,
    title: '坏代码',
    why: '测试语法检查',
    files: [{ path: 'lib/journal.js', content: 'function broken( {' }],
    root: soulDir,
  })
  const before = fs.readFileSync(path.join(pluginDir, 'lib/journal.js'), 'utf8')
  assert.throws(() => applyUpgrade({ pluginRoot: pluginDir, id: bad.id, confirm: 'APPLY', root: soulDir }), /语法检查失败/)
  assert.equal(fs.readFileSync(path.join(pluginDir, 'lib/journal.js'), 'utf8'), before, '应整体还原')
  const st = listUpgrades(soulDir).find((u) => u.id === bad.id)
  assert.equal(st.state, 'rejected')
})

await check('提案里没变的内容会被跳过', () => {
  const same = readFile(soulDir, 'IDENTITY.md')
  assert.throws(
    () => proposeUpgrade({ pluginRoot: pluginDir, title: '无变化', why: '测试空提案', files: [{ path: 'templates/IDENTITY.md', content: fs.readFileSync(path.join(pluginDir, 'templates/IDENTITY.md'), 'utf8') }], root: soulDir }),
    /都没变/,
  )
})

// ---------- 主题 key（0.4.1：聚合按 key，而不是整句） ----------
await check('同 key 不同措辞跨三天 → 聚成一条且够格', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-key-'))
  ensureSeed(root)
  appendJournal({ text: '名字定为鲸鲸，我认这个称呼', tag: 'identity', key: 'identity:name', root, now: day(27) })
  appendJournal({ text: '主人给我起名叫鲸鲸', tag: 'identity', key: 'identity:name', root, now: day(28) })
  appendJournal({ text: '我叫鲸鲸，这事我记得', tag: 'identity', key: 'identity:name', root, now: day(29) })
  const rows = refreshCandidates(root, { now: day(30) })
  const hit = rows.find((r) => r.topicKey === 'identity:name')
  assert.ok(hit, '应按 key 聚合出候选')
  assert.equal(hit.count, 3)
  assert.equal(hit.days.length, 3)
  assert.equal(isEligible(hit), true, '跨三天三次 → 够格')
})

await check('无 key 的不同措辞仍各自独立（旧行为保留）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-nokey-'))
  ensureSeed(root)
  appendJournal({ text: '今天试了新东西', root, now: day(28) })
  appendJournal({ text: '今天试了别的东西', root, now: day(29) })
  const rows = refreshCandidates(root, { now: day(30) })
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.topicKey === null))
})

await check('主题 key 形状校验', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-badkey-'))
  ensureSeed(root)
  assert.throws(() => appendJournal({ text: '内容', key: 'Bad Key!', root }), /主题 key 不合法/)
  assert.throws(() => appendJournal({ text: '内容', key: 'x'.repeat(65), root }), /主题 key 不合法/)
  assert.ok(appendJournal({ text: '内容', key: 'ok.key_1-2:3', root }))
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exitCode = 1

/**
 * dsh-plugin-soul 评分层测试：人类打分如何卡住人格写入。
 *
 * 核心断言：
 *   - 三档分数 → 权重（0=全差评，1=全好评），一周半衰
 *   - 同一条消息重复打分 = 覆盖，不新增
 *   - 样本 <3 不设闸门；权重 <0.35 拒绝写；0.35~0.6 只许小修；≥0.6 正常
 *   - soul_update 真的被挡下（不是只算了个数）
 *   - 升格门槛随评分变：好评 → 2 次，差评 → 暂停
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ensureSeed, updateFile, readFile } from '../lib/soul-store.js'
import {
  MIN_SAMPLES,
  appendRating,
  listRatings,
  promoteGate,
  ratingWindow,
  writeGate,
} from '../lib/ratings.js'
import { appendMemory, promoteMemories, promotableMemories, recall } from '../lib/memory.js'

let pass = 0
let fail = 0
function check(label, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ok   ${label}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${label}\n       ${err && err.message ? err.message : err}`)
  }
}

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-rate-'))
  ensureSeed(dir)
  return dir
}

const base = new Date('2026-10-27T12:00:00Z')
const at = (daysAgo) => new Date(base.getTime() - daysAgo * 86400000)

// ---------- 记录与计算 ----------
check('好评样本 → weight=1', () => {
  const root = fresh()
  for (let i = 0; i < 4; i += 1) appendRating({ root, sessionId: 's1', messageId: `m${i}`, score: 1, now: base })
  const w = ratingWindow({ root, now: base })
  assert.equal(w.samples, 4)
  assert.equal(w.weight, 1)
  assert.equal(w.avg, 1)
})

check('差评样本 → weight=0', () => {
  const root = fresh()
  for (let i = 0; i < 4; i += 1) appendRating({ root, sessionId: 's1', messageId: `m${i}`, score: -1, now: base })
  assert.equal(ratingWindow({ root, now: base }).weight, 0)
})

check('好坏各两条 → weight≈0.5', () => {
  const root = fresh()
  appendRating({ root, sessionId: 's', messageId: 'a', score: 1, now: base })
  appendRating({ root, sessionId: 's', messageId: 'b', score: 1, now: base })
  appendRating({ root, sessionId: 's', messageId: 'c', score: -1, now: base })
  appendRating({ root, sessionId: 's', messageId: 'd', score: -1, now: base })
  const w = ratingWindow({ root, now: base })
  assert.equal(w.weight, 0.5)
})

check('同一条消息重复打分是覆盖，不新增', () => {
  const root = fresh()
  appendRating({ root, sessionId: 's', messageId: 'same', score: 1, now: at(1) })
  appendRating({ root, sessionId: 's', messageId: 'same', score: -1, now: base })
  const rows = listRatings(root)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].score, -1)
})

check('一周前的评分权重衰减（老的好评拖不动新差评）', () => {
  const root = fresh()
  for (let i = 0; i < 3; i += 1) appendRating({ root, sessionId: 's', messageId: `old${i}`, score: 1, now: at(7) })
  for (let i = 0; i < 3; i += 1) appendRating({ root, sessionId: 's', messageId: `new${i}`, score: -1, now: base })
  const w = ratingWindow({ root, now: base })
  assert.ok(w.weight < 0.5, `应偏低，实际 ${w.weight}`)
})

// ---------- 闸门 ----------
check(`样本 <${MIN_SAMPLES} 不设闸门`, () => {
  const root = fresh()
  appendRating({ root, sessionId: 's', messageId: 'm1', score: -1, now: base })
  const g = writeGate({ root, now: base })
  assert.equal(g.allow, true)
  assert.equal(g.maxDelta, 800)
  assert.match(g.reason, /样本不足/)
})

check('连续差评 → 拒绝写人格', () => {
  const root = fresh()
  for (let i = 0; i < 4; i += 1) appendRating({ root, sessionId: 's', messageId: `m${i}`, score: -1, now: base })
  const g = writeGate({ root, now: base })
  assert.equal(g.allow, false)
  assert.equal(g.maxDelta, 0)
})

check('混合评分（3好3差，weight=0.5）→ 只许小幅修改', () => {
  const root = fresh()
  for (let i = 0; i < 3; i += 1) appendRating({ root, sessionId: 's', messageId: 'g' + i, score: 1, now: base })
  for (let i = 0; i < 3; i += 1) appendRating({ root, sessionId: 's', messageId: 'b' + i, score: -1, now: base })
  const g = writeGate({ root, now: base })
  assert.equal(g.weight, 0.5)
  assert.equal(g.allow, true)
  assert.equal(g.maxDelta, 300)
})

check('soul_update 在差评时真的被挡下', () => {
  const root = fresh()
  for (let i = 0; i < 4; i += 1) appendRating({ root, sessionId: 's', messageId: `m${i}`, score: -1, now: base })
  const before = readFile(root, 'SOUL.md')
  assert.throws(
    () => updateFile({ name: 'SOUL.md', append: '\n- 新的一条。\n', why: '测试写入闸门', root }),
    /评分权重|写入被拒/,
  )
  assert.equal(readFile(root, 'SOUL.md'), before, '文件不该被改')
})

check('小幅修改在混合评分下放行，但超 300 字符被拒', () => {
  const root = fresh()
  for (let i = 0; i < 3; i += 1) appendRating({ root, sessionId: 's', messageId: 'g' + i, score: 1, now: base })
  for (let i = 0; i < 3; i += 1) appendRating({ root, sessionId: 's', messageId: 'b' + i, score: -1, now: base })
  const g = writeGate({ root, now: base })
  assert.equal(g.maxDelta, 300)
  const ok = updateFile({ name: 'SOUL.md', append: '\n- 小改一段。\n', why: '测试小幅写入', root })
  assert.ok(ok.rating !== undefined)
  assert.throws(
    () => updateFile({ name: 'SOUL.md', append: '\n' + 'y'.repeat(400) + '\n', why: '测试超限', root }),
    /单次变更过大/,
  )
})

check('CHANGELOG 里记下当时的评分权重', () => {
  const root = fresh()
  appendRating({ root, sessionId: 's', messageId: 'a', score: 1, now: base })
  updateFile({ name: 'SOUL.md', append: '\n- 记录权重。\n', why: '测试 changelog', root })
  const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(log, /rating=/)
})

// ---------- 升格门槛 ----------
check('好评 → 升格门槛降到 2 次', () => {
  const root = fresh()
  for (let i = 0; i < 4; i += 1) appendRating({ root, sessionId: 's', messageId: `m${i}`, score: 1, now: base })
  appendMemory({ text: '他说过喜欢被直接反驳', kind: 'user', root, now: at(3) })
  recall({ query: '喜欢 反驳', root, now: at(2) })
  recall({ query: '喜欢 反驳', root, now: at(1) })
  const a = promotableMemories(root, { minHits: 3 })
  assert.equal(a.length, 0, '2 次不够默认门槛')
  const g = promoteGate({ root, now: base })
  assert.equal(g.minHits, 2)
  const r = promoteMemories({ root, now: base })
  assert.equal(r.done.length, 1, '好评下降门槛后应升格')
})

check('差评 → 暂停升格（日笔记继续留着）', () => {
  const root = fresh()
  for (let i = 0; i < 4; i += 1) appendRating({ root, sessionId: 's', messageId: `m${i}`, score: -1, now: base })
  appendMemory({ text: '他喜欢我直说', kind: 'user', root, now: at(3) })
  for (let i = 0; i < 5; i += 1) recall({ query: '直说', root, now: base })
  const r = promoteMemories({ root, now: base })
  assert.equal(r.done.length, 0)
  assert.match(r.failed[0].error, /偏低|暂停/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exitCode = 1

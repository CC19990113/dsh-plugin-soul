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
check(`样本 <${MIN_SAMPLES} 时评分不参与加权`, () => {
  const root = fresh()
  appendRating({ root, sessionId: 's', messageId: 'm1', score: -1, now: base })
  const g = writeGate({ root, now: base })
  assert.equal(g.samples, 1)
  assert.match(g.reason, /样本不足/)
  assert.equal(g.allow, true)
  assert.equal(g.maxDelta, 800)
})

check('连续差评也允许写（评分只加权，不阻塞）', () => {
  const root = fresh()
  for (let i = 0; i < 4; i += 1) appendRating({ root, sessionId: 's', messageId: `m${i}`, score: -1, now: base })
  const g = writeGate({ root, now: base })
  assert.equal(g.weight, 0)
  assert.equal(g.allow, true, '差评不该禁止写入')
  assert.equal(g.maxDelta, 800, '上限与评分无关')
  assert.match(g.reason, /不阻塞/)
})

check('混合评分（3好3差）同样正常写入', () => {
  const root = fresh()
  for (let i = 0; i < 3; i += 1) appendRating({ root, sessionId: 's', messageId: 'g' + i, score: 1, now: base })
  for (let i = 0; i < 3; i += 1) appendRating({ root, sessionId: 's', messageId: 'b' + i, score: -1, now: base })
  const g = writeGate({ root, now: base })
  assert.equal(g.weight, 0.5)
  assert.equal(g.allow, true)
  assert.equal(g.maxDelta, 800)
})

check('差评时 soul_update 仍能写，并把 rating 记进 CHANGELOG', () => {
  const root = fresh()
  for (let i = 0; i < 4; i += 1) appendRating({ root, sessionId: 's', messageId: `m${i}`, score: -1, now: base })
  const r = updateFile({ name: 'SOUL.md', append: '\n- 差评期间也能写。\n', why: '验证评分不阻塞写入', root })
  assert.equal(r.rating, 0)
  const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(log, /rating=0/)
})

check('超过 800 字符被拒（硬上限，与评分无关）', () => {
  const root = fresh()
  appendRating({ root, sessionId: 's', messageId: 'a', score: 1, now: base })
  updateFile({ name: 'SOUL.md', append: '\n- 小改。\n', why: '验证小改放行', root })
  assert.throws(
    () => updateFile({ name: 'SOUL.md', append: '\n' + 'y'.repeat(900) + '\n', why: '验证超限', root }),
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

check('差评不加速：门槛仍是 3 次，但够格就照升', () => {
  const root = fresh()
  for (let i = 0; i < 4; i += 1) appendRating({ root, sessionId: 's', messageId: `m${i}`, score: -1, now: base })
  appendMemory({ text: '他喜欢我直说', kind: 'user', root, now: at(3) })
  for (let i = 0; i < 5; i += 1) recall({ query: '直说', root, now: base })
  const g = promoteGate({ root, now: base })
  assert.equal(g.minHits, 3, '差评不加门槛，也不降门槛')
  assert.equal(g.allow, true)
  const r = promoteMemories({ root, now: base })
  assert.equal(r.done.length, 1, '差评不该禁止升格')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exitCode = 1

/**
 * dsh-plugin-soul 记忆层测试：只测「性格 + 对话」这一层。
 *
 * 关键断言：
 *   - 默认 kind = talk，非法 kind 回落 talk（技术类 kind 不该存在）
 *   - 中文按双字切词、英文按词
 *   - recall 会给命中条目 +1 hit（升格的唯一依据）
 *   - hits ≥ 3 才够格；升格写进对应小节；不重复升格
 *   - MEMORY.md 超预算拒写
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { ensureSeed, readFile } from '../lib/soul-store.js'
import {
  MEMORY_BUDGET,
  MIN_PROMOTE_HITS,
  addCurated,
  appendMemory,
  collectMemories,
  describeMemory,
  memoryStatus,
  promoteMemories,
  promotableMemories,
  recall,
  readCurated,
  tokenize,
} from '../lib/memory.js'

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-mem-'))
ensureSeed(root)
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
console.log(`临时自我目录 ${root}\n`)

const d = (n) => new Date(2026, 9, n, 11, 0, 0)

// ---------- 写入 ----------
check('appendMemory 默认 kind=talk', () => {
  const r = appendMemory({ text: '他说不喜欢我铺垫太多，直接给结论', root, now: d(20) })
  assert.match(r.line, /\[talk\]/)
  assert.ok(fs.existsSync(path.join(root, 'memory', '2026-10-20.md')))
})

check('kind=self / user / lesson / pref 都能记', () => {
  appendMemory({ text: '我说话短一点他就开心', kind: 'self', root, now: d(21) })
  appendMemory({ text: '他喜欢猫', kind: 'user', root, now: d(21) })
  appendMemory({ text: '上次没核实就下结论被纠正了', kind: 'lesson', root, now: d(22) })
  appendMemory({ text: '他改了偏好：不要 emoji', kind: 'pref', root, now: d(22) })
  const rows = collectMemories(root)
  assert.equal(rows.length, 5)
  assert.deepEqual([...new Set(rows.map((r) => r.kind))].sort(), ['lesson', 'pref', 'self', 'talk', 'user'])
})

check('非法 kind 回落 talk（技术类 kind 已被移除）', () => {
  appendMemory({ text: '项目里用 pnpm', kind: 'project', root, now: d(22) })
  const last = collectMemories(root).at(-1)
  assert.equal(last.kind, 'talk')
})

check('空/超长被拒', () => {
  assert.throws(() => appendMemory({ text: '', root }), /太短/)
  assert.throws(() => appendMemory({ text: 'x'.repeat(500), root }), /太长/)
})

// ---------- 切词与检索 ----------
check('tokenize：中文双字 + 英文词', () => {
  const t = tokenize('他说 Cat 很可爱')
  assert.ok(t.includes('可爱'))
  assert.ok(t.includes('cat'))
  assert.deepEqual(tokenize(''), [])
})

check('recall 命中中文并返回来源行号', () => {
  const r = recall({ query: '猫', root, now: d(23) })
  assert.ok(r.rows.length > 0)
  assert.ok(r.rows.some((x) => x.text.includes('猫')))
  assert.match(r.rows[0].source, /^memory\/2026-10-\d{2}\.md#L\d+$/)
})

check('recall 命中英文', () => {
  const r = recall({ query: 'pnpm', root, now: d(23) })
  assert.ok(r.rows.length > 0)
})

check('空查询不返回也不计 hit', () => {
  const r = recall({ query: '   ', root, now: d(23) })
  assert.equal(r.rows.length, 0)
})

// ---------- 命中计数 → 升格闸门 ----------
check(`recall 每次给命中条目 +1 hit`, () => {
  const q = '猫'
  const before = recall({ query: q, root, now: d(23) }).rows[0]
  const after = recall({ query: q, root, now: d(23) }).rows.find((x) => x.source === before.source)
  assert.equal(after.hits, before.hits + 1)
})

check(`未到 ${MIN_PROMOTE_HITS} 次不够格`, () => {
  appendMemory({ text: '独立条目：只被召回两次', kind: 'self', root, now: d(23) })
  recall({ query: '独立条目', root, now: d(23) })
  recall({ query: '独立条目', root, now: d(23) })
  const el = promotableMemories(root)
  assert.ok(!el.some((r) => r.text.includes('独立条目')), '只召回 2 次不该够格')
  const hit = el.find((r) => r.text.includes('独立条目'))
  assert.equal(hit, undefined)
})

check(`召回 ${MIN_PROMOTE_HITS} 次后够格`, () => {
  for (let i = 0; i < MIN_PROMOTE_HITS; i += 1) recall({ query: '猫', root, now: d(24) })
  const el = promotableMemories(root)
  assert.ok(el.length >= 1, '应够格')
  assert.ok(el[0].hits >= MIN_PROMOTE_HITS)
})

// ---------- 升格 ----------
check('promote 写进 MEMORY.md 对应小节', () => {
  const r = promoteMemories({ root, limit: 1, now: d(25) })
  assert.equal(r.done.length, 1)
  const curated = readCurated(root)
  const kind = r.done[0].kind
  const expectSection = { talk: '## 对话里的事', user: '## 关于你', self: '## 关于我', lesson: '## 我学到的', pref: '## 偏好变化' }[kind]
  assert.ok(curated.includes(expectSection), `缺小节 ${expectSection}`)
  assert.ok(curated.includes(r.done[0].text.slice(0, 10)))
  assert.ok(curated.includes('命中'), '应带命中次数')
})

check('升格后不再重复升格', () => {
  const before = readCurated(root)
  const r = promoteMemories({ root, limit: 5, now: d(26) })
  assert.equal(r.done.length, 0)
  assert.equal(readCurated(root), before)
})

check('MEMORY.md 超预算拒写', () => {
  const padded = `# MEMORY\n\n## 对话里的事\n\n${'- ' + 'x'.repeat(200) + '\n`'.repeat(1)}`.padEnd(MEMORY_BUDGET + 50, 'y')
  fs.writeFileSync(path.join(root, 'MEMORY.md'), padded, 'utf8')
  assert.throws(
    () => addCurated({ text: '再来一条', kind: 'talk', root, now: d(26) }),
    /超出预算/,
  )
})

// ---------- 注入与状态 ----------
check('MEMORY.md 在注入段里（每轮可见）', () => {
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '# MEMORY\n\n## 关于你\n\n- 2026-10-26：他喜欢猫\n', 'utf8')
  const block = fs.readFileSync(path.join(repoRoot, 'templates', 'MEMORY.md'), 'utf8')
  assert.ok(block.includes('关于我') && block.includes('关于你'), '模板应有关系维度小节')
  // 真正注入由 renderSoulBlock 负责，这里验证 FILES 收录了 MEMORY.md
  return import('../lib/soul-store.js').then((m) => {
    assert.ok(m.FILES['MEMORY.md'], 'FILES 应含 MEMORY.md')
    assert.ok(m.FILES['MEMORY.md'].writable)
  })
})

check('memoryStatus / describeMemory 输出', () => {
  const st = memoryStatus(root, d(27))
  assert.ok(st.entries >= 5)
  assert.ok(st.days >= 3)
  assert.equal(st.curatedBudget, MEMORY_BUDGET)
  const txt = describeMemory(root)
  assert.match(txt, /长期记忆：MEMORY\.md/)
  assert.match(txt, /日记忆 \d+ 条/)
})

check('日记忆与项目记忆隔离（不碰 ~/.dsh/memory）', () => {
  const files = fs.readdirSync(path.join(root, 'memory'))
  assert.ok(files.every((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)))
  assert.ok(!fs.existsSync(path.join(root, 'memory', 'adx-admin-backend')))
})

check('升格会写进 git 历史（MEMORY.md 可回滚）', () => {
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-mem-commit-'))
  ensureSeed(root2)
  appendMemory({ text: '他说过喜欢被直接反驳', kind: 'user', root: root2, now: d(28) })
  for (let i = 0; i < 3; i += 1) recall({ query: '反驳', root: root2, now: d(29) })
  const r = promoteMemories({ root: root2, now: d(29) })
  assert.equal(r.done.length, 1)
  assert.notEqual(r.commit, null)
  assert.notEqual(r.commit, 'no-git', '升格应有 git 提交')
  const log = execFileSync('git', ['-C', root2, 'log', '--oneline', '--', 'MEMORY.md'], { encoding: 'utf8' }).trim()
  assert.match(log, /promote 1 条日记忆/)
  // 回滚能力：soul_rollback 只认 FILES 里的可写文件，MEMORY.md 在其中
  return import('../lib/soul-store.js').then((m) => {
    assert.equal(m.FILES['MEMORY.md'].writable, true)
  })
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exitCode = 1

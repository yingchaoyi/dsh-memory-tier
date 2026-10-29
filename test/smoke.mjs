/**
 * smoke.mjs —— 不启 DSH 也能验：工具能挂、路由能读能写、三档的容量/过期/注入真的按规则走。
 * 跑法：DSH_HOME=/tmp/mt-test node test/smoke.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = process.env.DSH_HOME || mkdtempSync(join(tmpdir(), 'mt-'))

const { apply } = await import('../lib/index.mjs')

const tools = new Map()
const routes = new Map()

const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
  agents: { list: () => [] },
  webServer: { register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path) } },
  effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
  inject: (_deps, fn) => { const r = fn(ctx); return typeof r === 'function' ? r : () => {} },
  on: () => {},
}

apply(ctx, {})

const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1 }
const ok = (m) => console.log('✓ ' + m)
const assert = (cond, m) => (cond ? ok(m) : fail(m))

assert(tools.size === 5, '挂了 5 个工具：' + [...tools.keys()].join(', '))
assert(routes.size >= 6, '挂了 ' + routes.size + ' 条路由')

const call = async (name, args) => tools.get(name).execute(args || {}, {})

// 写三档
let r = await call('mem_note', { tier: 'long', text: '小刘是刀塔二队长，段位传奇', tags: ['小刘', '刀塔'], imp: 5, kind: 'person', pinned: true })
assert(r.ok, '长期写入')
r = await call('mem_note', { tier: 'mid', text: '小刘上周说想冲一波万古', tags: ['小刘', '上分'], imp: 3 })
assert(r.ok, '中期写入')
r = await call('mem_note', { tier: 'short', text: '今天群里在聊 DSH 插件开发', tags: ['DSH'], imp: 2, kind: 'event' })
assert(r.ok, '短期写入')

// 去重合并
r = await call('mem_note', { tier: 'long', text: '小刘是刀塔二队长，段位传奇', imp: 5 })
assert(r.ok && /更新/.test(r.message), '同一条不会重复记')

// 检索
r = await call('mem_search', { query: '小刘 段位' })
assert(r.ok && r.text.includes('小刘'), 'mem_search 命中')
r = await call('mem_search', { query: '完全不存在的词xyz' })
assert(r.ok && r.text.includes('没有找到'), '搜不到时明确说没有')

// 统计
r = await call('mem_persona', {})
assert(r.ok && r.text.includes('空的'), 'mem_persona 空态可读：' + r.text)
r = await call('mem_persona', { text: '自称老子，称主人为老板；毒舌有梗，2~5 句' })
assert(r.ok && r.text.includes('人设已更新'), 'mem_persona 可写：' + r.text)
r = await call('mem_persona', {})
assert(r.text.includes('自称老子'), 'mem_persona 写回可读：' + r.text)

r = await call('mem_stats', {})
assert(r.ok && /长期 1\/120/.test(r.text), 'mem_stats 条数对')

// 注入（走 state 路由）
const fakeRes = () => {
  const out = { code: 0, body: '' }
  return {
    out,
    writeHead(code) { out.code = code },
    end(body) { out.body = body },
  }
}
const getState = async (q) => {
  const res = fakeRes()
  await routes.get('/api/memory-tier/state')({ url: '/api/memory-tier/state' + (q ? '?q=' + encodeURIComponent(q) : ''), on: () => {} }, res)
  return JSON.parse(res.out.body)
}
let st = await getState('小刘最近在打什么')
assert(st.ok && st.injected.includes('小刘'), '按问题检索后注入里带上了小刘')
assert(st.injected.includes('【记忆·长期】'), '注入分档')
assert(st.injected.length <= st.settings.charBudget + 80, '注入没有超字数预算（' + st.injected.length + ' 字）')

// 参数改动能存下来
const postJson = async (path, body) => {
  const res = fakeRes()
  const req = { url: path, on: (ev, fn) => { if (ev === 'end') fn() } }
  // 极简 req：直接把 body 塞给 readBody 的 data/end
  const handler = routes.get(path)
  const origRead = req.on
  req.on = (ev, fn) => {
    if (ev === 'data') fn(Buffer.from(JSON.stringify(body)))
    else if (ev === 'end') fn()
    return req
  }
  void origRead
  await handler(req, res)
  return JSON.parse(res.out.body)
}
let sres = await postJson('/api/memory-tier/settings', { shortDays: 9, caps: { short: 5 } })
assert(sres.ok && sres.settings.shortDays === 9 && sres.settings.caps.short === 5, '参数保存（短期 9 天 / 容量 5）')

// 短期超容量 → 按分数淘汰，且保留高重要度的
for (let i = 0; i < 9; i++) {
  await call('mem_note', { tier: 'short', text: '流水事 ' + i + ' 号，内容各不相同', imp: i === 4 ? 5 : 1, kind: 'event' })
}
st = await getState('')
assert(st.tiers.short.length === 5, '短期容量 5 生效（现在 ' + st.tiers.short.length + ' 条）')
assert(st.tiers.short.some((e) => e.text.includes('4 号')), '淘汰时保住了高重要度那条')

// 预览路由
const prev = await postJson('/api/memory-tier/preview', { q: '小刘' })
assert(prev.ok && prev.text.includes('小刘'), '预览路由可用')

// 删一条
const target = st.tiers.short[0]
const del = await postJson('/api/memory-tier/delete', { tier: 'short', id: target.id })
assert(del.ok && del.removed === 1, '删除生效')

// 锁定底稿：不许删、注入里带 🔒
r = await call('mem_note', { tier: 'long', text: '小刘 2026-10 说自己在冲万古，至今没上（待证）', tags: ['小刘', '万古'], imp: 4, kind: 'person', locked: true })
assert(r.ok, '写入锁定底稿')
const lockedEntry = (await getState('')).tiers.long.find((e) => e.locked)
const delLocked = await postJson('/api/memory-tier/delete', { tier: 'long', id: lockedEntry.id })
assert(!delLocked.ok, '锁定条目拒绝删除')
const delByQuery = await call('mem_forget', { query: '万古', tier: 'long' })
assert(!delByQuery.ok, 'mem_forget 也删不掉锁定条目')
st = await getState('小刘')
assert(st.injected.includes('🔒'), '注入里锁定的条目带 🔒 标记')
assert(st.injected.includes('回完这轮顺手判一句'), '注入尾部带「回完自评」的规矩')

// 自动记录：群消息进来 → 本地抽人名 → 短期档（等一次 tick）
const fakeSession = {
  id: 'fake-session',
  messages: () => [{ role: 'user', content: '[小刘(2313535058)] 今天又没上万古，非说是队友太菜' }],
}
ctx.agents.list = () => [{ session: fakeSession }]
await new Promise((res) => setTimeout(res, 2600))
st = await getState('')
const auto = st.tiers.short.find((e) => e.text.includes('今天又没上万古'))
assert(!!auto, '自动把群消息记进短期档')
assert(auto && auto.tags.includes('小刘'), '自动记录抽出了人名当标签：' + (auto ? auto.tags.join('/') : ''))
assert(auto && auto.text.startsWith('小刘：'), '自动记录带上说话人')

console.log('\n' + (process.exitCode ? '有失败项' : '全过'))

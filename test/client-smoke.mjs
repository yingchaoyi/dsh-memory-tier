/**
 * client-smoke.mjs —— 不开浏览器也能验渲染：假 React + 假 slots，
 * 把设置面板整棵树跑一遍，看有没有炸、该有的字在不在。
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// ---- 假 React：只要 createElement + 几个 hook ----
const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  useState(v) { return [typeof v === 'function' ? v() : v, () => {}] },
  useEffect() {},
  useCallback(f) { return f },
  useRef(v) { return { current: v } },
  Fragment: 'Fragment',
}

let captured = null
const documentStub = {
  head: { appendChild() {} },
  createElement() { return { setAttribute() {}, textContent: '', remove() {} } },
}

globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => { captured = { id, factory } } },
  prompt: () => null,
  confirm: () => false,
}
globalThis.document = documentStub

// 跑 client.js（它就是一段用 window 的普通脚本）
new Function('window', 'document', src)(globalThis.window, documentStub)

const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1 }
const ok = (m) => console.log('✓ ' + m)
const assert = (c, m) => (c ? ok(m) : fail(m))

assert(captured && captured.id === 'dsh-memory-tier', '模块 id 正确')

const mod = captured.factory(() => React)
assert(typeof mod.apply === 'function', 'factory 返回 apply')

// ---- 假 slots ----
const registered = []
const slots = {
  inject(name, fn) { fn() },
  register(def, render) { registered.push({ def, render }); return () => {} },
}
const ctx = { get: () => slots, effect: (fn) => { const off = fn(); return off }, slots }
mod.apply(ctx)

assert(registered.length === 1, '注册了 1 个设置分区')
const def = registered[0].def
assert(def.name === 'settings.section' && def.label === '三档记忆', '分区名与标题：' + def.label)

// ---- 假数据 + 递归渲染 ----
const state = {
  ok: true,
  settings: {
    enabled: true, shortDays: 4, midDays: 30,
    caps: { long: 120, mid: 240, short: 60 },
    inject: { long: 12, mid: 6, short: 6 },
    charBudget: 1600,
    personaText: '平时用咱自称，说话别端着。',
  },
  tiers: {
    long: Array.from({ length: 13 }, (_, i) => ({
      id: 'a' + i,
      text: '长期条目 ' + i + (i === 0 ? '：小刘是刀塔二队长' : ''),
      tags: i === 0 ? ['小刘'] : [],
      imp: 5 - (i % 3),
      kind: i === 0 ? 'person' : 'fact',
      pinned: i === 0,
      locked: i === 1,
      hits: 0,
      at: Date.now(),
    })),
    mid: [{ id: 'b1', text: '小刘想冲万古', tags: [], imp: 3, kind: 'fact', pinned: false, hits: 2, at: Date.now() }],
    short: [{ id: 'c1', text: '群里在聊插件', tags: [], imp: 2, kind: 'event', pinned: false, hits: 0, at: Date.now() }],
  },
  swept: { mid: 0, short: 0 },
  labels: { tiers: { long: '长期', mid: '中期', short: '短期' }, kinds: { person: '群友', fact: '事实', event: '事件' } },
}

function walk(node, out) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
  if (typeof node.type === 'function') { walk(node.type(node.props), out); return }
  // 输入框的 placeholder 也在正文里露个脸，好断言
  if (node.props && typeof node.props.placeholder === 'string') out.push(node.props.placeholder)
  for (const c of node.children) walk(c, out)
}

const tree = registered[0].render()
// 面板接了 initialState 的口子，这里塞假数据进去，让整棵树真的渲染一遍
if (tree && tree.props) tree.props.initialState = state
const out = []
try {
  walk(tree, out)
} catch (error) {
  fail('渲染炸了：' + error.message)
}
const text = out.join(' ')
const has = (s) => text.includes(s)

assert(has('三档记忆'), '渲染出标题')
assert(has('长期') && has('中期') && has('短期'), '三档都在')
assert(has('每轮字数预算'), '参数区在')
assert(has('人设'), '人设区在')
assert(has('长期条目 0'), '列表渲染了第一条')
assert(has('长期条目 9'), '第一页排到第 10 条')
assert(!has('长期条目 10'), '第 11 条不在第一页（10 条一页）')
assert(has('第 1/2 页'), '分页器显示页码：第 1/2 页')
assert(has('下一页') && has('上一页'), '有上一页/下一页按钮')
assert(has('共 13 条'), '顶部显示总条数')
assert(has('搜这一档'), '有搜索框')
assert(has('试一试'), '预览区在')
assert(text.length > 300, '渲染出的文字量合理（' + text.length + ' 字）')

console.log('\n' + (process.exitCode ? '有失败项' : '全过'))

/**
 * dsh-memory-tier —— 三档记忆（长期 / 中期 / 短期）
 *
 * 长期：永久，只放最关键的事实（群友身份、性格、家庭、朋友、生活、愿望、生日、人物关系）
 *       以及「人设 / 回复方式」—— 后者主人可以在设置页直接改。
 * 中期：默认 30 天，容量满了按「重要性 → 新近度 → 命中次数」淘汰。
 * 短期：默认 4 天，记群里每天的有趣事，按时间倒序注入，保证不掉线。
 *
 * 省 token 的做法：
 *   · 检索纯本地（字符二元组 + 标签命中），不调模型、不发一次额外请求；
 *   · 注入走 systemPrompt.context（每轮只追加一条，内容没变就不追加），不会让系统提示词整段缓存失效；
 *   · 注入有硬字数预算（charBudget），超了按档位配额截断。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, truncateSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'memory-tier'
export const inject = ['tools']

// defineTool：优先用宿主那份（参数校验最准），拿不到就退回本地等价实现
let defineTool = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  defineTool = mod.defineTool || null
} catch { /* 宿主树里没有，下面兜底 */ }

if (!defineTool) {
  defineTool = (options) => {
    const check = (schema, where) => {
      if (!schema || typeof schema !== 'object') return
      if (schema.type === 'object' && schema.additionalProperties === undefined) {
        schema.additionalProperties = false
      }
      for (const [, v] of Object.entries(schema.properties || {})) check(v, where)
    }
    if (options.parameters) check(options.parameters, options.name + '.parameters')
    return options
  }
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'memory-tier')
const STORE_PATH = join(DATA_DIR, 'store.json')
const LOG_PATH = join(DATA_DIR, 'mem.log')

const TIERS = ['long', 'mid', 'short']
const TIER_LABEL = { long: '长期', mid: '中期', short: '短期' }
const KIND_LABEL = { person: '群友', fact: '事实', event: '事件', persona: '人设', rule: '规矩' }
const DAY = 86400000

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  shortDays: 4,
  midDays: 30,
  caps: { long: 120, mid: 240, short: 60 },
  inject: { long: 12, mid: 6, short: 6 },
  charBudget: 1600,
  personaText: '',
  autoCapture: true,      // 每条群消息本地抽人名/话题，丢进短期档
  autoCooldownMs: 20000,  // 自动记录的最小间隔，防刷屏
})

// ---------------------------------------------------------------- 存储

function emptyStore() {
  return {
    v: 1,
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    tiers: { long: [], mid: [], short: [] },
    updatedAt: new Date().toISOString(),
  }
}

function normalizeSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {})
  s.enabled = s.enabled !== false
  s.shortDays = clampInt(s.shortDays, 1, 30, 4)
  s.midDays = clampInt(s.midDays, 1, 365, 30)
  s.caps = {
    long: clampInt(s.caps && s.caps.long, 10, 2000, 120),
    mid: clampInt(s.caps && s.caps.mid, 10, 5000, 240),
    short: clampInt(s.caps && s.caps.short, 5, 2000, 60),
  }
  s.inject = {
    long: clampInt(s.inject && s.inject.long, 0, 100, 12),
    mid: clampInt(s.inject && s.inject.mid, 0, 100, 6),
    short: clampInt(s.inject && s.inject.short, 0, 100, 6),
  }
  s.charBudget = clampInt(s.charBudget, 200, 8000, 1600)
  s.personaText = String(s.personaText || '').slice(0, 4000)
  s.autoCapture = s.autoCapture !== false
  s.autoCooldownMs = clampInt(s.autoCooldownMs, 0, 600000, 20000)
  return s
}

function clampInt(v, min, max, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.round(n)))
}

let cache = null

function load() {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    const base = emptyStore()
    base.settings = normalizeSettings(Object.assign({}, base.settings, raw.settings || {}))
    for (const t of TIERS) {
      base.tiers[t] = Array.isArray(raw.tiers && raw.tiers[t]) ? raw.tiers[t].map(normalizeEntry).filter(Boolean) : []
    }
    cache = base
  } catch {
    cache = emptyStore()
  }
  return cache
}

function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null
  const text = String(e.text || '').trim()
  if (!text) return null
  return {
    id: String(e.id || 'm' + randomUUID().slice(0, 8)),
    text: text.slice(0, 600),
    tags: Array.isArray(e.tags) ? e.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : [],
    imp: clampInt(e.imp, 0, 5, 3),
    kind: KIND_LABEL[e.kind] ? e.kind : 'fact',
    pinned: !!e.pinned,
    locked: !!e.locked,   // 锁定的记忆：群友说破天也不改，验证群友说法的底稿
    hits: clampInt(e.hits, 0, 100000, 0),
    at: Number(e.at) || Date.now(),
  }
}

function save() {
  const data = cache || emptyStore()
  data.updatedAt = new Date().toISOString()
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const tmp = STORE_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 1))
    renameSync(tmp, STORE_PATH)
  } catch (error) {
    diag('保存失败：' + (error && error.message))
  }
}

function diag(line) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    // 日志超过 256KB 就砍到最近 8KB —— 之前有过重载残留的实例每 2 秒刷一行，别把盘刷满
    try {
      if (statSync(LOG_PATH).size > 256 * 1024) {
        const tail = readFileSync(LOG_PATH, 'utf8').slice(-8192)
        writeFileSync(LOG_PATH, tail)
      }
    } catch { /* 文件还不存在 */ }
    writeFileSync(LOG_PATH, new Date().toISOString() + '  ' + line + '\n', { flag: 'a' })
  } catch { /* 日志写不了就算了 */ }
}

// ---------------------------------------------------------------- 三档维护

/** 到期清理：中期 / 短期按天数过期 */
function sweep(data, now = Date.now()) {
  const s = data.settings
  const before = { mid: data.tiers.mid.length, short: data.tiers.short.length }
  data.tiers.mid = data.tiers.mid.filter((e) => now - e.at < s.midDays * DAY)
  data.tiers.short = data.tiers.short.filter((e) => now - e.at < s.shortDays * DAY)
  return { removed: { mid: before.mid - data.tiers.mid.length, short: before.short - data.tiers.short.length } }
}

/** 淘汰分：重要性为主，新近度和命中次数为辅 */
function evictScore(e, now) {
  const age = Math.max(0, now - e.at) / DAY
  const recency = 3 / (1 + age / 10)
  return e.imp * 2 + recency + Math.min(3, e.hits * 0.3)
}

/** 容量满了：保住 pinned 和最高分的，淘汰最低分的 */
function enforceCap(data, tier, now = Date.now()) {
  const cap = data.settings.caps[tier]
  const list = data.tiers[tier]
  if (list.length <= cap) return 0
  const sorted = list.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return evictScore(b, now) - evictScore(a, now)
  })
  const keep = new Set(sorted.slice(0, cap).map((e) => e.id))
  const removed = list.length - keep.size
  data.tiers[tier] = list.filter((e) => keep.has(e.id))
  return removed
}

function addEntry(data, patch) {
  const tier = TIERS.includes(patch.tier) ? patch.tier : 'mid'
  const entry = normalizeEntry(Object.assign({}, patch, { id: patch.id || undefined, at: patch.at || Date.now() }))
  if (!entry) return { ok: false, message: '内容不能为空' }

  // 去重：几乎一样的内容只更新那条（强化 hit，不动时间）
  const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?：:；;“”"'（）()]/g, '').toLowerCase()
  const nt = norm(entry.text)
  const dup = data.tiers[tier].find((e) => {
    const a = norm(e.text)
    return a && (a === nt || (a.length > 8 && nt.length > 8 && (a.includes(nt) || nt.includes(a))))
  })
  if (dup) {
    dup.imp = Math.max(dup.imp, entry.imp)
    dup.tags = Array.from(new Set(dup.tags.concat(entry.tags))).slice(0, 8)
    dup.at = Math.max(dup.at, entry.at)
    if (entry.pinned) dup.pinned = true
    return { ok: true, entry: dup, action: 'updated', tier }
  }

  data.tiers[tier].push(entry)
  const evicted = enforceCap(data, tier)
  return { ok: true, entry, action: 'added', tier, evicted }
}

// ---------------------------------------------------------------- 检索

/** 中文/英文都能用的轻量切分：字符二元组 + 英文单词 + 标签 */
function tokensOf(text) {
  const out = new Set()
  const s = String(text || '').toLowerCase()
  const words = s.match(/[a-z0-9_]{2,}/g) || []
  for (const w of words) out.add(w)
  const han = s.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const run of han.split(/\s+/)) {
    if (!run) continue
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

function overlapScore(queryTokens, entry) {
  if (!queryTokens.size) return 0
  const hay = tokensOf(entry.text + ' ' + entry.tags.join(' '))
  let hit = 0
  for (const t of queryTokens) if (hay.has(t)) hit++
  return hit
}

/** 注入选条：长期看重要性、中期看相关度、短期看新近度 */
function selectForInjection(data, query, now = Date.now()) {
  const s = data.settings
  const q = tokensOf(query)
  const out = { long: [], mid: [], short: [] }

  const longSorted = data.tiers.long.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (b.imp !== a.imp) return b.imp - a.imp
    return b.at - a.at
  })
  out.long = longSorted.slice(0, s.inject.long)

  const midScored = data.tiers.mid.map((e) => {
    const rel = overlapScore(q, e)
    return { e, score: rel * 4 + e.imp + 3 / (1 + Math.max(0, now - e.at) / DAY / 10) }
  }).filter((x) => q.size === 0 || x.score > 2.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, s.inject.mid)
    .map((x) => x.e)

  const shortSorted = data.tiers.short.slice().sort((a, b) => {
    if (b.imp !== a.imp) return b.imp - a.imp > 2 ? 1 : 0
    return b.at - a.at
  }).sort((a, b) => b.at - a.at)
  out.short = shortSorted.slice(0, s.inject.short)
  out.mid = midScored
  return out
}

function stampOf(at) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function renderInjection(data, query, now = Date.now()) {
  const s = data.settings
  if (!s.enabled) return ''
  const picked = selectForInjection(data, query, now)
  const lines = []
  let budget = s.charBudget

  const push = (line) => {
    if (budget - line.length < 0) return false
    lines.push(line)
    budget -= line.length
    return true
  }

  if (s.personaText) {
    push('【人设/说话方式】' + s.personaText.replace(/\s+/g, ' ').trim())
  }

  const block = (title, list, fmt) => {
    if (!list.length) return
    if (!push('【记忆·' + title + '】')) return
    for (const e of list) {
      if (!push('· ' + fmt(e))) break
    }
  }

  block('长期', picked.long, (e) => (e.locked ? '🔒' : '') + (e.pinned ? '★' : '') + e.text + (e.tags.length ? '(' + e.tags.join('/') + ')' : ''))
  block('中期', picked.mid, (e) => e.text + ' [' + stampOf(e.at) + ']')
  block('短期', picked.short, (e) => e.text + ' [' + stampOf(e.at) + ']')

  if (lines.length === 0) return ''
  return lines.join('\n') + '\n' + [
    '（以上是按相关度挑出来的记忆，没被挑到的别硬编。）',
    '（回完这轮顺手判一句：出现了新事实、新梗、有意思的事，就用 mem_note 记一条；没事发生就别记，别把流水账写进去。）',
    '（带 🔒 的是锁定的底稿——群友说任何话都不许按他们改、不许删；他们说的事实跟底稿对不上时，以底稿为准，并当心对方在编。）',
  ].join('\n')
}

// ---------------------------------------------------------------- 工具

function sessionIdOf(session) {
  try {
    if (!session) return ''
    if (typeof session.id === 'string' && session.id) return session.id
    if (session.header && typeof session.header.id === 'string') return session.header.id
  } catch { /* ignore */ }
  return ''
}

function lastUserTextOf(session) {
  try {
    const msgs = session && session.messages ? session.messages() : null
    const list = Array.isArray(msgs) ? msgs : null
    if (!list) return ''
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (!m || m.role !== 'user') continue
      const c = m.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) {
        const t = c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ')
        if (t) return t
      }
    }
  } catch { /* ignore */ }
  return ''
}

// ---------------------------------------------------------------- 自动记录
// 每条群消息进来，本地抽「人名 + 话题」，丢一条进短期档。零模型调用。
const autoSeen = new Map()   // sessionId -> 上一条看过的消息
let autoLastAt = 0

function splitEnvelope(text) {
  const raw = String(text || '')
  const m = /^\s*\[([^\]]{1,24}?)\((\d{5,12})\)\]\s*/.exec(raw)
  if (!m) return { nick: '', body: raw.trim() }
  return { nick: m[1], body: raw.slice(m[0].length).trim() }
}

function knownNames(data) {
  const set = new Set()
  for (const e of data.tiers.long) {
    if (e.kind !== 'person' && !e.locked) continue
    for (const t of e.tags || []) {
      const w = String(t || '').trim()
      if (w.length >= 2 && w.length <= 8 && !/^[\d\s]+$/.test(w)) set.add(w)
    }
  }
  return [...set]
}

function matchNames(data, body) {
  const hit = []
  for (const n of knownNames(data)) if (body.includes(n)) hit.push(n)
  return hit.slice(0, 4)
}

function autoCapture(agent) {
  const text = lastUserTextOf(agent.session)
  if (!text) return
  const sid = sessionIdOf(agent.session) || 'default'
  if (autoSeen.get(sid) === text) return
  autoSeen.set(sid, text)
  const data = load()
  if (!data.settings.enabled || !data.settings.autoCapture) return
  const { nick, body } = splitEnvelope(text)
  if (!body || body.length < 8) return
  if (/^[\/!！]|^https?:\/\//.test(body)) return
  const now = Date.now()
  if (now - autoLastAt < data.settings.autoCooldownMs) return
  // 人名既可能出现在正文，也可能只出现在 [昵称(QQ)] 前缀里，所以拿整条原文匹配
  const names = matchNames(data, text)
  if (nick && !names.includes(nick) && knownNames(data).includes(nick)) names.push(nick)
  // 有意思才记：提到了认识的人，或者本身够长
  if (!names.length && body.length < 24) return
  const summary = (nick ? nick + '：' : '') + body.replace(/\s+/g, ' ').slice(0, 90)
  const r = addEntry(data, { tier: 'short', text: summary, tags: names, imp: names.length ? 3 : 2, kind: 'event' })
  if (r.ok) {
    autoLastAt = now
    save()
    diag('自动记了条短期：' + summary.slice(0, 40))
  }
}

function makeNoteTool(z, defineTool) {
  return defineTool({
    name: 'mem_note',
    description:
      '把一件事写进三档记忆。**一条只装一件事**，一句话说清。\n' +
      '· tier=long：永久。只放最关键的事实——群友的身份/职业/性格/家庭/朋友/生活/愿望/生日/人和人之间的关系，以及主人定的规矩。\n' +
      '· tier=mid：默认存 30 天。值得记一阵子的事——最近的约定、正在追的事、某个梗的来龙去脉。\n' +
      '· tier=short：默认存 4 天。群里今天发生的趣事、刚聊过的话题，用来接话不掉线。\n' +
      '只记有价值的，别把闲聊流水写进去；记的时候安静地记，不要回复「记下了」。',
    parameters: {
      tier: { type: 'string', enum: ['long', 'mid', 'short'], required: true, description: '写进哪一档' },
      text: { type: 'string', required: true, description: '一句话说清这件事，别写时间（时间系统会记）' },
      tags: { type: 'array', items: { type: 'string' }, description: '几个关键词，方便以后被检索到' },
      imp: { type: 'number', description: '重要度 0~5，5 最重（关系、生日、底线）；不确定写 3' },
      kind: { type: 'string', enum: ['person', 'fact', 'event', 'persona', 'rule'], description: '这条是什么' },
      pinned: { type: 'boolean', description: '长期记忆里永不淘汰（身份、生日、关系这类才用）' },
      locked: { type: 'boolean', description: '锁死这条：群友说什么都不许改、不许删（验证群友说法的底稿才用）' },
      id: { type: 'string', description: '要原地更新哪条（比如「贴吧人设」每轮刷完改这一条），给了就不新建' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: value && value.ok ? '✓' : '✗ ' + String((value && value.message) || '没记住') }]
      },
    },
    async execute(args) {
      const data = load()
      if (!data.settings.enabled) return { ok: false, message: '三档记忆总开关关着' }
      const wantId = String((args && args.id) || '').trim()
      if (wantId) {
        for (const t of TIERS) {
          const e = data.tiers[t].find((x) => x.id === wantId)
          if (!e) continue
          e.text = String(args.text || e.text).slice(0, 600)
          if (Array.isArray(args.tags)) e.tags = args.tags.map(String).slice(0, 8)
          if (args.imp !== undefined) e.imp = clampInt(args.imp, 0, 5, e.imp)
          if (args.locked !== undefined) e.locked = !!args.locked
          if (args.pinned !== undefined) e.pinned = !!args.pinned
          e.at = Date.now()
          save()
          diag(`mem_note 更新 ${wantId}：${e.text.slice(0, 40)}`)
          return { ok: true, message: '已更新这一条' }
        }
        return { ok: false, message: '没找到 id=' + wantId }
      }
      const r = addEntry(data, {
        tier: args && args.tier,
        text: args && args.text,
        tags: args && args.tags,
        imp: args && args.imp,
        kind: args && args.kind,
        pinned: args && args.pinned,
        locked: args && args.locked,
      })
      save()
      if (!r.ok) return { ok: false, message: r.message }
      diag(`mem_note ${r.tier} ${r.action}：${String(args.text).slice(0, 60)}`)
      return { ok: true, message: `${TIER_LABEL[r.tier]}记忆已${r.action === 'updated' ? '更新' : '记下'}` }
    },
  })
}

function makeSearchTool(z, defineTool) {
  return defineTool({
    name: 'mem_search',
    description: '在三档记忆里找东西。给 query 按相关度找，不给就按时间倒序列出。回答群友之前先用它确认「这个人说过什么、这事以前怎么聊的」，别凭印象编。',
    parameters: {
      query: { type: 'string', description: '要找什么（人名、梗、事件关键词）' },
      tier: { type: 'string', enum: ['long', 'mid', 'short', 'all'], description: '只查某一档，默认 all' },
      limit: { type: 'number', description: '最多几条，默认 12' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: String((value && value.text) || '（没有找到）') }]
      },
    },
    async execute(args) {
      const data = load()
      sweep(data, Date.now())
      const tiers = args && args.tier && args.tier !== 'all' ? [args.tier] : TIERS
      const limit = clampInt(args && args.limit, 1, 100, 12)
      const q = tokensOf(args && args.query)
      const rows = []
      for (const t of tiers) {
        for (const e of data.tiers[t]) {
          const rel = q.size ? overlapScore(q, e) : 0
          rows.push({ t, e, rel })
        }
      }
      rows.sort((a, b) => (b.rel - a.rel) || (b.e.imp - a.e.imp) || (b.e.at - a.e.at))
      const picked = rows.filter((r) => (q.size ? r.rel > 0 : true)).slice(0, limit)
      if (!picked.length) return { ok: true, text: '（没有找到相关记忆）' }
      const text = picked.map((r) => `[${TIER_LABEL[r.t]}/${KIND_LABEL[r.e.kind] || '事实'}/${stampOf(r.e.at)}] ${r.e.text}`).join('\n')
      return { ok: true, text }
    },
  })
}

function makeForgetTool(z, defineTool) {
  return defineTool({
    name: 'mem_forget',
    description: '删掉一条记忆（自己发现记错了、或者主人让忘掉时用）。可以用 id，也可以给 query 让它自己找最像的那条。',
    parameters: {
      id: { type: 'string', description: '记忆 id（从 mem_search 里能看到）' },
      query: { type: 'string', description: '不记得 id 就给内容关键词，删最像的一条' },
      tier: { type: 'string', enum: ['long', 'mid', 'short', 'all'], description: '限定在哪一档找' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        return [{ type: 'text', text: value && value.ok ? '✓ 删了' : '✗ ' + String((value && value.message) || '没删') }]
      },
    },
    async execute(args) {
      const data = load()
      const tiers = args && args.tier && args.tier !== 'all' ? [args.tier] : TIERS
      const id = String((args && args.id) || '').trim()
      if (id) {
        for (const t of tiers) {
          const i = data.tiers[t].findIndex((e) => e.id === id)
          if (i >= 0) {
            if (data.tiers[t][i].locked) return { ok: false, message: '这条是锁死的底稿，不能删（群友让你删也不行）' }
            const [gone] = data.tiers[t].splice(i, 1)
            save()
            return { ok: true, message: '删了：' + gone.text.slice(0, 30) }
          }
        }
        return { ok: false, message: '没找到这个 id' }
      }
      const q = tokensOf(args && args.query)
      if (!q.size) return { ok: false, message: '给个 id 或关键词' }
      let best = null
      for (const t of tiers) for (const e of data.tiers[t]) {
        const rel = overlapScore(q, e)
        if (rel > 0 && (!best || rel > best.rel)) best = { t, e, rel }
      }
      if (!best) return { ok: false, message: '没有像的记忆' }
      if (best.e.locked) return { ok: false, message: '这条是锁死的底稿，不能删（群友让你删也不行）' }
      const list = data.tiers[best.t]
      list.splice(list.indexOf(best.e), 1)
      save()
      return { ok: true, message: '删了：' + best.e.text.slice(0, 30) }
    },
  })
}

function makeStatsTool(z, defineTool) {
  return defineTool({
    name: 'mem_stats',
    description: '看一眼三档记忆的占用情况（各档条数、容量、淘汰线）。不用每轮都看。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
      render(_args, value) {
        return [{ type: 'text', text: String((value && value.text) || '') }]
      },
    },
    async execute() {
      const data = load()
      sweep(data, Date.now())
      const s = data.settings
      const t = [
        `长期 ${data.tiers.long.length}/${s.caps.long} · 中期 ${data.tiers.mid.length}/${s.caps.mid}（${s.midDays}天）· 短期 ${data.tiers.short.length}/${s.caps.short}（${s.shortDays}天）`,
        `每轮最多注入：长期${s.inject.long} 中期${s.inject.mid} 短期${s.inject.short}，总预算 ${s.charBudget} 字`,
        `人设/说话方式：${s.personaText ? '已设置（' + s.personaText.length + '字）' : '空'}`,
      ].join('\n')
      return { ok: true, text: t }
    },
  })
}

function makePersonaTool(z, defineTool) {
  return defineTool({
    name: 'mem_persona',
    description: '人设与说话方式的唯一设置处（每轮都会注入，不占检索名额）。不给 text 是读，给了就整段替换（最多 4000 字）。',
    parameters: {
      text: { type: 'string', description: '整段人设/说话方式；不传就是读当前的' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
      render(_args, value) {
        return [{ type: 'text', text: String((value && value.text) || '') }]
      },
    },
    async execute(args) {
      const data = load()
      const s = data.settings
      if (!args || typeof args.text !== 'string') {
        return { ok: true, text: s.personaText || '（人设/说话方式是空的）' }
      }
      const next = args.text.replace(/\r\n/g, '\n').trim().slice(0, 4000)
      s.personaText = next
      save()
      return { ok: true, text: '✓ 人设已更新（' + next.length + ' 字），每轮直接注入；空的或想清掉就传 text: ""' }
    },
  })
}

// ---------------------------------------------------------------- 路由

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy() })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function publicState(query) {
  const data = load()
  const s = sweep(data, Date.now())
  const injected = renderInjection(data, String(query || ''), Date.now())
  return {
    ok: true,
    settings: data.settings,
    defaults: DEFAULT_SETTINGS,
    tiers: {
      long: data.tiers.long.slice().sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.at - a.at)),
      mid: data.tiers.mid.slice().sort((a, b) => b.at - a.at),
      short: data.tiers.short.slice().sort((a, b) => b.at - a.at),
    },
    swept: s.removed,
    injected,
    labels: { tiers: TIER_LABEL, kinds: KIND_LABEL },
  }
}

// ---------------------------------------------------------------- 插件本体

export function apply(ctx, config = {}) {
  // 首次启动把配置文件里的 settings 灌进去（只灌一次，别覆盖用户在界面上的修改）
  const data0 = load()
  if (config && Object.keys(config).length && !existsSync(STORE_PATH)) {
    data0.settings = normalizeSettings(Object.assign({}, data0.settings, config))
    save()
  }

  // ---- 工具 ----
  const toolsOff = []
  try {
    if (ctx.tools && typeof ctx.tools.register === 'function') {
      for (const make of [makeNoteTool, makeSearchTool, makeForgetTool, makeStatsTool, makePersonaTool]) {
        toolsOff.push(ctx.tools.register(make(null, defineTool)))
      }
      diag('工具挂上了：mem_note / mem_search / mem_forget / mem_stats / mem_persona')
    }
  } catch (error) {
    diag('工具挂载失败：' + (error && error.message))
  }

  // ---- 每轮注入 ----
  const mounted = new Map() // sid -> off()
  let lastText = ''

  function mountFor(agent) {
    const sid = sessionIdOf(agent && agent.session)
    if (!sid) return
    if (mounted.has(sid)) return
    try {
      const off = agent.ctx.systemPrompt.context({
        name: 'memory-tier',
        order: 910,
        interpolate: false,
        text: () => {
          try {
            const data = load()
            if (!data.settings.enabled) return ''
            const query = lastText || lastUserTextOf(agent.session)
            const text = renderInjection(data, query, Date.now())
            return text
          } catch (error) {
            diag('注入失败：' + (error && error.message))
            return ''
          }
        },
      })
      mounted.set(sid, typeof off === 'function' ? off : (off && off.off) || (() => {}))
      diag('注入挂上：' + sid)
    } catch (error) {
      const msg = String((error && error.message) || '')
      if (msg.includes('already registered')) {
        // 热重载时旧实例的注册还在：它每次都会重新读 store，功能上没问题，别刷日志
        mounted.set(sid, () => {})
      } else {
        diag('注入挂不上：' + msg)
      }
    }
  }

  function unmountAll() {
    for (const [sid, off] of mounted) {
      try { off() } catch { /* ignore */ }
      mounted.delete(sid)
    }
  }

  let timer = null
  // agents 是可选服务：没有它（比如 headless）插件照常加载，只是不注入
  ctx.inject(['agents'], (c) => {
   try {
    let lastErr = ''
    const tick = () => {
      try {
        const list = (c.agents && typeof c.agents.list === 'function') ? c.agents.list() : []
        for (const agent of list) {
          autoCapture(agent)
          mountFor(agent)
        }
      } catch (error) {
        const msg = String(error && error.message)
        if (msg.includes('inactive context')) return
        if (msg !== lastErr) { lastErr = msg; diag('tick 出错：' + msg) }
      }
    }
    tick()
    timer = setInterval(tick, 2000)
    if (timer.unref) timer.unref()
    // 卸载时一定要清掉定时器 —— 否则重载后旧实例会一直写日志
    c.effect(() => () => { try { if (timer) clearInterval(timer) } catch { /* ignore */ } })
   } catch (error) {
    diag('定时器挂不上：' + (error && error.message))
   }
  })

  ctx.on('dispose', () => {
    try { if (timer) clearInterval(timer) } catch { /* ignore */ }
    unmountAll()
    for (const off of toolsOff) { try { off() } catch { /* ignore */ } }
  })

  // ---- 记住「这一轮用户说了什么」，给注入做检索 ----
  try {
    ctx.on('agent/inbox/inserted', (payload) => {
      try {
        const text = JSON.stringify(payload || '')
        const m = text.match(/"text":"((?:[^"\\]|\\.)*)"/)
        if (m) lastText = JSON.parse('"' + m[1] + '"')
      } catch { /* ignore */ }
    })
  } catch { /* ignore */ }

  // ---- 设置页路由（webServer 也是可选服务）----
  ctx.inject(['webServer'], (c) => {
  try {
    const route = (path, handler) => {
      if (!c.webServer || typeof c.webServer.register !== 'function') return
      c.effect(() => c.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try { await handler(req, res) } catch (error) {
            try { sendJson(res, 500, { ok: false, error: String(error && error.message) }) } catch { /* ignore */ }
          }
        },
      }))
    }

    route('/api/memory-tier/state', async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      sendJson(res, 200, publicState(u.searchParams.get('q') || ''))
    })

    route('/api/memory-tier/settings', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      data.settings = normalizeSettings(Object.assign({}, data.settings, body || {}))
      save()
      sendJson(res, 200, { ok: true, settings: data.settings })
    })

    route('/api/memory-tier/entry', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      const tier = TIERS.includes(body.tier) ? body.tier : 'mid'
      if (body.id) {
        const e = data.tiers[tier].find((x) => x.id === body.id)
        if (!e) return sendJson(res, 404, { ok: false, error: '没有这条' })
        if (body.text !== undefined) e.text = String(body.text).slice(0, 600)
        if (body.imp !== undefined) e.imp = clampInt(body.imp, 0, 5, e.imp)
        if (body.pinned !== undefined) e.pinned = !!body.pinned
        if (Array.isArray(body.tags)) e.tags = body.tags.map(String).filter(Boolean).slice(0, 8)
        save()
        return sendJson(res, 200, { ok: true, entry: e })
      }
      const r = addEntry(data, body)
      save()
      sendJson(res, r.ok ? 200 : 400, r)
    })

    route('/api/memory-tier/delete', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      const tier = TIERS.includes(body.tier) ? body.tier : null
      const locked = TIERS.flatMap((t) => data.tiers[t]).some((e) => e.id === body.id && e.locked)
      if (locked) return sendJson(res, 403, { ok: false, removed: 0, message: '锁定的底稿不能删' })
      let removed = 0
      for (const t of tier ? [tier] : TIERS) {
        const before = data.tiers[t].length
        data.tiers[t] = data.tiers[t].filter((e) => e.id !== body.id)
        removed += before - data.tiers[t].length
      }
      save()
      sendJson(res, 200, { ok: removed > 0, removed })
    })

    route('/api/memory-tier/clear', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      const tier = TIERS.includes(body.tier) ? body.tier : null
      if (tier) data.tiers[tier] = []
      else for (const t of TIERS) data.tiers[t] = []
      save()
      sendJson(res, 200, { ok: true })
    })

    route('/api/memory-tier/preview', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      const text = renderInjection(data, String((body && body.q) || ''), Date.now())
      sendJson(res, 200, { ok: true, text, chars: text.length })
    })
  } catch (error) {
    diag('路由挂载失败：' + (error && error.message))
  }
  })
}

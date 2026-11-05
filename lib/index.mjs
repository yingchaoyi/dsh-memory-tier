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
  autoCooldownMs: 3000,   // 自动记录的最小间隔，防刷屏
  // 贴吧语料（bar-styles.json）参考：默认关，只对白名单里的 QQ 群生效
  styleRef: {
    enabled: false,
    groups: [],   // QQ 群号白名单
    perBar: 2,    // 每个吧取几条
    bars: 4,      // 一次最多拼几个吧
    budget: 600,  // 这段最多占多少字
  },
  stylePath: '',  // 留空 = ~/.dsh/tieba-duty/bar-styles.json
})

// ---------------------------------------------------------------- 存储

function emptyTiers() {
  return { long: [], mid: [], short: [] }
}

function emptyStore() {
  return {
    v: 2,
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    // 按群分库：{ "<群号或 default>": { id, name, tiers, updatedAt } }
    groups: {},
    updatedAt: new Date().toISOString(),
  }
}

/** 群库：gid 为空一律落到 default（网页/无群会话用） */
function groupKey(gid) {
  return String(gid || '').trim() || 'default'
}

function groupStore(data, gid, create = true) {
  const key = groupKey(gid)
  const hit = data.groups[key]
  if (hit) {
    if (!hit.tiers) hit.tiers = emptyTiers()
    return hit
  }
  if (!create) return null
  const next = { id: key, name: '', tiers: emptyTiers(), updatedAt: new Date().toISOString() }
  data.groups[key] = next
  return next
}

/** 取某个群的三档列表；只读场景不要建空库 */
function tiersOf(data, gid, create = true) {
  const g = groupStore(data, gid, create)
  return g ? g.tiers : emptyTiers()
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
  s.autoCooldownMs = clampInt(s.autoCooldownMs, 0, 600000, 3000)
  const sr = s.styleRef || {}
  const groups = Array.isArray(sr.groups) ? sr.groups : String(sr.groups || '').split(/[\s,，、]+/)
  s.styleRef = {
    enabled: sr.enabled === true,
    groups: [...new Set(groups.map((g) => String(g || '').trim()).filter((g) => /^\d{5,12}$/.test(g)))].slice(0, 50),
    perBar: clampInt(sr.perBar, 1, 5, 2),
    bars: clampInt(sr.bars, 1, 8, 4),
    budget: clampInt(sr.budget, 100, 2000, 600),
  }
  s.stylePath = String(s.stylePath || '').trim()
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
    const rawGroups = raw.groups && typeof raw.groups === 'object' ? raw.groups : null
    if (rawGroups) {
      for (const [k, g] of Object.entries(rawGroups)) {
        const tiers = emptyTiers()
        for (const t of TIERS) {
          tiers[t] = Array.isArray(g && g.tiers && g.tiers[t]) ? g.tiers[t].map(normalizeEntry).filter(Boolean) : []
        }
        base.groups[k] = { id: k, name: String((g && g.name) || ''), tiers, updatedAt: String((g && g.updatedAt) || '') }
      }
    } else {
      // 老版本只有一份库：整份归到「主群」，别拆散也别复制
      const gid = primaryGroupId() || 'default'
      const tiers = emptyTiers()
      for (const t of TIERS) {
        tiers[t] = Array.isArray(raw.tiers && raw.tiers[t]) ? raw.tiers[t].map(normalizeEntry).filter(Boolean) : []
      }
      base.groups[gid] = { id: gid, name: '', tiers, updatedAt: new Date().toISOString() }
      base.migratedFrom = 'single'
    }
    cache = base
    if (base.migratedFrom) {
      diag(`按群分库：老记忆归到群 ${Object.keys(base.groups)[0]}`)
      save()
    }
  } catch {
    cache = emptyStore()
  }
  return cache
}

/** 主群：ingress 里最近活跃的那个 QQ 群，找不到就 default */
function primaryGroupId() {
  try {
    const map = JSON.parse(readFileSync(INGRESS_SESSIONS, 'utf8'))
    let best = ''
    let bestAt = -1
    for (const [umo, v] of Object.entries(map || {})) {
      const m = /:(\d{5,12})$/.exec(String(umo))
      if (!m) continue
      const at = Number((v && v.updatedAt) || 0)
      if (at > bestAt) { bestAt = at; best = m[1] }
    }
    return best
  } catch {
    return ''
  }
}

/** 所有出现过的群：库里的 + ingress 映射里的 */
function knownGroups(data) {
  const ids = new Set(Object.keys(data.groups || {}))
  try {
    const map = JSON.parse(readFileSync(INGRESS_SESSIONS, 'utf8'))
    for (const umo of Object.keys(map || {})) {
      const m = /:(\d{5,12})$/.exec(String(umo))
      if (m) ids.add(m[1])
    }
  } catch { /* ignore */ }
  return [...ids].map((id) => {
    const g = data.groups[id]
    return {
      id,
      name: (g && g.name) || (id === 'default' ? '网页/私聊' : ''),
      counts: {
        long: g ? g.tiers.long.length : 0,
        mid: g ? g.tiers.mid.length : 0,
        short: g ? g.tiers.short.length : 0,
      },
    }
  }).sort((a, b) => {
    if (a.id === 'default') return 1
    if (b.id === 'default') return -1
    const na = a.counts.long + a.counts.mid + a.counts.short
    const nb = b.counts.long + b.counts.mid + b.counts.short
    return nb - na
  })
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
function sweep(data, gid, now = Date.now()) {
  const s = data.settings
  const tiers = tiersOf(data, gid)
  const before = { mid: tiers.mid.length, short: tiers.short.length }
  tiers.mid = tiers.mid.filter((e) => now - e.at < s.midDays * DAY)
  tiers.short = tiers.short.filter((e) => now - e.at < s.shortDays * DAY)
  return { removed: { mid: before.mid - tiers.mid.length, short: before.short - tiers.short.length } }
}

/** 淘汰分：重要性为主，新近度和命中次数为辅 */
function evictScore(e, now) {
  const age = Math.max(0, now - e.at) / DAY
  const recency = 3 / (1 + age / 10)
  return e.imp * 2 + recency + Math.min(3, e.hits * 0.3)
}

/** 容量满了：保住 pinned 和最高分的，淘汰最低分的 */
function enforceCap(data, gid, tier, now = Date.now()) {
  const cap = data.settings.caps[tier]
  const tiers = tiersOf(data, gid)
  const list = tiers[tier]
  if (list.length <= cap) return 0
  const sorted = list.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return evictScore(b, now) - evictScore(a, now)
  })
  const keep = new Set(sorted.slice(0, cap).map((e) => e.id))
  const removed = list.length - keep.size
  tiers[tier] = list.filter((e) => keep.has(e.id))
  return removed
}

function addEntry(data, gid, patch) {
  const tiers = tiersOf(data, gid)
  const tier = TIERS.includes(patch.tier) ? patch.tier : 'mid'
  const entry = normalizeEntry(Object.assign({}, patch, { id: patch.id || undefined, at: patch.at || Date.now() }))
  if (!entry) return { ok: false, message: '内容不能为空' }

  // 去重：几乎一样的内容只更新那条（强化 hit，不动时间）
  const norm = (s) => String(s || '').replace(/[\s，。、！？,.!?：:；;“”"'（）()]/g, '').toLowerCase()
  const nt = norm(entry.text)
  const dup = tiers[tier].find((e) => {
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

  tiers[tier].push(entry)
  const evicted = enforceCap(data, gid, tier)
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
function selectForInjection(data, gid, query, now = Date.now()) {
  const s = data.settings
  const tiers = tiersOf(data, gid, false)
  const q = tokensOf(query)
  const out = { long: [], mid: [], short: [] }

  const longSorted = tiers.long.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (b.imp !== a.imp) return b.imp - a.imp
    return b.at - a.at
  })
  out.long = longSorted.slice(0, s.inject.long)

  const midScored = tiers.mid.map((e) => {
    const rel = overlapScore(q, e)
    return { e, score: rel * 4 + e.imp + 3 / (1 + Math.max(0, now - e.at) / DAY / 10) }
  }).filter((x) => q.size === 0 || x.score > 2.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, s.inject.mid)
    .map((x) => x.e)

  const shortSorted = tiers.short.slice().sort((a, b) => {
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

/** 条目里的 QQ 号（5~12 位数字），拿它当主键 */
function qqOfEntry(entry) {
  const m = String(entry.text || '').match(/(\d{5,12})/)
  return m ? m[1] : ''
}

/** 条目开头的称呼，用来给人物卡起标题 */
function nameOfEntry(entry) {
  const t = String(entry.text || '').replace(/^[\s★🔒·]+/, '')
  const m = t.match(/^([\u4e00-\u9fa5A-Za-z0-9_.·\-]{1,12})/)
  return m ? m[1] : '某人'
}

/** 去掉句子里重复的 QQ 和开头称呼，人物卡里不用再念一遍 */
function factOfEntry(entry, qq) {
  let t = String(entry.text || '')
  if (qq) t = t.split(qq).join('')
  t = t
    .replace(/QQ\s*号?\s*[：:]?\s*[（(]?\s*[）)]?/gi, '')  // 去掉 QQ 标签
    .replace(/[，,、]\s*(?=[，,、])/g, '')                     // 连着两个逗号留一个
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s★🔒·、，,。：:]+/, '')
    .replace(/[、，,。：:]+$/, '')
  return t.trim()
}

/**
 * 以 QQ 为主键聚合：同一个号的多条并成一张卡，名字相同但号不同的分开算。
 * 返回 { cards: [{qq,name,facts:[]}], used:Set }
 */
function buildPersonCards(list, perCard = 6) {
  const map = new Map()
  const used = new Set()
  for (const e of list) {
    const qq = qqOfEntry(e)
    if (!qq) continue
    if (!map.has(qq)) map.set(qq, { qq, name: nameOfEntry(e), facts: [], n: 0, marks: '' })
    const card = map.get(qq)
    if (e.locked && !card.marks.includes('🔒')) card.marks += '🔒'
    if (e.pinned && !card.marks.includes('★')) card.marks += '★'
    const fact = factOfEntry(e, qq)
    if (fact && !card.facts.includes(fact)) card.facts.push(fact)
    card.n++
    used.add(e)
  }
  const cards = [...map.values()]
    .sort((a, b) => b.n - a.n)
    .map((c) => ({ ...c, facts: c.facts.slice(0, perCard) }))
  return { cards, used }
}

// ---------------------------------------------------------------- 贴吧语料参考

const INGRESS_SESSIONS = join(DSH_HOME, 'dsh-astrbot-ingress', 'sessions.json')
let styleCache = { at: 0, path: '', bars: null }

function groupOfSession(sid) {
  if (!sid) return ''
  try {
    const map = JSON.parse(readFileSync(INGRESS_SESSIONS, 'utf8'))
    for (const [umo, v] of Object.entries(map || {})) {
      if (!v || v.sessionId !== sid) continue
      const m = /:(\d{5,12})$/.exec(String(umo)) || /:(?:Group|group)[A-Za-z]*:(\d{5,12})$/.exec(String(umo))
      return m ? m[1] : ''
    }
  } catch {}
  return ''
}

function loadBarStyles(path) {
  const file = path || join(DSH_HOME, 'tieba-duty', 'bar-styles.json')
  const now = Date.now()
  if (styleCache.bars && styleCache.path === file && now - styleCache.at < 60000) return styleCache.bars
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    styleCache = { at: now, path: file, bars: raw && typeof raw === 'object' ? raw : null }
    return styleCache.bars
  } catch {
    styleCache = { at: now, path: file, bars: null }
    return null
  }
}

function pickBarLines(styles, opts) {
  const names = Object.keys(styles || {})
  if (!names.length) return []
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[names[i], names[j]] = [names[j], names[i]]
  }
  const out = []
  let budget = opts.budget
  for (const name of names.slice(0, opts.bars)) {
    const bar = styles[name]
    const samples = Array.isArray(bar && bar.samples) ? bar.samples.filter((x) => typeof x === 'string' && x.trim()) : []
    if (!samples.length) continue
    let taken = 0
    for (const raw of samples) {
      if (taken >= opts.perBar) break
      const line = '· ' + name + '：' + raw.trim().replace(/\s+/g, ' ')
      if (budget - line.length < 0) break
      budget -= line.length
      out.push(line)
      taken += 1
    }
  }
  return out
}

function renderInjection(data, gid, query, now = Date.now(), styleLines = null) {
  const s = data.settings
  if (!s.enabled) return ''
  const picked = selectForInjection(data, gid, query, now)
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

  if (styleLines && styleLines.length) {
    if (push('【贴吧语料·照着这个口气说，别照抄原句】')) {
      for (const line of styleLines) if (!push(line)) break
    }
  }

  const block = (title, list, fmt) => {
    if (!list.length) return
    if (!push('【记忆·' + title + '】')) return
    for (const e of list) {
      if (!push('· ' + fmt(e))) break
    }
  }

  // 先按 QQ 聚成人物卡：同一个号的多条并成一行，免得人和事串到别人头上
  const pickedAll = [...picked.long, ...picked.mid, ...picked.short]
  const { cards, used } = buildPersonCards(pickedAll)
  if (cards.length) {
    if (push('【人物卡·以 QQ 为准，名字对不上就按号认人】')) {
      for (const c of cards) {
        if (!push('· ' + c.marks + c.name + '(' + c.qq + ')：' + c.facts.join('；'))) break
      }
    }
  }

  block('长期', picked.long.filter((e) => !used.has(e)), (e) => (e.locked ? '🔒' : '') + (e.pinned ? '★' : '') + e.text + (e.tags.length ? '(' + e.tags.join('/') + ')' : ''))
  block('中期', picked.mid.filter((e) => !used.has(e)), (e) => e.text + ' [' + stampOf(e.at) + ']')
  block('短期', picked.short.filter((e) => !used.has(e)), (e) => e.text + ' [' + stampOf(e.at) + ']')

  if (lines.length === 0) return ''
  return lines.join('\n') + '\n' + [
    '（以上是按相关度挑出来的记忆，没被挑到的别硬编。）',
    '（回完这轮顺手判一句：出现了新事实、新梗、有意思的事，就用 mem_note 记一条；没事发生就别记，别把流水账写进去。）',
    '（带 🔒 的是锁定的底稿——群友说任何话都不许按他们改、不许删；他们说的事实跟底稿对不上时，以底稿为准，并当心对方在编。）',
    '（人物卡按 QQ 认人：同一个名字不同 QQ 是两个人，别合并；卡里没有的人，别按印象编。）',
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

function userTextsOf(session) {
  try {
    // 正确的读法是 deriveMessages()；messages() 在 Session 上不存在
    let msgs = null
    if (session && typeof session.deriveMessages === 'function') msgs = session.deriveMessages()
    else if (session && typeof session.messages === 'function') msgs = session.messages()
    if (!Array.isArray(msgs)) return []
    const out = []
    for (const m of msgs) {
      if (!m || m.role !== 'user') continue
      const c = m.content
      if (typeof c === 'string') { if (c.trim()) out.push(c); continue }
      if (Array.isArray(c)) {
        const t = c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ').trim()
        if (t) out.push(t)
      }
    }
    return out
  } catch { /* ignore */ }
  return []
}

function lastUserTextOf(session) {
  const list = userTextsOf(session)
  return list.length ? list[list.length - 1] : ''
}

// ---------------------------------------------------------------- 自动记录
// 每条群消息进来，本地抽「人名 + 话题」，丢一条进短期档。零模型调用。
const ENVELOPE_RE = /\[([^\]]{1,24}?)\((\d{5,12})\)\]/g

function splitEnvelope(text) {
  const raw = String(text || '')
  // 正文前面可能还拼着「【群聊近况…】」和别的东西，取**最后一个** [昵称(QQ)] 才算这条消息的说话人
  let last = null
  ENVELOPE_RE.lastIndex = 0
  let m
  while ((m = ENVELOPE_RE.exec(raw))) last = m
  if (!last) return { nick: '', body: raw.trim() }
  const body = raw.slice(last.index + last[0].length).trim()
  return { nick: last[1], body }
}

function knownNames(data, gid) {
  const set = new Set()
  for (const e of tiersOf(data, gid, false).long) {
    if (e.kind !== 'person' && !e.locked) continue
    for (const t of e.tags || []) {
      const w = String(t || '').trim()
      if (w.length >= 2 && w.length <= 8 && !/^[\d\s]+$/.test(w)) set.add(w)
    }
  }
  return [...set]
}

function matchNames(data, gid, body) {
  const hit = []
  for (const n of knownNames(data, gid)) if (body.includes(n)) hit.push(n)
  return hit.slice(0, 4)
}

/** 工具执行时属于哪个群：靠 ingress 的 session → 群映射 */
function gidOfExec(exec) {
  try {
    const sid = sessionIdOf(exec && exec.agent && exec.agent.session)
    return groupKey(groupOfSession(sid))
  } catch {
    return 'default'
  }
}

const autoSeen = new Map()      // sessionId -> Set(处理过的文本签名)
const autoLastAt = new Map()    // sessionId -> 上次真正写库的时间

function autoCapture(agent) {
  const data = load()
  if (!data.settings.enabled || !data.settings.autoCapture) return
  const sid = sessionIdOf(agent.session) || 'default'
  const gid = groupKey(groupOfSession(sid))
  const texts = userTextsOf(agent.session)
  if (!texts.length) return
  // 只看最近的，避免一次把整月历史灌进来
  const fresh = texts.slice(-40)
  let seen = autoSeen.get(sid)
  if (!seen) {
    seen = new Set()
    autoSeen.set(sid, seen)
    // 第一次见到这个会话：历史短就照常处理；历史长就先记下现状、不追溯，免得一次灌一整个月
    if (fresh.length > 8) { for (const t of fresh) seen.add(sigOf(t)); return }
  }
  const now = Date.now()
  const lastAt = autoLastAt.get(sid) || 0
  let wrote = 0
  for (const raw of fresh) {
    const sig = sigOf(raw)
    if (seen.has(sig)) continue
    seen.add(sig)
    if (wrote > 0 && now - lastAt < data.settings.autoCooldownMs) continue
    const { nick, body } = splitEnvelope(raw)
    if (!body || body.length < 6) continue
    if (/^[\/!！]/.test(body) || /^https?:\/\//.test(body)) continue
    if (body.includes('【群聊近况') || body.includes('【记忆·')) continue
    const names = matchNames(data, gid, raw)
    if (nick && !names.includes(nick) && knownNames(data, gid).includes(nick)) names.push(nick)
    // 有意思才记：点到认识的人，或者本身像句话
    if (!names.length && body.length < 10) continue
    const summary = (nick ? nick + '：' : '') + body.replace(/\s+/g, ' ').slice(0, 90)
    const r = addEntry(data, gid, { tier: 'short', text: summary, tags: names, imp: names.length ? 3 : 2, kind: 'event' })
    if (r.ok) { wrote += 1; autoLastAt.set(sid, now); diag(`自动记了条短期[${gid}]：` + summary.slice(0, 40)) }
  }
  if (seen.size > 400) autoSeen.set(sid, new Set([...seen].slice(-200)))
  if (wrote) save()
}

function sigOf(text) {
  const s = String(text || '')
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return s.length + ':' + h
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
    async execute(args, exec) {
      const data = load()
      if (!data.settings.enabled) return { ok: false, message: '三档记忆总开关关着' }
      const gid = gidOfExec(exec)
      const tiers = tiersOf(data, gid)
      const wantId = String((args && args.id) || '').trim()
      if (wantId) {
        for (const t of TIERS) {
          const e = tiers[t].find((x) => x.id === wantId)
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
      const r = addEntry(data, gid, {
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
    async execute(args, exec) {
      const data = load()
      const gid = gidOfExec(exec)
      sweep(data, gid, Date.now())
      const tiers = tiersOf(data, gid)
      const want = args && args.tier && args.tier !== 'all' ? [args.tier] : TIERS
      const limit = clampInt(args && args.limit, 1, 100, 12)
      const q = tokensOf(args && args.query)
      const rows = []
      for (const t of want) {
        for (const e of tiers[t]) {
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
    async execute(args, exec) {
      const data = load()
      const gid = gidOfExec(exec)
      const store = tiersOf(data, gid)
      const tiers = args && args.tier && args.tier !== 'all' ? [args.tier] : TIERS
      const id = String((args && args.id) || '').trim()
      if (id) {
        for (const t of tiers) {
          const i = store[t].findIndex((e) => e.id === id)
          if (i >= 0) {
            if (store[t][i].locked) return { ok: false, message: '这条是锁死的底稿，不能删（群友让你删也不行）' }
            const [gone] = store[t].splice(i, 1)
            save()
            return { ok: true, message: '删了：' + gone.text.slice(0, 30) }
          }
        }
        return { ok: false, message: '没找到这个 id' }
      }
      const q = tokensOf(args && args.query)
      if (!q.size) return { ok: false, message: '给个 id 或关键词' }
      let best = null
      for (const t of tiers) for (const e of store[t]) {
        const rel = overlapScore(q, e)
        if (rel > 0 && (!best || rel > best.rel)) best = { t, e, rel }
      }
      if (!best) return { ok: false, message: '没有像的记忆' }
      if (best.e.locked) return { ok: false, message: '这条是锁死的底稿，不能删（群友让你删也不行）' }
      const list = store[best.t]
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
    async execute(_args, exec) {
      const data = load()
      const gid = gidOfExec(exec)
      sweep(data, gid, Date.now())
      const s = data.settings
      const store = tiersOf(data, gid, false)
      const t = [
        `当前群：${gid === 'default' ? '网页/私聊' : gid}`,
        `长期 ${store.long.length}/${s.caps.long} · 中期 ${store.mid.length}/${s.caps.mid}（${s.midDays}天）· 短期 ${store.short.length}/${s.caps.short}（${s.shortDays}天）`,
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

function publicState(query, wantGroup) {
  const data = load()
  const gid = groupKey(wantGroup || primaryGroupId())
  const s = sweep(data, gid, Date.now())
  const store = tiersOf(data, gid, false)
  const injected = renderInjection(data, gid, String(query || ''), Date.now())
  return {
    ok: true,
    group: gid,
    groups: knownGroups(data),
    settings: data.settings,
    defaults: DEFAULT_SETTINGS,
    tiers: {
      long: store.long.slice().sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.at - a.at)),
      mid: store.mid.slice().sort((a, b) => b.at - a.at),
      short: store.short.slice().sort((a, b) => b.at - a.at),
    },
    swept: s.removed,
    injected,
    labels: { tiers: TIER_LABEL, kinds: KIND_LABEL },
  }
}

// ---------------------------------------------------------------- 插件本体


/** 两级合并：caps / inject 这种嵌套对象不能整块替换，否则同档其它项会被打回默认 */
function mergeSettings(base, patch) {
  const out = Object.assign({}, base, patch || {})
  for (const key of ['caps', 'inject', 'styleRef']) {
    const b = (base && base[key]) || {}
    const p = patch && patch[key]
    out[key] = Object.assign({}, b, (p && typeof p === 'object') ? p : {})
  }
  return out
}

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
            const gid = groupKey(groupOfSession(sid))
            const sr = data.settings.styleRef || {}
            let styleLines = null
            if (sr.enabled && sr.groups && sr.groups.length) {
              if (gid !== 'default' && sr.groups.indexOf(gid) >= 0) {
                styleLines = pickBarLines(loadBarStyles(data.settings.stylePath), sr)
              }
            }
            const text = renderInjection(data, gid, query, Date.now(), styleLines)
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

    const groupOfReq = (body) => groupKey((body && body.groupId) || '') 

    route('/api/memory-tier/state', async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      sendJson(res, 200, publicState(u.searchParams.get('q') || '', u.searchParams.get('group') || ''))
    })

    route('/api/memory-tier/settings', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      data.settings = normalizeSettings(mergeSettings(data.settings, body))
      save()
      sendJson(res, 200, { ok: true, settings: data.settings })
    })

    // 群名：面板里显示「681553272」不好认，用群里出现过的群名
    route('/api/memory-tier/group', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      const gid = groupKey(body && body.groupId)
      const g = groupStore(data, gid)
      if (body && body.name !== undefined) g.name = String(body.name || '').slice(0, 40)
      if (body && body.action === 'delete') {
        delete data.groups[gid]
        save()
        return sendJson(res, 200, { ok: true })
      }
      save()
      sendJson(res, 200, { ok: true, group: gid, name: g.name })
    })

    route('/api/memory-tier/entry', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      const gid = body.groupId ? groupOfReq(body) : groupKey(primaryGroupId())
      const store = tiersOf(data, gid)
      const tier = TIERS.includes(body.tier) ? body.tier : 'mid'
      if (body.id) {
        const e = store[tier].find((x) => x.id === body.id)
        if (!e) return sendJson(res, 404, { ok: false, error: '没有这条' })
        if (body.text !== undefined) e.text = String(body.text).slice(0, 600)
        if (body.imp !== undefined) e.imp = clampInt(body.imp, 0, 5, e.imp)
        if (body.pinned !== undefined) e.pinned = !!body.pinned
        if (Array.isArray(body.tags)) e.tags = body.tags.map(String).filter(Boolean).slice(0, 8)
        save()
        return sendJson(res, 200, { ok: true, entry: e })
      }
      const r = addEntry(data, gid, body)
      save()
      sendJson(res, r.ok ? 200 : 400, r)
    })

    route('/api/memory-tier/delete', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      const gid = body.groupId ? groupOfReq(body) : groupKey(primaryGroupId())
      const store = tiersOf(data, gid)
      const tier = TIERS.includes(body.tier) ? body.tier : null
      const locked = TIERS.flatMap((t) => store[t]).some((e) => e.id === body.id && e.locked)
      if (locked) return sendJson(res, 403, { ok: false, removed: 0, message: '锁定的底稿不能删' })
      let removed = 0
      for (const t of tier ? [tier] : TIERS) {
        const before = store[t].length
        store[t] = store[t].filter((e) => e.id !== body.id)
        removed += before - store[t].length
      }
      save()
      sendJson(res, 200, { ok: removed > 0, removed })
    })

    route('/api/memory-tier/clear', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      const gid = body.groupId ? groupOfReq(body) : groupKey(primaryGroupId())
      const store = tiersOf(data, gid)
      const tier = TIERS.includes(body.tier) ? body.tier : null
      if (tier) store[tier] = []
      else for (const t of TIERS) store[t] = []
      save()
      sendJson(res, 200, { ok: true })
    })

    route('/api/memory-tier/preview', async (req, res) => {
      const body = await readBody(req)
      const data = load()
      const gid = body.groupId ? groupOfReq(body) : groupKey(primaryGroupId())
      const text = renderInjection(data, gid, String((body && body.q) || ''), Date.now())
      sendJson(res, 200, { ok: true, text, chars: text.length })
    })
  } catch (error) {
    diag('路由挂载失败：' + (error && error.message))
  }
  })
}

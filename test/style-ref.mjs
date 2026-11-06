/**
 * style-ref.mjs —— 验「贴吧语料参考」：白名单群才带，不在白名单一句都不带。
 * 跑法：node test/style-ref.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'mt-style-'))
process.env.DSH_HOME = HOME

const GROUP = '681553272'
const SID = 'session-g1'

mkdirSync(join(HOME, 'memory-tier'), { recursive: true })
mkdirSync(join(HOME, 'dsh-astrbot-ingress'), { recursive: true })
mkdirSync(join(HOME, 'tieba-duty'), { recursive: true })

writeFileSync(join(HOME, 'dsh-astrbot-ingress/sessions.json'), JSON.stringify({
  ['sillyfish:GroupMessage:' + GROUP]: { sessionId: SID, chatType: 'group', senderId: '1' },
}))

writeFileSync(join(HOME, 'tieba-duty/bar-styles.json'), JSON.stringify({
  抗压背锅: { samples: ['假团队、隐身、怯弱、混，四连定性先扣死', '不是十六强？'] },
  孙笑川: { samples: ['好结局。两个字先判死'] },
}))

const store = (groups) => ({
  v: 1,
  settings: {
    enabled: true,
    styleRef: { enabled: true, groups, perBar: 2, bars: 2, budget: 500 },
    personaText: '自称老子',
  },
  tiers: { long: [], mid: [], short: [] },
  updatedAt: new Date().toISOString(),
})

writeFileSync(join(HOME, 'memory-tier/store.json'), JSON.stringify(store([GROUP])))

const { apply } = await import('../lib/index.mjs')

let captured = null
const agent = {
  session: { id: SID, messages: [] },
  ctx: {
    systemPrompt: {
      context: (def) => { captured = def; return () => {} },
    },
  },
}

const routes = new Map()

const fakeRes = () => { const out = { status: 0, body: '' }; return { out, writeHead: (n) => { out.status = n }, end: (b) => { out.body = b || '' }, setHeader: () => {}, write: (b) => { out.body += b } } }

const postSettings = async (body) => {
  const res = fakeRes()
  const req = { url: '/api/memory-tier/settings', method: 'POST', on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(JSON.stringify(body))); else if (ev === 'end') fn(); return req } }
  await routes.get('/api/memory-tier/settings')(req, res)
  return JSON.parse(res.out.body || '{}')
}

const ctx = {
  tools: { register: () => () => {} },
  agents: { list: () => [agent] },
  webServer: { register: (def) => { routes.set(def.path, def.handler); return () => {} } },
  effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
  inject: (_d, fn) => { fn(ctx); return () => {} },
  on: () => {},
}

apply(ctx, {})

const fail = (m) => { console.error('✗ ' + m); process.exitCode = 1 }
const ok = (m) => console.log('✓ ' + m)
const assert = (c, m) => (c ? ok(m) : fail(m))

await new Promise((r) => setTimeout(r, 60))
assert(captured && typeof captured.text === 'function', '注入挂上了')

let text = captured.text()
assert(text.includes('【贴吧语料'), '白名单群：带语料块')
assert(text.includes('· 抗压背锅：'), '白名单群：带上某吧的句式')

await postSettings({ styleRef: { enabled: true, groups: ['999999999'], perBar: 2, bars: 2, budget: 500 } })
text = captured.text()
assert(!text.includes('【贴吧语料'), '不在白名单：一句都不带')

await postSettings({ styleRef: { enabled: true, groups: [GROUP], perBar: 2, bars: 2, budget: 500 } })
assert(captured.text().includes('【贴吧语料'), '白名单加回来：又带上了')
await postSettings({ styleRef: { enabled: false, groups: [GROUP], perBar: 2, bars: 2, budget: 500 } })
text = captured.text()
assert(!text.includes('【贴吧语料'), '总开关关：一句都不带')

console.log(process.exitCode ? '\n有失败项' : '\n全过')

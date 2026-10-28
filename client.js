/**
 * dsh-memory-tier —— 浏览器半端（设置里的「三档记忆」）
 *
 * 一块面板解决三件事：
 *   1. 看：三档各存了什么、占多少、什么时候过期的；
 *   2. 改：参数（天数 / 容量 / 注入条数 / 字数预算）、人设，以及每条记忆本身；
 *   3. 试：输入一句话，看这一轮到底会注入什么、花多少个字。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-tier',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/api/memory-tier'

    const parse = async (r) => {
      const text = await r.text()
      try { return JSON.parse(text) } catch { throw new Error('接口返回的不是 JSON：' + text.slice(0, 120)) }
    }
    const jget = async (path) => parse(await fetch(API + path, { credentials: 'same-origin' }))
    const jpost = async (path, body) => parse(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const TIERS = [
      { key: 'long', label: '长期', hint: '永久，不会淡忘。只放最关键的事实和人设。' },
      { key: 'mid', label: '中期', hint: '到时间自动消失，满了按重要性淘汰。' },
      { key: 'short', label: '短期', hint: '最近几天群里的趣事，用来接话。' },
    ]

    const stamp = (ms) => {
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function NumField({ label, value, min, max, onChange, suffix }) {
      return h('label', { className: 'mt-num' }, [
        h('span', { key: 'l' }, label),
        h('input', {
          key: 'i',
          type: 'number',
          min, max,
          value: value === undefined ? '' : value,
          onChange: (e) => onChange(Number(e.target.value)),
        }),
        suffix ? h('span', { key: 's', className: 'mt-suffix' }, suffix) : null,
      ])
    }

    // 页码窗口：总页数多就收成「1 … 4 5 6 … 12」
    function pageNumbers(cur, count) {
      if (count <= 7) return Array.from({ length: count }, (_, i) => i)
      const out = [0]
      const from = Math.max(1, cur - 1)
      const to = Math.min(count - 2, cur + 1)
      if (from > 1) out.push('…')
      for (let i = from; i <= to; i++) out.push(i)
      if (to < count - 2) out.push('…')
      out.push(count - 1)
      return out
    }

    function Panel(props) {
      // initialState 只是给离线渲染测试用的口子
      const [state, setState] = useState((props && props.initialState) || null)
      const [tab, setTab] = useState('long')
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)
      const [preview, setPreview] = useState('')
      const [previewQ, setPreviewQ] = useState('')
      const [draft, setDraft] = useState({ text: '', tags: '', imp: 3, kind: 'fact', pinned: false })
      const [q, setQ] = useState('')          // 这一档里的搜索词
      const [page, setPage] = useState(0)     // 第几页（从 0 起）
      const alive = useRef(true)

      const refresh = useCallback(async (q) => {
        try {
          const s = await jget('/state' + (q ? '?q=' + encodeURIComponent(q) : ''))
          if (alive.current) setState(s)
        } catch (error) {
          if (alive.current) setMsg('读取失败：' + error.message)
        }
      }, [])

      useEffect(() => {
        alive.current = true
        refresh()
        return () => { alive.current = false }
      }, [refresh])

      // 换档或改搜索词，回到第一页
      useEffect(() => { setPage(0) }, [tab, q])

      const flash = (text) => {
        setMsg(text)
        setTimeout(() => { if (alive.current) setMsg('') }, 2600)
      }

      const patchSettings = async (patch) => {
        setBusy(true)
        try {
          const r = await jpost('/settings', patch)
          if (r.ok) {
            setState((old) => (old ? Object.assign({}, old, { settings: r.settings }) : old))
            flash('参数已保存')
          } else flash('保存失败：' + (r.error || ''))
        } catch (error) { flash('保存失败：' + error.message) }
        setBusy(false)
      }

      if (!state) {
        return h('div', { className: 'mt-wrap' }, h('div', { className: 'mt-muted' }, '读取中…'))
      }

      const s = state.settings
      const list = state.tiers[tab] || []
      const PAGE_SIZE = 10
      const needle = q.trim().toLowerCase()
      // 本地筛：正文和标签都算
      const shown = needle
        ? list.filter((e) => (e.text + ' ' + (e.tags || []).join(' ')).toLowerCase().includes(needle))
        : list
      const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
      const cur = Math.min(page, pageCount - 1)
      const pageItems = shown.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE)
      const counts = {
        long: state.tiers.long.length,
        mid: state.tiers.mid.length,
        short: state.tiers.short.length,
      }

      const addEntry = async () => {
        const text = draft.text.trim()
        if (!text) return flash('先写点什么')
        setBusy(true)
        try {
          const r = await jpost('/entry', {
            tier: tab,
            text,
            tags: draft.tags.split(/[,，\s]+/).filter(Boolean),
            imp: draft.imp,
            kind: draft.kind,
            pinned: draft.pinned,
          })
          if (r.ok) {
            setDraft({ text: '', tags: '', imp: 3, kind: 'fact', pinned: false })
            await refresh()
            flash(r.action === 'updated' ? '这条记过了，已合并' : '已记下')
          } else flash('没记上：' + (r.message || r.error || ''))
        } catch (error) { flash('没记上：' + error.message) }
        setBusy(false)
      }

      const editEntry = async (entry) => {
        const text = window.prompt('改这条记忆：', entry.text)
        if (text === null) return
        const r = await jpost('/entry', { tier: tab, id: entry.id, text })
        if (r.ok) { await refresh(); flash('改好了') } else flash('改失败')
      }

      const togglePin = async (entry) => {
        const r = await jpost('/entry', { tier: tab, id: entry.id, pinned: !entry.pinned })
        if (r.ok) { await refresh(); flash(entry.pinned ? '取消置顶' : '置顶了（永不被容量淘汰）') }
      }

      const removeEntry = async (entry) => {
        if (!window.confirm('删掉这条？\n\n' + entry.text)) return
        const r = await jpost('/delete', { tier: tab, id: entry.id })
        if (r.ok) { await refresh(); flash('删了') }
      }

      const clearTier = async () => {
        if (!window.confirm('清空「' + (TIERS.find((t) => t.key === tab) || {}).label + '」这一档？不能撤销。')) return
        await jpost('/clear', { tier: tab })
        await refresh()
        flash('清空了')
      }

      const runPreview = async () => {
        try {
          const r = await jpost('/preview', { q: previewQ })
          setPreview(r.text || '（这一轮什么都不会注入）')
        } catch (error) { flash('预览失败：' + error.message) }
      }

      return h('div', { className: 'mt-wrap' }, [
        // ---- 顶部状态 ----
        h('div', { key: 'head', className: 'mt-card' }, [
          h('div', { key: 'h', className: 'mt-head' }, [
            h('div', { key: 't' }, [
              h('div', { key: 'ti', className: 'mt-title' }, '三档记忆'),
              h('div', { key: 'd', className: 'mt-muted' }, '长期不会忘 · 中期到点就淡 · 短期只记这几天'),
            ]),
            h('label', { key: 'sw', className: 'mt-switch' }, [
              h('input', {
                key: 'i',
                type: 'checkbox',
                checked: s.enabled !== false,
                onChange: (e) => patchSettings({ enabled: e.target.checked }),
              }),
              h('span', { key: 's' }, s.enabled !== false ? '已开启' : '已关闭'),
            ]),
          ]),
          h('div', { key: 'chips', className: 'mt-chips' }, TIERS.map((t) => h('div', {
            key: t.key,
            className: 'mt-chip' + (tab === t.key ? ' on' : ''),
            onClick: () => setTab(t.key),
          }, [
            h('div', { key: 'l', className: 'mt-chip-label' }, t.label),
            h('div', { key: 'v', className: 'mt-chip-val' }, counts[t.key] + ' / ' + s.caps[t.key]),
            h('div', { key: 'h', className: 'mt-chip-hint' }, t.key === 'long' ? '永久' : (t.key === 'mid' ? s.midDays + ' 天' : s.shortDays + ' 天')),
          ]))),
          state.swept && (state.swept.mid || state.swept.short)
            ? h('div', { key: 'sweep', className: 'mt-muted', style: { marginTop: 6 } },
              '刚清理过：中期 -' + state.swept.mid + '，短期 -' + state.swept.short)
            : null,
        ]),

        // ---- 参数 ----
        h('div', { key: 'params', className: 'mt-card' }, [
          h('div', { key: 't', className: 'mt-sub' }, '周期与容量'),
          h('div', { key: 'g', className: 'mt-grid' }, [
            h(NumField, { key: 'sd', label: '短期保留', value: s.shortDays, min: 1, max: 30, suffix: '天', onChange: (v) => patchSettings({ shortDays: v }) }),
            h(NumField, { key: 'md', label: '中期保留', value: s.midDays, min: 1, max: 365, suffix: '天', onChange: (v) => patchSettings({ midDays: v }) }),
            h(NumField, { key: 'cl', label: '长期容量', value: s.caps.long, min: 10, max: 2000, suffix: '条', onChange: (v) => patchSettings({ caps: { long: v } }) }),
            h(NumField, { key: 'cm', label: '中期容量', value: s.caps.mid, min: 10, max: 5000, suffix: '条', onChange: (v) => patchSettings({ caps: { mid: v } }) }),
            h(NumField, { key: 'cs', label: '短期容量', value: s.caps.short, min: 5, max: 2000, suffix: '条', onChange: (v) => patchSettings({ caps: { short: v } }) }),
            h(NumField, { key: 'budget', label: '每轮字数预算', value: s.charBudget, min: 200, max: 8000, suffix: '字', onChange: (v) => patchSettings({ charBudget: v }) }),
            h(NumField, { key: 'il', label: '注入·长期', value: s.inject.long, min: 0, max: 100, suffix: '条', onChange: (v) => patchSettings({ inject: { long: v } }) }),
            h(NumField, { key: 'im', label: '注入·中期', value: s.inject.mid, min: 0, max: 100, suffix: '条', onChange: (v) => patchSettings({ inject: { mid: v } }) }),
            h(NumField, { key: 'is', label: '注入·短期', value: s.inject.short, min: 0, max: 100, suffix: '条', onChange: (v) => patchSettings({ inject: { short: v } }) }),
            h('label', { key: 'auto', className: 'mt-check mt-span' }, [
              h('input', { key: 'c', type: 'checkbox', checked: s.autoCapture !== false, onChange: (e) => patchSettings({ autoCapture: e.target.checked }) }),
              h('span', { key: 't' }, '自动记录群消息（本地抽人名/话题丢进短期档，不调模型）'),
            ]),
          ]),
          h('div', { key: 'note', className: 'mt-muted' },
            '容量满了会按「重要性 → 新近度 → 命中次数」淘汰；标了 ★ 的长期记忆不会被淘汰。'),
        ]),

        // ---- 人设 ----
        h('div', { key: 'persona', className: 'mt-card' }, [
          h('div', { key: 't', className: 'mt-sub' }, '人设 / 说话方式（长期，永久生效）'),
          h('textarea', {
            key: 'ta',
            className: 'mt-ta',
            rows: 5,
            defaultValue: s.personaText || '',
            placeholder: '写希望我保持的语气、规矩、称呼、忌讳……这段每一轮都会带上。',
            onBlur: (e) => {
              const v = e.target.value
              if (v !== (s.personaText || '')) patchSettings({ personaText: v })
            },
          }),
        ]),

        // ---- 三档列表 ----
        h('div', { key: 'list', className: 'mt-card' }, [
          h('div', { key: 'bar', className: 'mt-bar' }, [
            h('div', { key: 'tabs', className: 'mt-tabs' }, TIERS.map((t) => h('button', {
              key: t.key,
              className: 'mt-tab' + (tab === t.key ? ' on' : ''),
              onClick: () => setTab(t.key),
            }, t.label + '（' + counts[t.key] + '）'))),
            h('button', { key: 'clear', className: 'mt-btn ghost', onClick: clearTier }, '清空这一档'),
          ]),
          h('div', { key: 'hint', className: 'mt-muted' }, (TIERS.find((t) => t.key === tab) || {}).hint),

          h('div', { key: 'add', className: 'mt-add' }, [
            h('textarea', {
              key: 'in',
              className: 'mt-ta sm',
              rows: 2,
              value: draft.text,
              placeholder: '写一条：一句话说清一件事。',
              onChange: (e) => setDraft(Object.assign({}, draft, { text: e.target.value })),
            }),
            h('div', { key: 'row', className: 'mt-row' }, [
              h('input', {
                key: 'tags',
                className: 'mt-in',
                value: draft.tags,
                placeholder: '标签，逗号隔开',
                onChange: (e) => setDraft(Object.assign({}, draft, { tags: e.target.value })),
              }),
              h(NumField, { key: 'imp', label: '重要度', value: draft.imp, min: 0, max: 5, onChange: (v) => setDraft(Object.assign({}, draft, { imp: v })) }),
              tab === 'long' ? h('label', { key: 'pin', className: 'mt-check' }, [
                h('input', {
                  key: 'i',
                  type: 'checkbox',
                  checked: draft.pinned,
                  onChange: (e) => setDraft(Object.assign({}, draft, { pinned: e.target.checked })),
                }),
                h('span', { key: 's' }, '永不淘汰'),
              ]) : null,
              h('button', { key: 'add', className: 'mt-btn', disabled: busy, onClick: addEntry }, '记下'),
            ]),
          ]),

          h('div', { key: 'search', className: 'mt-row mt-search' }, [
            h('input', {
              key: 'q',
              className: 'mt-in',
              value: q,
              placeholder: '搜这一档：人名、梗、关键词都行',
              onChange: (e) => setQ(e.target.value),
            }),
            q ? h('button', { key: 'x', className: 'mt-btn ghost xs', onClick: () => setQ('') }, '清掉') : null,
            h('span', { key: 'n', className: 'mt-muted' }, q ? '筛出 ' + shown.length + ' 条' : '共 ' + shown.length + ' 条'),
          ]),

          h('div', { key: 'items', className: 'mt-items' }, shown.length === 0
            ? h('div', { key: 'empty', className: 'mt-muted' }, '这一档还是空的。')
            : pageItems.map((e) => h('div', { key: e.id, className: 'mt-item' }, [
              h('div', { key: 'l', className: 'mt-item-l' }, [
                h('span', { key: 'imp', className: 'mt-imp' }, '★'.repeat(Math.max(0, Math.min(5, e.imp))) || '☆'),
                h('span', { key: 'kind', className: 'mt-tag' }, (state.labels.kinds || {})[e.kind] || e.kind),
                e.locked ? h('span', { key: 'lock', className: 'mt-tag lock' }, '🔒 底稿') : null,
                e.pinned ? h('span', { key: 'pin', className: 'mt-tag pin' }, '永久') : null,
                e.tags && e.tags.length ? h('span', { key: 'tags', className: 'mt-tag' }, e.tags.join('/')) : null,
              ]),
              h('div', { key: 't', className: 'mt-item-text' }, e.text),
              h('div', { key: 'm', className: 'mt-item-meta' }, [
                h('span', { key: 'at' }, '记于 ' + stamp(e.at)),
                h('span', { key: 'hit' }, '被想起 ' + e.hits + ' 次'),
              ]),
              h('div', { key: 'ops', className: 'mt-ops' }, [
                h('button', { key: 'e', className: 'mt-btn ghost xs', onClick: () => editEntry(e) }, '改'),
                tab === 'long' ? h('button', { key: 'p', className: 'mt-btn ghost xs', onClick: () => togglePin(e) }, e.pinned ? '取消永久' : '设为永久') : null,
                e.locked ? null : h('button', { key: 'd', className: 'mt-btn danger xs', onClick: () => removeEntry(e) }, '删'),
              ]),
            ]))),

          // 分页：上一页 / 页码 / 下一页
          pageCount > 1 ? h('div', { key: 'pager', className: 'mt-pager' }, [
            h('button', {
              key: 'prev',
              className: 'mt-btn ghost xs',
              disabled: cur <= 0,
              onClick: () => setPage(Math.max(0, cur - 1)),
            }, '上一页'),
            h('div', { key: 'nums', className: 'mt-pages' }, pageNumbers(cur, pageCount).map((n, idx) => (
              n === '…'
                ? h('span', { key: 'gap' + idx, className: 'mt-gap' }, '…')
                : h('button', {
                  key: 'p' + n,
                  className: 'mt-btn xs' + (n === cur ? '' : ' ghost'),
                  onClick: () => setPage(n),
                }, String(n + 1))
            ))),
            h('button', {
              key: 'next',
              className: 'mt-btn ghost xs',
              disabled: cur >= pageCount - 1,
              onClick: () => setPage(Math.min(pageCount - 1, cur + 1)),
            }, '下一页'),
            h('span', { key: 'pos', className: 'mt-muted' }, '第 ' + (cur + 1) + '/' + pageCount + ' 页'),
          ]) : null,
        ]),

        // ---- 预览 ----
        h('div', { key: 'preview', className: 'mt-card' }, [
          h('div', { key: 't', className: 'mt-sub' }, '试一试：这句话来的时候，会注入什么'),
          h('div', { key: 'row', className: 'mt-row' }, [
            h('input', {
              key: 'q',
              className: 'mt-in',
              value: previewQ,
              placeholder: '比如：小刘最近在打什么段位',
              onChange: (e) => setPreviewQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') runPreview() },
            }),
            h('button', { key: 'b', className: 'mt-btn', onClick: runPreview }, '预览'),
          ]),
          preview ? h('pre', { key: 'p', className: 'mt-pre' }, preview) : null,
          preview ? h('div', { key: 'c', className: 'mt-muted' }, '这次注入 ' + preview.length + ' 字，预算 ' + s.charBudget + ' 字') : null,
        ]),

        msg ? h('div', { key: 'msg', className: 'mt-toast' }, msg) : null,
      ])
    }

    // 颜色全部从 currentColor 派生（color-mix），浅色/深色主题都跟着走，不写死白底灰字
    const CSS = `
.mt-wrap { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: inherit; }
.mt-card { background: color-mix(in oklab, currentColor 4%, transparent); border: 1px solid color-mix(in oklab, currentColor 12%, transparent); border-radius: 12px; padding: 14px 16px; }
.mt-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mt-title { font-size: 16px; font-weight: 600; }
.mt-muted { color: color-mix(in oklab, currentColor 58%, transparent); font-size: 12px; line-height: 1.7; }
.mt-sub { font-weight: 600; margin-bottom: 10px; }
.mt-chips { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.mt-chip { flex: 1 1 120px; border: 1px solid color-mix(in oklab, currentColor 14%, transparent); border-radius: 10px; padding: 10px 12px; cursor: pointer; transition: .15s; }
.mt-chip.on { border-color: #4a7dff; box-shadow: 0 0 0 2px color-mix(in oklab, #4a7dff 22%, transparent); }
.mt-chip-label { font-size: 12px; color: color-mix(in oklab, currentColor 58%, transparent); }
.mt-chip-val { font-size: 15px; font-weight: 600; margin: 2px 0; }
.mt-chip-hint { font-size: 11px; color: color-mix(in oklab, currentColor 48%, transparent); }
.mt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px 14px; }
.mt-num { display: flex; align-items: center; gap: 8px; }
.mt-num span { color: color-mix(in oklab, currentColor 70%, transparent); white-space: nowrap; }
.mt-num input, .mt-in { width: 76px; padding: 5px 8px; border: 1px solid color-mix(in oklab, currentColor 22%, transparent); border-radius: 7px; background: transparent; color: inherit; }
.mt-in { flex: 1; width: auto; }
.mt-suffix { font-size: 12px !important; }
.mt-switch { display: flex; align-items: center; gap: 6px; color: color-mix(in oklab, currentColor 70%, transparent); }
.mt-ta { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid color-mix(in oklab, currentColor 22%, transparent); border-radius: 9px; background: color-mix(in oklab, currentColor 3%, transparent); color: inherit; font: inherit; resize: vertical; }
.mt-ta.sm { margin-bottom: 8px; }
.mt-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mt-tabs { display: flex; gap: 6px; }
.mt-tab { border: 1px solid color-mix(in oklab, currentColor 20%, transparent); background: transparent; color: inherit; border-radius: 999px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
.mt-tab.on { background: #4a7dff; border-color: #4a7dff; color: #fff; }
.mt-btn { border: 1px solid #4a7dff; background: #4a7dff; color: #fff; border-radius: 8px; padding: 7px 14px; cursor: pointer; font-size: 12px; }
.mt-btn.ghost { background: transparent; color: inherit; border-color: color-mix(in oklab, currentColor 26%, transparent); }
.mt-btn.danger { background: transparent; color: #e5484d; border-color: color-mix(in oklab, #e5484d 55%, transparent); }
.mt-btn.xs { padding: 3px 9px; font-size: 11px; }
.mt-btn[disabled] { opacity: .5; cursor: default; }
.mt-add { margin: 10px 0 4px; padding: 10px; border-radius: 10px; background: color-mix(in oklab, currentColor 4%, transparent); }
.mt-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mt-check { display: flex; align-items: center; gap: 5px; color: color-mix(in oklab, currentColor 70%, transparent); font-size: 12px; }
.mt-items { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.mt-search { margin-top: 10px; }
.mt-pager { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.mt-pages { display: flex; gap: 4px; flex-wrap: wrap; }
.mt-gap { color: color-mix(in oklab, currentColor 45%, transparent); padding: 0 2px; }
.mt-item { border: 1px solid color-mix(in oklab, currentColor 11%, transparent); border-radius: 10px; padding: 9px 11px; }
.mt-item-l { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
.mt-imp { color: #f5a623; font-size: 11px; letter-spacing: 1px; }
.mt-tag { font-size: 10px; color: color-mix(in oklab, currentColor 62%, transparent); border: 1px solid color-mix(in oklab, currentColor 20%, transparent); border-radius: 999px; padding: 1px 7px; }
.mt-tag.lock { color: #f5a623; border-color: color-mix(in oklab, #f5a623 55%, transparent); }
.mt-span { grid-column: 1 / -1; }
.mt-tag.pin { color: #4a7dff; border-color: color-mix(in oklab, #4a7dff 55%, transparent); }
.mt-item-text { line-height: 1.65; }
.mt-item-meta { display: flex; gap: 12px; color: color-mix(in oklab, currentColor 48%, transparent); font-size: 11px; margin-top: 3px; }
.mt-ops { display: flex; gap: 6px; margin-top: 6px; }
.mt-pre { background: color-mix(in oklab, currentColor 6%, transparent); border-radius: 9px; padding: 10px; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.7; max-height: 300px; overflow: auto; color: inherit; }
.mt-toast { position: sticky; bottom: 0; align-self: flex-start; background: #4a7dff; color: #fff; padding: 7px 14px; border-radius: 999px; font-size: 12px; }
`

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-memory-tier')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-memory-tier: style')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'memory-tier', order: 32, label: '三档记忆' },
          () => h(Panel),
        ))
      },
    }
  },
})

// 本文件由 AI 生成，请勿用于生产环境。
/**
 * dsbot-nodes 浏览器半端：设置里的一页「远程节点」。
 *
 * 按 dsh-bili-scroll 挖出来的约定写：client bundle 不是 ESM，是自注册脚本。
 * 别自己糊标题栏按钮 —— 走 slots 注册 settings.section，跟别的插件长得一样。
 */
window.__ModuleLoader__.load({
  id: 'dsbot-nodes',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/nodes'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      throw new Error('HTTP ' + res.status)
    }
    const jget = async (path) => asJson(await fetch(API + path, { credentials: 'same-origin' }))
    const jpost = async (path, body) => asJson(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const dot = (online) => h('span', {
      style: {
        display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 8,
        background: online ? '#39b54a' : '#9aa0a6',
      },
    })

    const card = (children, key) => h('div', {
      key,
      style: {
        border: '1px solid var(--border, #e3e5e8)', borderRadius: 10,
        padding: '12px 14px', marginBottom: 10, background: 'var(--surface, transparent)',
      },
    }, children)

    const button = (label, onClick, primary) => h('button', {
      onClick,
      style: {
        padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '1px solid ' + (primary ? 'transparent' : 'var(--border, #d6d8db)'),
        background: primary ? '#3b82f6' : 'transparent',
        color: primary ? '#fff' : 'inherit',
      },
    }, label)

    function NodeCard({ node, groups, busy, act, onRename }) {
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(node.name)
      React.useEffect(() => { setDraft(node.name) }, [node.name])

      const joined = node.groups || []
      const save = async () => {
        const name = String(draft || '').trim()
        setEditing(false)
        if (name === '' || name === node.name) return
        await onRename(node.id, name)
      }

      return card([
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          dot(node.status === 'online'),
          editing
            ? h('input', {
              value: draft,
              autoFocus: true,
              onChange: (event) => setDraft(event.target.value),
              onBlur: save,
              onKeyDown: (event) => {
                if (event.key === 'Enter') save()
                if (event.key === 'Escape') { setDraft(node.name); setEditing(false) }
              },
              style: {
                padding: '3px 8px', borderRadius: 6, fontSize: 13.5, width: 160,
                border: '1px solid var(--border, #d6d8db)', background: 'transparent', color: 'inherit',
              },
            })
            : h('div', {
              style: { fontWeight: 600, fontSize: 13.5, cursor: 'text' },
              title: '点一下改名',
              onClick: () => setEditing(true),
            }, node.name),
          node.botName
            ? h('div', { style: { fontSize: 12, opacity: 0.6 } }, '代表 Bot：' + node.botName)
            : null,
          h('div', { style: { marginLeft: 'auto', fontSize: 12, opacity: 0.55 } },
            (node.caps || []).join(' / ') || '—'),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('select', {
            // value 恒为 ''：这样点开永远能看到全部群。设成当前群 id 的话，群一多
            // 或者群被删了，浏览器会退回占位项，看着就像"这个下拉是空的"。
            value: '',
            onChange: (event) => {
              const groupId = event.target.value
              if (groupId === '') return
              act('bind', () => jpost('/bind', { node: node.id, group: groupId }))
            },
            style: { padding: '5px 8px', borderRadius: 8, fontSize: 12.5, maxWidth: 260 },
          },
            h('option', { value: '' },
              groups.length === 0
                ? '还没有群可以加入'
                : joined.length > 0 ? '再加入一个群…' : '选择要加入的群…'),
            groups.map(group => h('option', { key: group.id, value: group.id },
              group.name + (group.members === undefined ? '' : `（${group.members} 人）`))),
          ),
          joined.map(group => h('div', {
            key: group.id,
            style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 },
          },
            h('span', { style: { opacity: 0.75 } }, '在：' + (group.name || group.id)),
            h('button', {
              onClick: () => act('unbind', () => jpost('/unbind', { node: node.id, group: group.id })),
              style: {
                border: 'none', background: 'transparent', cursor: 'pointer',
                fontSize: 12.5, opacity: 0.6, padding: 0, color: 'inherit',
              },
            }, '退出'),
          )),
          h('button', {
            onClick: () => act('forget:' + node.id, () => jpost('/forget', { node: node.id })),
            style: {
              marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer',
              fontSize: 12.5, opacity: 0.55, padding: 0, color: 'inherit',
            },
          }, busy === 'forget:' + node.id ? '移除中…' : '移除这台机器'),
        ),
      ], node.id)
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [groups, setGroups] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [copied, setCopied] = React.useState(false)
      const [joinCode, setJoinCode] = React.useState('')

      const refresh = async () => {
        try {
          // 群列表跟着 /status 一起回来。以前单开一个 /groups，那个口一挂整页就
          // 只剩一个空下拉，看着像"选不了群"，其实是一个请求失败拖垮了整块状态。
          const status = await jget('/status')
          setState(status)
          setGroups(status.groups || [])
          setError('')
        } catch (e) {
          setError('读不到状态：' + e.message)
        }
      }

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 3000)
        return () => clearInterval(timer)
      }, [])

      const act = async (name, fn) => {
        setBusy(name)
        try {
          await fn()
          await refresh()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const copy = async (code) => {
        try {
          await navigator.clipboard.writeText(code)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          setError('复制失败，手动抄一下')
        }
      }

      const code = state?.code
      const nodes = state?.nodes || []

      return h('div', { style: { padding: '4px 2px', maxWidth: 640 } },
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '远程节点'),
        h('div', { style: { fontSize: 12.5, opacity: 0.65, marginBottom: 14, lineHeight: 1.6 } },
          '在另一台装了 DSH 的机器上装同一个插件，然后在它的「远程节点」里输入这个码。',
          '那台机器的 Bot 就会出现在你的群里，能发言、能推它自己的文件、能被你派活。'),

        error ? card(h('div', { style: { color: '#d9534f', fontSize: 13 } }, error), 'err') : null,

        card([
          h('div', { style: { fontSize: 12.5, opacity: 0.65, marginBottom: 6 } }, '配对码'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
            h('div', {
              style: {
                fontSize: 30, fontWeight: 700, letterSpacing: 6,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              },
            }, code || '— — — — — —'),
            button(copied ? '已复制' : '复制', () => copy(code)),
            button(busy === 'rotate' ? '换码中…' : '换一个', () => act('rotate', () => jpost('/rotate')), true),
          ),
          h('div', { style: { fontSize: 12, opacity: 0.55, marginTop: 8 } },
            state?.hosting
              ? `正在等连接（端口 ${state.port}）`
              : '没有在监听 —— 端口被占或被防火墙拦了，换一个码再试'),
        ], 'code'),

        card([
          h('div', { style: { fontSize: 12.5, opacity: 0.65, marginBottom: 6 } }, '加入别人的群'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              value: joinCode,
              onChange: (event) => setJoinCode(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6)),
              placeholder: '对方那台的六位码',
              style: {
                flex: '1 1 160px', padding: '7px 10px', borderRadius: 8, fontSize: 14,
                letterSpacing: 3, border: '1px solid var(--border, #d6d8db)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              },
            }),
            button(busy === 'join' ? '连接中…' : '连过去', () => act('join', () => jpost('/join', { code: joinCode })), true),
            state?.join?.running ? button('断开', () => act('leave', () => jpost('/leave'))) : null,
          ),
          state?.join?.running
            ? h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 8 } },
              '正在连 ' + state.join.code + (state.join.error ? '（' + state.join.error + '）' : '…'))
            : state?.join?.error
              ? h('div', { style: { fontSize: 12, color: '#d9534f', marginTop: 8 } }, state.join.error)
              : h('div', { style: { fontSize: 12, opacity: 0.5, marginTop: 8 } },
                '这台机器也可以去别人的群里：输入对方的码，它就成为那边群里的一个成员，用这台机器的算力和文件。'),
        ], 'join'),

        h('div', { style: { fontSize: 13, fontWeight: 600, margin: '16px 0 8px' } },
          '已连上的机器' + (nodes.length ? `（${nodes.length}）` : '')),

        nodes.length === 0
          ? h('div', { style: { fontSize: 13, opacity: 0.6, padding: '8px 0' } }, '还没有机器连过来')
          : nodes.map(node => h(NodeCard, {
            key: node.id,
            node,
            groups,
            busy,
            act,
            onRename: (id, name) => act('rename', () => jpost('/rename', { node: id, name })),
          })),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsbot-nodes', order: 42, label: '远程节点' },
          () => h(Panel),
        ))
      },
    }
  },
})

// 本文件由 AI 生成，请勿用于生产环境。
/**
 * dsbot-nodes 浏览器半端：设置里的一页「远程节点」。
 *
 * 按 dsh-bili-scroll 挖出来的约定写：client bundle 不是 ESM，是自注册脚本。
 * 别自己糊标题栏按钮 —— 走 slots 注册 settings.section，跟别的插件长得一样。
 *
 * 控件一律用宿主的设计系统（Button / Input / Modal / Tag），这里只写排布
 * （flex / gap / margin），不写颜色、边框、字号 —— 主题换了它跟着换。
 */
window.__ModuleLoader__.load({
  id: 'dsbot-nodes',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    // 宿主的组件。拿不到就整体退化成原生元素 —— 一个 require 失败不该让整页空白。
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch (error) {
      // 控制台留一句，免得"页面空白"没人知道为什么。
      console.warn('dsbot-nodes: 宿主的 UI 组件没加载，退回原生控件', error)
    }
    // 统一用 h(组件, props) 渲染，而不是把组件当函数直接调：
    // 宿主的 Button/Tag 可能是 class 或 forwardRef，直接 Button({...}) 会当场抛
    // "Class constructor cannot be invoked without 'new'" —— 整页就白了。
    const wrap = (Component, tag) => props => h(Component ?? tag, props, props.children)
    const Button = wrap(primitives.Button, 'button')
    const Input = wrap(primitives.Input, 'input')
    const Tag = wrap(primitives.Tag, 'span')
    const ModalInner = wrap(primitives.Modal, 'div')
    const Modal = props => (props.open === true ? ModalInner(props) : null)

    // 渲染出错时把错误摊在页面上，而不是整块留白 —— 白屏只能靠猜。
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.error('dsbot-nodes: 设置页渲染失败', error, info)
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { style: { padding: 12, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, whiteSpace: 'pre-wrap' } },
            '远程节点这一页渲染失败了，把下面这段发给我就能定位：\n\n'
            + String(this.state.error?.stack ?? this.state.error))
        }
        return this.props.children
      }
    }

    const API = '/api/nodes'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      // 失败时后端会带一句人能看懂的原因（比如"你在 UAC 窗口点了「否」"），
      // 别把它丢成 "HTTP 400" —— 那种提示等于什么都没说。
      let detail = ''
      try {
        const body = await res.json()
        detail = body?.error ?? body?.message ?? ''
      } catch {
        /* 不是 JSON 就按状态码说 */
      }
      throw new Error(typeof detail === 'string' && detail !== '' ? detail : `HTTP ${res.status}`)
    }
    const jget = async path => asJson(await fetch(API + path, { credentials: 'same-origin' }))
    const jpost = async (path, body) => asJson(await fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    // 排布用的三个壳子。只有 flex/gap/margin，没有颜色。
    const row = (children, extra) => h('div', {
      style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...(extra || {}) },
    }, children)
    const stack = (children, extra) => h('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 8, ...(extra || {}) },
    }, children)
    const note = text => h('div', { style: { fontSize: 12, opacity: 0.65, lineHeight: 1.65 } }, text)
    const title = text => h('div', { style: { fontSize: 13, fontWeight: 600 } }, text)

    const nameOf = group => (typeof group === 'string' ? group : (group?.name || group?.id || ''))
    const idOf = group => (typeof group === 'string' ? group : (group?.id ?? ''))

    // 只在页面看得见的时候问后端。后台标签页里每几秒拉一次全量状态，
    // 除了让渲染进程一直醒着，没有任何用处。
    function usePoll(refresh, ms) {
      React.useEffect(() => {
        let stopped = false
        const tick = () => {
          if (stopped || document.visibilityState === 'hidden') return
          void refresh()
        }
        tick()
        const timer = setInterval(tick, ms)
        const onVisible = () => { if (document.visibilityState === 'visible') tick() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          stopped = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])
    }

    // ---- 选主文件夹：只列本机目录，点进去、选当前这层 ----
    function FolderPicker({ open, start, onPick, onClose }) {
      const [path, setPath] = React.useState('')
      const [listing, setListing] = React.useState({ dirs: [], parent: null })
      const [error, setError] = React.useState('')

      const go = React.useCallback(async next => {
        try {
          const data = await jget('/dirs?path=' + encodeURIComponent(next || ''))
          setPath(data.path)
          setListing({ dirs: data.dirs || [], parent: data.parent })
          setError('')
        } catch (e) {
          setError(e.message)
        }
      }, [])

      React.useEffect(() => {
        if (open === true) go(typeof start === 'string' ? start : '')
      }, [open, start, go])

      return h(Modal, { open, onClose, title: '选这台机器上的主文件夹', closeLabel: '关闭' }, stack([
        note('主机能读的、相对路径能落到的，都在这个文件夹里。选一个项目目录就行。'),
        row([
          Button({ children: '上一级', disabled: listing.parent === null, onClick: () => go(listing.parent ?? path) }),
          h('div', {
            style: { flex: '1 1 240px', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, opacity: 0.8, wordBreak: 'break-all' },
          }, path || '…'),
        ]),
        error === '' ? null : note(error),
        stack(listing.dirs.map(name => h('div', { key: name },
          Button({ children: name, onClick: () => go(path.replace(/[\\/]+$/, '') + '/' + name) }),
        )), { maxHeight: 300, overflowY: 'auto', gap: 4 }),
        row([
          Button({ variant: 'primary', children: '就选这个文件夹', onClick: () => onPick(path) }),
          Button({ children: '取消', onClick: onClose }),
        ]),
      ]))
    }

    // ---- 连上之后弹的那一框：选群组 + 选主文件夹 ----
    // 这里的群来自主机的"授权表"：没授权过的群，主机根本不会把名字发过来。
    function JoinDialog({ open, join, onClose, onSaved, onRefresh }) {
      const available = React.useMemo(() => {
        const seen = new Set()
        const list = []
        for (const group of (join?.available ?? [])) {
          const id = idOf(group)
          if (id === '' || seen.has(id)) continue
          seen.add(id)
          list.push({ id, name: nameOf(group) })
        }
        return list
      }, [join?.available])

      const joined = React.useMemo(() => new Set((join?.groups ?? []).map(idOf)), [join?.groups])
      const [picked, setPicked] = React.useState([])
      const [folder, setFolder] = React.useState('')
      const [browsing, setBrowsing] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [refused, setRefused] = React.useState([])

      React.useEffect(() => {
        if (open !== true) return
        setError('')
        setRefused([])
        setPicked([])
        setFolder(join?.workspace ?? '')
        // 每次打开都问一次主机："现在允许我进哪些群" —— 授权是那边随时能改的。
        void Promise.resolve(onRefresh?.()).catch(() => {})
      }, [open])

      const reload = async () => {
        try {
          await jpost('/join/refresh')
          await Promise.resolve(onRefresh?.())
        } catch (e) {
          setError(e.message)
        }
      }

      const toggle = id => setPicked(prev => (prev.includes(id) ? prev.filter(each => each !== id) : [...prev, id]))

      const save = async () => {
        setBusy(true)
        setError('')
        setRefused([])
        try {
          if (folder.trim() !== '') {
            await jpost('/join/workspace', { path: folder.trim() })
          }
          if (picked.length > 0) {
            const result = await jpost('/join/wants', { groups: picked })
            if (Array.isArray(result.refused) && result.refused.length > 0) {
              setRefused(result.refused)
              setError('这几个群没进去：' + result.refused.map(each => each.name || each.id).join('、'))
              return
            }
          }
          if (typeof onSaved === 'function') onSaved()
          onClose()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }

      return h(React.Fragment, null,
        h(Modal, { open, onClose, title: '进哪个群？用哪个文件夹？', closeLabel: '关闭' }, stack([
          note('这台机器上的 Bot 会以成员身份出现在这些群里。主文件夹是主机能读、能跑命令的范围。'),
          row([
            title('群组'),
            Button({ children: '刷新', onClick: reload }),
          ]),
          available.length === 0
            ? note('主机还没有把任何群授权给这台机器。去主机那台机器的「远程节点」里点这台机器的「授权群组」，勾上要开的群，再回来点刷新。')
            : stack(available.map(group => h('div', {
              key: group.id,
              style: { display: 'flex', alignItems: 'center', gap: 8 },
            },
              Button({
                variant: picked.includes(group.id) ? 'primary' : undefined,
                children: (picked.includes(group.id) ? '✓ ' : '') + group.name,
                onClick: () => toggle(group.id),
              }),
              joined.has(group.id) ? Tag({ children: '已经在里面' }) : null,
            )), { maxHeight: 220, overflowY: 'auto', gap: 6 }),

          title('主文件夹'),
          row([
            Input({
              value: folder,
              placeholder: '例如 D:/work，留空就用启动时那个目录',
              onChange: event => setFolder(event.target.value),
              style: { flex: '1 1 260px' },
            }),
            Button({ children: '浏览…', onClick: () => setBrowsing(true) }),
          ]),

          error === '' ? null : note(error),
          refused.length === 0 ? null : note('被拒的群：' + refused.map(each => `${each.name || each.id}（${each.reason ?? '未知原因'}）`).join('、')),

          row([
            Button({ variant: 'primary', disabled: busy, children: busy ? '保存中…' : '保存', onClick: save }),
            Button({ children: '取消', onClick: onClose }),
          ]),
        ])),
        h(FolderPicker, {
          open: browsing,
          start: folder,
          onClose: () => setBrowsing(false),
          onPick: (path) => { setFolder(path); setBrowsing(false) },
        }),
      )
    }

    // ---- 加入端：往主机的群里说一句 ----
    function ChatBox({ join, act }) {
      const groups = join?.groups ?? []
      const [target, setTarget] = React.useState('')
      const [text, setText] = React.useState('')
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        if (target === '' && groups.length > 0) setTarget(idOf(groups[0]))
      }, [groups])

      const send = async () => {
        const body = text.trim()
        if (body === '') return
        const ok = await act('say', () => jpost('/say', { text: body, group: target }), () => setNotice('已发出去'))
        if (ok) setText('')
      }

      if (groups.length === 0) {
        return note('还没进任何群 —— 点上面的「选群组和文件夹」，进去之后这里就能直接说话。')
      }

      return stack([
        row(groups.map(group => h('div', { key: idOf(group) },
          Button({
            variant: target === idOf(group) ? 'primary' : undefined,
            children: nameOf(group),
            onClick: () => setTarget(idOf(group)),
          }),
        ))),
        row([
          Input({
            value: text,
            placeholder: '像在群里那样说一句，回车发送',
            onChange: event => setText(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter') void send() },
            style: { flex: '1 1 260px' },
          }),
          Button({ variant: 'primary', children: '发送', onClick: send }),
        ]),
        notice === '' ? null : note(notice),
      ])
    }

    // ---- 主机这边：一台连过来的机器 ----
    function NodeCard({ node, groups, busy, act, onRename }) {
      const [renaming, setRenaming] = React.useState(false)
      const [draft, setDraft] = React.useState(node.name)
      const [browsing, setBrowsing] = React.useState(false)
      const [listing, setListing] = React.useState({ path: '.', output: '', error: '' })
      const [notice, setNotice] = React.useState('')
      // 授权表：这台机器能进哪些群。默认空 —— 连上来不等于能进任何群。
      const [allowing, setAllowing] = React.useState(false)
      const [allowed, setAllowed] = React.useState([])

      React.useEffect(() => { setDraft(node.name) }, [node.name])
      React.useEffect(() => {
        if (notice === '') return undefined
        const timer = setTimeout(() => setNotice(''), 3000)
        return () => clearTimeout(timer)
      }, [notice])

      const joined = (node.groups || []).map(group => (
        typeof group === 'string' ? { id: group, name: group } : group
      ))

      const saveName = async () => {
        const name = String(draft || '').trim()
        setRenaming(false)
        if (name === '' || name === node.name) return
        await onRename(node.id, name)
      }

      // 浏览那台机器的工作区：只是让它跑 list_dir，路径都相对它的主文件夹。
      const look = async (path) => {
        try {
          const data = await jpost('/fs', { node: node.id, op: 'list', path })
          setListing({ path, output: data.output ?? '', error: data.ok === false ? (data.error ?? '读不到') : '' })
        } catch (e) {
          setListing({ path, output: '', error: e.message })
        }
      }

      return stack([
        row([
          renaming
            ? Input({
              value: draft,
              autoFocus: true,
              onChange: event => setDraft(event.target.value),
              onBlur: saveName,
              onKeyDown: event => {
                if (event.key === 'Enter') void saveName()
                if (event.key === 'Escape') { setDraft(node.name); setRenaming(false) }
              },
              style: { width: 180 },
            })
            : Button({ children: node.name, onClick: () => setRenaming(true) }),
          node.status === 'online' ? Tag({ children: '在线' }) : Tag({ children: '离线' }),
          node.botName ? note('代表 Bot：' + node.botName) : null,
          h('div', { style: { marginLeft: 'auto' } },
            Button({
              children: busy === 'forget:' + node.id ? '移除中…' : '移除这台机器',
              onClick: () => act('forget:' + node.id, () => jpost('/forget', { node: node.id })),
            }),
          ),
        ]),

        row([
          note('工作区：'),
          node.workspace ? Tag({ children: node.workspace }) : note('还没报上来（那台机器没选文件夹，或版本旧）'),
          node.status === 'online' && node.workspace
            ? Button({ children: '浏览它的文件', onClick: () => { setBrowsing(true); void look('.') } })
            : null,
        ]),

        row([
          note('已授权：'),
          (node.allowed ?? []).length === 0
            ? note('还没授权任何群 —— 它进不去，也说不了话')
            : (node.allowed ?? []).map(group => h(Tag, { key: group.id, children: group.name })),
          Button({
            children: '授权群组',
            onClick: () => { setAllowed((node.allowed ?? []).map(group => group.id)); setAllowing(true) },
          }),
        ]),

        // 没配 agent 的机器：能干活但不会说话。提前说，别等它进群之后每轮报错。
        Array.isArray(node.caps) && node.caps.length > 0 && !node.caps.includes('agent')
          ? note('这台没配 agent：不会发言，只能接文件/命令。它在群里每一轮都会以「跑不了 turn」收场。')
          : null,

        row([
          h('select', {
            value: '',
            onChange: async event => {
              const groupId = event.target.value
              if (groupId === '') return
              const group = groups.find(each => each.id === groupId)
              const ok = await act('bind', () => jpost('/bind', { node: node.id, group: groupId }))
              if (ok) setNotice('已加入「' + (group?.name ?? groupId) + '」')
            },
            style: { maxWidth: 260 },
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
            style: { display: 'flex', alignItems: 'center', gap: 6 },
          },
            Tag({ children: '在：' + (group.name || group.id) }),
            Button({
              children: '退出',
              onClick: () => act('unbind', () => jpost('/unbind', { node: node.id, group: group.id })),
            }),
          )),
        ]),

        notice === '' ? null : note(notice),

        // 授权表。没勾的群：远端连名字都看不到，也进不去、说不了话。
        h(Modal, { open: allowing, onClose: () => setAllowing(false), title: `「${node.name}」能进哪些群`, closeLabel: '关闭' }, stack([
          note('没勾的群，这台机器看不到、进不去、也说不了话。取消授权会把它从那个群里移出去。'),
          groups.length === 0
            ? note('这台主机还没有群。')
            : stack(groups.map(group => h('div', {
              key: group.id,
              style: { display: 'flex', alignItems: 'center', gap: 8 },
            },
              Button({
                variant: allowed.includes(group.id) ? 'primary' : undefined,
                children: (allowed.includes(group.id) ? '✓ ' : '') + group.name,
                onClick: () => setAllowed(prev => (
                  prev.includes(group.id) ? prev.filter(each => each !== group.id) : [...prev, group.id]
                )),
              }),
            )), { maxHeight: 260, overflowY: 'auto', gap: 6 }),
          row([
            Button({
              variant: 'primary',
              disabled: busy === 'allow',
              children: busy === 'allow' ? '保存中…' : '保存',
              onClick: async () => {
                const ok = await act('allow', () => jpost('/allow', { node: node.id, groups: allowed }))
                if (ok) { setAllowing(false); setNotice('授权已更新') }
              },
            }),
            Button({ children: '取消', onClick: () => setAllowing(false) }),
          ]),
        ])),

        h(Modal, { open: browsing, onClose: () => setBrowsing(false), title: node.name + ' 的工作区', closeLabel: '关闭' }, stack([
          row([
            Button({ children: '上一级', onClick: () => look(listing.path.replace(/[\\/][^\\/]*$/, '') || '.') }),
            Button({ children: '回到根', onClick: () => look('.') }),
            h('div', {
              style: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, opacity: 0.8 },
            }, listing.path),
          ]),
          listing.error === '' ? null : note(listing.error),
          stack(String(listing.output || '').split('\n').filter(line => line !== '').map(line => {
            const isDir = line.endsWith('/')
            const name = isDir ? line.slice(0, -1) : line.split('\t')[0]
            return h('div', { key: line },
              isDir
                ? Button({
                  children: name + '/',
                  onClick: () => look(listing.path === '.' ? name : listing.path.replace(/[\\/]+$/, '') + '/' + name),
                })
                : h('div', {
                  style: { fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, monospace', opacity: 0.85 },
                }, line),
            )
          }), { maxHeight: 320, overflowY: 'auto', gap: 4 }),
        ])),
      ], { gap: 10 })
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [groups, setGroups] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [copied, setCopied] = React.useState(false)
      const [joinCode, setJoinCode] = React.useState('')
      const [joinAgent, setJoinAgent] = React.useState('')
      const [elevateScript, setElevateScript] = React.useState('')
      const [dialog, setDialog] = React.useState(false)
      const [autoOpened, setAutoOpened] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          // 群列表跟着 /status 一起回来：少一个"另一个口挂了整页空白"的失败点。
          // 配对码默认不随状态下发，设置页要显示就必须显式要。
      const status = await jget('/status?reveal=1')
          setState(status)
          setGroups(status.groups || [])
          setError('')
        } catch (e) {
          setError('读不到状态：' + e.message)
        }
      }, [])

      usePoll(refresh, 4000)

      // 连上的那一刻，把"选群组 + 选文件夹"这一框自动弹出来 —— 连接时该问的
      // 就那两件事。只自动弹一次，别每次轮询都盖上来。
      // 一个群都没授权时也弹：框里会写清楚"去主机那边授权"，比什么都不说好。
      React.useEffect(() => {
        const join = state?.join
        if (autoOpened) return
        if (join?.running === true) {
          setDialog(true)
          setAutoOpened(true)
        }
      }, [state, autoOpened])

      const act = async (name, fn, done) => {
        setBusy(name)
        try {
          const result = await fn()
          await refresh()
          if (typeof done === 'function') done(result)
          return true
        } catch (e) {
          setError(e.message)
          return false
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
      const net = state?.network
      const nodes = state?.nodes || []
      const join = state?.join

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 680 } },
        stack([
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '远程节点'),
          note('在另一台装了 DSH 的机器上装同一个插件，在它的「远程节点」里输入这个码。那台机器的 Bot 会进你的群，用它的算力和文件说话。'),
        ]),

        error === '' ? null : note(error),

        stack([
          note('配对码'),
          row([
            h('div', {
              style: { fontSize: 28, fontWeight: 700, letterSpacing: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
            }, code || '— — — — — —'),
            Button({ children: copied ? '已复制' : '复制', onClick: () => copy(code) }),
            Button({
              variant: 'primary',
              children: busy === 'rotate' ? '换码中…' : '换一个',
              onClick: () => act('rotate', () => jpost('/rotate')),
            }),
          ]),
          note(state?.hosting ? `正在等连接（端口 ${state.port}）` : '没有在监听 —— 端口被占或被防火墙拦了，换一个码再试'),
          note(net?.on
            ? `跨网已就绪（${net.ipv4 ?? net.name}）—— 换个网络也能连，对面输码就行`
            : net?.error
              ? `跨网没起来：${net.error}（同一个 WiFi 下照常用）`
              : '正在进虚拟网…'),
          net?.needsElevation
            ? row([
              Button({
                variant: 'primary',
                children: busy === 'elevate' ? '正在申请权限…' : '用管理员权限启动跨网',
                onClick: () => act('elevate', async () => {
                  const result = await jpost('/elevate')
                  if (typeof result?.script === 'string') setElevateScript(result.script)
                }),
              }),
              note('只提权 EasyTier，不重启 DSH，当前工作不中断'),
            ])
            : null,
          elevateScript === ''
            ? null
            : stack([
              note('这个进程弹不出权限确认窗口。已经准备好了脚本，右键用管理员身份跑一次就行：'),
              note(elevateScript),
              note('跑起来之后这一行会自己变成绿色，不用刷新。'),
            ]),
        ]),

        stack([
          title('加入别人的群'),
          row([
            Input({
              value: joinCode,
              placeholder: '对方那台的六位码',
              onChange: event => setJoinCode(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6)),
              style: { flex: '1 1 160px', letterSpacing: 3 },
            }),
            Button({
              variant: 'primary',
              children: busy === 'join' ? '连接中…' : '连过去',
              onClick: () => act('join', () => jpost('/join', { code: joinCode, agent: joinAgent, confirm: true })),
            }),
            join?.running
              ? Button({ children: busy === 'leave' ? '断开中…' : '断开', onClick: () => act('leave', () => jpost('/leave')) })
              : null,
          ]),
          Input({
            value: joinAgent,
            placeholder: '可选：跑一轮的命令（留空 = 直接用这台 DSH 已配好的模型，推荐）',
            onChange: event => setJoinAgent(event.target.value),
            style: { width: '100%' },
          }),
          join?.running
            ? stack([
              note(`已连上${join.hostName ? '：' + join.hostName : ''}${join.workspace ? '｜工作区 ' + join.workspace : ''}`),
              join.agentLabel
                ? note(`说话用：${join.agentLabel}`)
                : note('这台 DSH 没找到可用模型：主机能把文件/命令交给它，但它在群里不会说话。可以在上面填一个 agent 命令（例如 dsh -p）再重连。'),
              row([
                Button({ children: '选群组和文件夹', onClick: () => setDialog(true) }),
                note(join.error ? join.error : ''),
              ]),
              ChatBox({ join, act }),
            ])
            : join?.error
              ? note(join.error)
              : note('这台机器也可以去别人的群里：输入对方的码，连上之后会让你选群组和主文件夹。'),
        ]),

        h('div', { style: { fontSize: 13, fontWeight: 600 } }, '已连上的机器' + (nodes.length ? `（${nodes.length}）` : '')),
        nodes.length === 0
          ? note('还没有机器连过来')
          : stack(nodes.map(node => h(NodeCard, {
            key: node.id,
            node,
            groups,
            busy,
            act,
            onRename: (id, name) => act('rename', () => jpost('/rename', { node: id, name })),
          }))),

        h(JoinDialog, {
          open: dialog && join?.running === true,
          join,
          onClose: () => setDialog(false),
          onSaved: refresh,
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsbot-nodes', order: 42, label: '远程节点' },
          () => h(Boundary, null, h(Panel)),
        ))
      },
    }
  },
})

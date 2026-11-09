// Native plugin changes reevaluate this script; a var binding permits redeclaration.
/** Named arrangements use native intents, so moving retained tabs preserves their resources. */
var NuwaxLayoutPresets = class {
  constructor(sidebar, registry, storage, sessionId, guard = () => {}) {
    Object.assign(this, { sidebar, registry, storage, sessionId })
    this.guard = guard
    this.key = `nuwax-workbench:presets:v1:${sessionId}`
  }

  async read() {
    const raw = await this.storage.getItem(this.key)
    if (!raw) return { revision: null, items: [], locked: false }
    try {
      if (raw.length > 1024 * 1024) throw new Error()
      const value = JSON.parse(raw)
      if (
        typeof value.revision !== 'string' ||
        typeof value.locked !== 'boolean' ||
        !Array.isArray(value.items) ||
        value.items.length > 20
      )
        throw new Error()
      const names = new Set()
      for (const item of value.items) {
        this.name(item.name)
        if (names.has(item.name)) throw new Error()
        names.add(item.name)
        this.validate(item.arrangement)
      }
      return value
    } catch {
      throw new Error(
        'Saved workbench layouts are invalid; stored data was preserved'
      )
    }
  }

  name(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 80)
      throw new Error('A layout name of 1–80 characters is required')
  }

  layout() {
    const screen = this.sidebar.screen()
    if (screen?.sessionId !== this.sessionId)
      throw new Error('Workbench session changed')
    return screen.surface.layout
  }
  pane(tabId) {
    return Object.values(this.layout().nodes).find(
      (node) => node.kind === 'pane' && node.tabs.includes(tabId)
    )
  }

  capture() {
    const layout = this.layout()
    const tab = (id) => {
      const record = layout.tabs[id]
      const navigation = this.sidebar.tabDomain
        .occurrence(this.sessionId, { id })
        .navigation.getSnapshot()
      return {
        id,
        kind: record.kind,
        contentId: record.contentId,
        navigation,
      }
    }
    const pane = (node) => ({
      tabs: node.tabs.map(tab),
      activeTabId: node.activeTabId,
    })
    const root = layout.nodes[layout.rootId]
    const dock = (
      root.kind === 'split'
        ? root.children.map((id) => layout.nodes[id])
        : [root]
    ).map(pane)
    if (root.kind === 'split' && root.axis !== 'row')
      throw new Error('Unsupported DSH layout arrangement')
    const arrangement = JSON.parse(
      JSON.stringify({
        dock,
        sizes: root.kind === 'split' ? root.sizes : [1],
        floats: layout.floats.map((id) => ({
          ...pane(layout.nodes[id]),
          rect: layout.nodes[id].rect,
        })),
        expanded: layout.expanded,
        mode: layout.mode,
        activeTabId: layout.nodes[layout.activePaneId]?.activeTabId,
      })
    )
    this.validate(arrangement)
    return arrangement
  }

  validate(value) {
    if (
      !value ||
      !Array.isArray(value.dock) ||
      value.dock.length < 1 ||
      value.dock.length > 2 ||
      !Array.isArray(value.floats) ||
      value.floats.length > 20 ||
      !Array.isArray(value.sizes) ||
      value.sizes.length !== value.dock.length ||
      value.sizes.some((size) => !Number.isFinite(size) || size <= 0) ||
      typeof value.expanded !== 'boolean' ||
      !['push', 'fullscreen'].includes(value.mode) ||
      JSON.stringify(value).length > 40000
    )
      throw new Error('Invalid layout arrangement')
    const ids = new Set()
    for (const pane of [...value.dock, ...value.floats]) {
      if (
        !pane ||
        !Array.isArray(pane.tabs) ||
        pane.tabs.length > 40 ||
        (value.floats.includes(pane) && pane.tabs.length !== 1)
      )
        throw new Error('Invalid saved pane')
      for (const tab of pane.tabs) {
        if (
          !tab ||
          typeof tab.id !== 'string' ||
          !/^tab[1-9][0-9]*$/.test(tab.id) ||
          ids.has(tab.id) ||
          typeof tab.kind !== 'string' ||
          !tab.kind ||
          tab.kind.length > 160 ||
          typeof tab.contentId !== 'string' ||
          typeof tab.navigation?.address !== 'string' ||
          tab.navigation.address !== tab.contentId
        )
          throw new Error('Invalid saved panel')
        const address = tab.navigation.address
        if (
          !address.startsWith('sidebar://') &&
          !address.startsWith('dsh-resource://')
        )
          throw new Error('Invalid saved panel address')
        if (
          address.startsWith('dsh-resource://file/') &&
          !address.startsWith(
            `dsh-resource://file/session/${encodeURIComponent(this.sessionId)}/`
          )
        )
          throw new Error('Saved file belongs to another conversation')
        ids.add(tab.id)
      }
      if (
        pane.activeTabId &&
        !pane.tabs.some((tab) => tab.id === pane.activeTabId)
      )
        throw new Error('Invalid active panel')
      if (
        value.floats.includes(pane) &&
        (!pane.rect ||
          !['x', 'y', 'width', 'height'].every((key) =>
            Number.isFinite(pane.rect[key])
          ) ||
          pane.rect.width <= 0 ||
          pane.rect.height <= 0)
      )
        throw new Error('Invalid saved floating panel')
    }
    if (ids.size > 40 || (value.activeTabId && !ids.has(value.activeTabId)))
      throw new Error('Invalid layout panels')
  }

  async list() {
    const value = await this.read()
    return {
      revision: value.revision,
      locked: value.locked,
      items: value.items.map(({ name, updatedAt }) => ({ name, updatedAt })),
    }
  }

  async change(action, name, expectedRevision) {
    this.name(name)
    const value = await this.read()
    this.guard()
    if (expectedRevision !== value.revision)
      throw new Error('Saved layout revision conflict; list layouts again')
    const remaining = value.items.filter((item) => item.name !== name)
    if (action === 'save') {
      if (remaining.length >= 20)
        throw new Error('At most 20 layouts can be saved per conversation')
      remaining.push({
        name,
        updatedAt: new Date().toISOString(),
        arrangement: this.capture(),
      })
    } else if (action !== 'remove')
      throw new Error('Unknown saved layout action')
    else if (remaining.length === value.items.length)
      throw new Error('Saved layout not found')
    await this.storage.setItem(
      this.key,
      JSON.stringify({
        revision: crypto.randomUUID(),
        items: remaining,
        locked: value.locked,
      }),
      expectedRevision
    )
    return this.list()
  }

  async lock(locked, expectedRevision) {
    const value = await this.read()
    this.guard()
    if (expectedRevision !== value.revision)
      throw new Error('Saved layout revision conflict; list layouts again')
    await this.storage.setItem(
      this.key,
      JSON.stringify({ ...value, locked, revision: crypto.randomUUID() }),
      expectedRevision
    )
    return this.list()
  }

  async apply(name, expectedRevision) {
    const value = await this.read()
    this.guard()
    if (expectedRevision !== value.revision)
      throw new Error('Saved layout revision conflict; list layouts again')
    const saved = value.items.find((item) => item.name === name)?.arrangement
    if (!saved) throw new Error('Saved layout not found')
    const records = [...saved.dock, ...saved.floats].flatMap(
      (pane) => pane.tabs
    )
    // Check every dependency before the first native mutation.
    for (const tab of records) {
      if (!this.registry.get(tab.kind))
        throw new Error(`Saved panel plugin is unavailable: ${tab.kind}`)
      if (tab.navigation.address.startsWith('dsh-resource://'))
        this.registry.claim(tab.navigation.address, tab.kind)
    }
    const nativeActions = this.sidebar.actionsFor(this.sessionId)
    let commits = 0
    const mutate = (run) => {
      const previous = this.layout()
      try {
        return run()
      } finally {
        if (this.layout() !== previous) commits++
      }
    }
    const actions = new Proxy(nativeActions, {
      get(target, key) {
        const action = Reflect.get(target, key)
        return typeof action === 'function'
          ? (...args) => mutate(() => action.apply(target, args))
          : action
      },
    })
    const before = JSON.stringify(this.layout())
    try {
      const resolved = new Map()
      const dockPanes = () => {
        const layout = this.layout()
        const root = layout.nodes[layout.rootId]
        return root.kind === 'split'
          ? root.children.map((id) => layout.nodes[id])
          : [root]
      }
      const open = (tab, paneId) => {
        const options = {
          params: tab.navigation.params,
          paneId,
          revealIfOpened: false,
        }
        if (tab.navigation.address.startsWith('dsh-resource://'))
          mutate(() =>
            this.sidebar.openResourceIn(
              this.sessionId,
              tab.navigation.address,
              { ...options, kind: tab.kind }
            )
          )
        else
          mutate(() =>
            this.sidebar.openTabIn(this.sessionId, tab.kind, options)
          )
        const current = this.sidebar.active()
        if (!current || current.kind !== tab.kind)
          throw new Error('Saved panel did not open')
        return current
      }
      const root = dockPanes()[0]
      if (!root) throw new Error('No docked pane is available')
      if (saved.dock.length === 1) {
        // Native single-instance pages merge on arrival. Refuse a destructive consolidation.
        const pages = dockPanes()
          .flatMap((pane) => pane.tabs)
          .map((id) => this.layout().tabs[id])
          .filter((tab) => tab.contentId === `sidebar://${tab.kind}`)
        if (new Set(pages.map((tab) => tab.contentId)).size !== pages.length)
          throw new Error(
            'Restoring one column would merge existing duplicate pages'
          )
        for (const pane of dockPanes().slice(1))
          for (const id of [...pane.tabs])
            actions.dropTab(this.sessionId, id, root.id, 'center')
      } else if (dockPanes().length === 1) {
        if (!root.tabs.length) open(saved.dock[0].tabs[0], root.id)
        if (!mutate(() => this.sidebar.split(root.id)))
          throw new Error('DSH could not restore the saved split')
      }
      const paneIds = dockPanes().map((pane) => pane.id)
      for (const tab of records) {
        const group = saved.dock.findIndex((pane) =>
          pane.tabs.some((savedTab) => savedTab.id === tab.id)
        )
        const destination = group < 0 ? undefined : paneIds[group]
        const singlePage = tab.contentId === `sidebar://${tab.kind}`
        const available = Object.values(this.layout().tabs).filter(
          (record) => ![...resolved.values()].includes(record.id)
        )
        let existing =
          singlePage && destination
            ? available.find(
                (record) =>
                  record.kind === tab.kind &&
                  record.contentId === tab.contentId &&
                  this.pane(record.id)?.id === destination
              )
            : available.find(
                (record) =>
                  record.id === tab.id &&
                  record.kind === tab.kind &&
                  record.contentId === tab.contentId
              )
        if (!existing && !singlePage)
          existing = available.find(
            (record) =>
              record.kind === tab.kind && record.contentId === tab.contentId
          )
        if (
          !existing &&
          !singlePage &&
          tab.contentId.startsWith('sidebar://')
        ) {
          // Multi-instance pages receive fresh addresses when reopened, unlike resources.
          existing = available.find(
            (record) =>
              record.kind === tab.kind &&
              JSON.stringify(
                this.sidebar.tabDomain
                  .occurrence(this.sessionId, record)
                  .navigation.getSnapshot().params
              ) === JSON.stringify(tab.navigation.params)
          )
        }
        if (!existing) existing = open(tab, destination ?? root.id)
        resolved.set(tab.id, existing.id)
      }
      saved.dock.forEach((pane, index) => {
        pane.tabs.forEach((tab, position) =>
          actions.placeTab(
            this.sessionId,
            resolved.get(tab.id),
            paneIds[index],
            position
          )
        )
        if (pane.activeTabId)
          actions.focusTab(this.sessionId, resolved.get(pane.activeTabId))
      })
      const split = this.layout().nodes[this.layout().rootId]
      if (split.kind === 'split')
        actions.resizeSplit(this.sessionId, split.id, saved.sizes)
      for (const pane of saved.floats) {
        const id = resolved.get(pane.tabs[0].id)
        if (this.pane(id)?.host !== 'float')
          mutate(() => this.sidebar.float(id, pane.rect))
        const current = this.pane(id)
        if (current?.host !== 'float')
          throw new Error('DSH could not restore the floating panel')
        actions.resizeFloat(this.sessionId, current.id, pane.rect)
      }
      if (saved.activeTabId)
        actions.focusTab(this.sessionId, resolved.get(saved.activeTabId))
      actions.setMode(this.sessionId, saved.mode)
      actions.setExpanded(this.sessionId, saved.expanded)
      const beforeIds = Object.keys(JSON.parse(before).tabs)
      if (beforeIds.some((id) => !this.layout().tabs[id]))
        throw new Error('Restoring the layout would close an existing panel')
      if (new Set(resolved.values()).size !== records.length)
        throw new Error('DSH merged distinct saved panels')
      for (const [index, pane] of saved.dock.entries())
        for (const tab of pane.tabs) {
          if (this.pane(resolved.get(tab.id))?.id !== paneIds[index])
            throw new Error('Saved panel placement did not apply')
        }
      return {
        revision: value.revision,
        locked: value.locked,
        items: value.items.map(({ name, updatedAt }) => ({
          name,
          updatedAt,
        })),
      }
    } catch (error) {
      // Never undo entries belonging to the user before this restore attempt.
      while (commits-- > 0 && JSON.stringify(this.layout()) !== before) {
        const previous = this.layout()
        nativeActions.undo(this.sessionId)
        if (this.layout() === previous) break
      }
      const restored = JSON.stringify(this.layout()) === before
      throw new Error(
        `${error.message}; ${
          restored
            ? 'previous layout restored'
            : 'layout partially changed; inspect workbench_state'
        }`
      )
    }
  }
}

window.__ModuleLoader__.load({
  id: '@nuwax-ai/dsh-workbench',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    function BrowserPanel({ sessionId, useTabInfo, t }) {
      const { tab } = useTabInfo()
      const viewport = React.useRef(null)
      const [address, setAddress] = React.useState(
        tab.navigation.params?.url ?? 'about:blank'
      )
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [held, setHeld] = React.useState(false)
      const [ready, setReady] = React.useState(false)
      const views = globalThis.dshDesktop.browser.views
      const run = async (action) => {
        try {
          await action()
          setError('')
        } catch (failure) {
          setError(String(failure.message).slice(0, 500))
        }
      }
      React.useEffect(() => {
        let disposed = false
        const off = views.subscribe((value) => {
          if (
            value.botId === sessionId &&
            value.tabId === tab.id &&
            !disposed
          ) {
            setState(value)
            if (value.url) setAddress(value.url)
          }
        })
        void run(async () => {
          await views.create(sessionId, tab.id, tab.navigation.params?.url)
          if (disposed || tab.signal.aborted) {
            await views.close(sessionId, tab.id)
            return
          }
          const existing = (await views.sync(sessionId)).find(
            (value) => value.tabId === tab.id
          )
          setState(existing ?? null)
          setReady(true)
        })
        const closed = () => {
          void views.close(sessionId, tab.id).catch(() => {})
        }
        tab.signal.addEventListener('abort', closed, { once: true })
        return () => {
          disposed = true
          off()
          tab.signal.removeEventListener('abort', closed)
          void views.place(tab.id, null, false).catch(() => {})
        }
      }, [sessionId, tab.id, tab.signal])
      React.useLayoutEffect(() => {
        if (!ready || !viewport.current) return
        const place = () => {
          const rect = viewport.current?.getBoundingClientRect()
          if (rect)
            void views
              .place(
                tab.id,
                {
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                },
                tab.visible && rect.width > 0 && rect.height > 0
              )
              .catch(() => {})
        }
        const observer = new ResizeObserver(place)
        observer.observe(viewport.current)
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        place()
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
          void views.place(tab.id, null, false).catch(() => {})
        }
      }, [ready, tab.id, tab.visible])
      const button = (label, action) =>
        h(
          'button',
          {
            type: 'button',
            onClick: () => void run(action),
            style: {
              padding: '5px 9px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1, #9995)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            },
          },
          label
        )
      return h(
        'section',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minHeight: 0,
          },
        },
        h(
          'form',
          {
            style: {
              display: 'flex',
              gap: 6,
              padding: 8,
              alignItems: 'center',
            },
            onSubmit: (event) => {
              event.preventDefault()
              void run(() => views.navigate(sessionId, tab.id, address))
            },
          },
          button('←', () => views.command(sessionId, tab.id, 'back')),
          button('→', () => views.command(sessionId, tab.id, 'forward')),
          button(t('reload'), () => views.command(sessionId, tab.id, 'reload')),
          h('input', {
            'aria-label': t('address'),
            value: address,
            onChange: (event) => setAddress(event.target.value),
            style: {
              minWidth: 40,
              flex: 1,
              padding: 6,
              border: '1px solid var(--dsw-alias-border-l1, #9995)',
              borderRadius: 6,
              background: 'transparent',
              color: 'inherit',
            },
          }),
          button(held ? t('release') : t('takeover'), async () => {
            await views.hold(sessionId, !held)
            setHeld(!held)
          })
        ),
        error || state?.error
          ? h(
              'div',
              { role: 'alert', style: { padding: 8 } },
              error || state.error
            )
          : null,
        h('div', { ref: viewport, style: { flex: 1, minHeight: 0 } })
      )
    }
    return {
      name: 'nuwax-workbench',
      inject: [
        'sessions',
        'uiSession',
        'uiWorkspace',
        'sidebarRight',
        'sidebarRightTabs',
        'webTerminals',
        'layout',
        'slots',
        'locale',
      ],
      apply(ctx) {
        try {
          const bridge = globalThis.nuwaxWorkbench
          if (!bridge) return
          const namespace = 'nuwaxWorkbench'
          const t = ctx.locale.bind(namespace)
          ctx.effect(() =>
            ctx.locale.register(namespace, {
              en: {
                browser: 'Browser',
                address: 'Web address',
                reload: 'Reload',
                takeover: 'Take over',
                release: 'Allow Agent control',
                title: 'Nuwax workbench',
                conversation: 'Conversation',
                workspace: 'Workspace',
                files: 'Files',
                terminal: 'Terminal',
                openFromNuwax: 'Open the workbench from a Nuwax conversation.',
              },
              zh: {
                browser: '浏览器',
                address: '网页地址',
                reload: '刷新',
                takeover: '接管',
                release: '允许 Agent 操作',
                title: 'Nuwax 工作台',
                conversation: '会话',
                workspace: '工作区',
                files: '文件',
                terminal: '终端',
                openFromNuwax: '请从 Nuwax 会话打开工作台。',
              },
            })
          )
          ctx.effect(() =>
            ctx.locale.register('nuwaxWorkbenchLayout', {
              en: {
                lock: 'Lock Agent layout changes',
                unlock: 'Allow Agent layout changes',
                undo: 'Undo layout',
                redo: 'Redo layout',
              },
              zh: {
                lock: '锁定 Agent 布局调整',
                unlock: '允许 Agent 调整布局',
                undo: '撤销布局',
                redo: '重做布局',
              },
            })
          )
          const layoutText = ctx.locale.bind('nuwaxWorkbenchLayout')
          ctx.effect(() =>
            ctx.locale.register('nuwaxWorkbenchPresets', {
              en: {
                name: 'Layout name',
                select: 'Saved layout',
                save: 'Save layout',
                apply: 'Restore layout',
                remove: 'Delete layout',
              },
              zh: {
                name: '布局名称',
                select: '已保存布局',
                save: '保存布局',
                apply: '恢复布局',
                remove: '删除布局',
              },
            })
          )
          const presetText = ctx.locale.bind('nuwaxWorkbenchPresets')
          const presetStore = (sessionId = reference?.sessionId, guard) =>
            new NuwaxLayoutPresets(
              ctx.sidebarRight,
              ctx.sidebarRightTabs,
              {
                getItem: () => bridge.readLayouts(sessionId),
                setItem: (_key, raw, revision) =>
                  bridge.writeLayouts(sessionId, revision, raw),
              },
              sessionId,
              guard
            )
          const layoutVersions = new Map()
          const readLayout = () => {
            if (
              !reference ||
              ctx.sidebarRight.mounted.getSnapshot() !== reference.sessionId
            )
              return null
            // This adapter targets the pinned DSH 0.2.1-rc.5 controller/store contract.
            const screen = ctx.sidebarRight.screen?.()
            const actions = ctx.sidebarRight.actionsFor?.(reference.sessionId)
            if (!screen?.surface?.layout || !actions?.undo || !actions?.dropTab)
              throw new Error('Unsupported DSH layout adapter')
            const layout = screen.surface.layout
            const key = `nuwax-workbench:layout-lock:${reference.sessionId}`
            const locked = localStorage.getItem(key) === 'true'
            let version = layoutVersions.get(reference.sessionId)
            if (
              !version ||
              version.layout !== layout ||
              version.locked !== locked
            ) {
              version = { layout, locked, id: crypto.randomUUID() }
              layoutVersions.set(reference.sessionId, version)
            }
            return { version: version.id, locked, layout, actions }
          }
          let binding = null
          const bindingListeners = new Set()
          const subscribeBinding = (listener) => {
            bindingListeners.add(listener)
            return () => bindingListeners.delete(listener)
          }
          const readBinding = () => binding
          function WorkspaceSummary({ sessionId, t }) {
            const current = React.useSyncExternalStore(
              subscribeBinding,
              readBinding
            )
            return h(
              'section',
              {
                style: {
                  padding: 24,
                  overflow: 'auto',
                  height: '100%',
                  boxSizing: 'border-box',
                },
              },
              h(
                'h1',
                { style: { fontSize: 22, margin: '0 0 24px' } },
                t('title')
              ),
              current && current.sessionId === sessionId
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'dl',
                      {
                        style: {
                          display: 'grid',
                          gridTemplateColumns: 'auto 1fr',
                          gap: 12,
                          overflowWrap: 'anywhere',
                        },
                      },
                      h('dt', null, t('conversation')),
                      h('dd', { style: { margin: 0 } }, current.conversationId),
                      h('dt', null, t('workspace')),
                      h('dd', { style: { margin: 0 } }, current.cwd)
                    ),
                    h(
                      'div',
                      {
                        style: {
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 12,
                          marginTop: 24,
                        },
                      },
                      ...['files', 'terminal', 'browser'].map((kind) =>
                        h(
                          'button',
                          {
                            key: kind,
                            onClick: () =>
                              ctx.sidebarRight.openTabIn(sessionId, kind),
                            style: {
                              padding: '8px 16px',
                              color: 'inherit',
                              background: 'transparent',
                              border: '1px solid #8886',
                              borderRadius: 8,
                              cursor: 'pointer',
                            },
                          },
                          t(kind)
                        )
                      )
                    ),
                    h(LayoutControls, { sessionId }),
                    h(PresetControls, { key: sessionId, sessionId })
                  )
                : h('p', null, t('openFromNuwax'))
            )
          }
          function LayoutControls({ sessionId }) {
            const [error, setError] = React.useState('')
            const [locked, setLocked] = React.useState(
              localStorage.getItem(
                `nuwax-workbench:layout-lock:${sessionId}`
              ) === 'true'
            )
            const button = (label, action) =>
              h(
                'button',
                {
                  type: 'button',
                  onClick: action,
                  style: {
                    padding: 8,
                    border: '1px solid #8886',
                    borderRadius: 8,
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                  },
                },
                label
              )
            return h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 12,
                  marginTop: 16,
                },
              },
              button(layoutText(locked ? 'unlock' : 'lock'), async () => {
                try {
                  const catalog = await presetStore(sessionId).list()
                  await execute(
                    {
                      operation: 'lock',
                      input: {
                        sessionId,
                        actor: 'user',
                        locked: !locked,
                        expectedRevision: catalog.revision,
                      },
                    },
                    new AbortController()
                  )
                  setLocked(!locked)
                  setError('')
                } catch (failure) {
                  setError(failure.message)
                }
              }),
              button(layoutText('undo'), () =>
                ctx.sidebarRight.actionsFor(sessionId)?.undo(sessionId)
              ),
              button(layoutText('redo'), () =>
                ctx.sidebarRight.actionsFor(sessionId)?.redo(sessionId)
              ),
              error ? h('div', { role: 'alert' }, error) : null
            )
          }
          function PresetControls({ sessionId }) {
            const [name, setName] = React.useState('')
            const [catalog, setCatalog] = React.useState({
              revision: null,
              items: [],
            })
            const [error, setError] = React.useState('')
            const refresh = async () => {
              try {
                setCatalog(await presetStore(sessionId).list())
                setError('')
              } catch (failure) {
                setError(failure.message)
              }
            }
            React.useEffect(() => {
              refresh()
              presetListeners.add(refresh)
              return () => {
                presetListeners.delete(refresh)
              }
            }, [])
            const run = async (action) => {
              try {
                await execute(
                  {
                    operation: 'preset',
                    input: {
                      sessionId,
                      actor: 'user',
                      action,
                      name,
                      expectedRevision: catalog.revision,
                    },
                  },
                  new AbortController()
                )
                setError('')
              } catch (failure) {
                await refresh()
                setError(failure.message)
              }
            }
            return h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  marginTop: 16,
                },
              },
              h('input', {
                'aria-label': presetText('name'),
                placeholder: presetText('name'),
                value: name,
                maxLength: 80,
                onChange: (event) => setName(event.target.value),
              }),
              h(
                'select',
                {
                  'aria-label': presetText('select'),
                  value: catalog.items.some((item) => item.name === name)
                    ? name
                    : '',
                  onChange: (event) => setName(event.target.value),
                },
                h('option', { value: '' }, presetText('select')),
                ...catalog.items.map((item) =>
                  h('option', { key: item.name, value: item.name }, item.name)
                )
              ),
              ...['save', 'apply', 'remove'].map((action) =>
                h(
                  'button',
                  {
                    key: action,
                    type: 'button',
                    disabled: !name.trim(),
                    onClick: () => void run(action),
                  },
                  presetText(action)
                )
              ),
              error
                ? h('div', { role: 'alert', style: { width: '100%' } }, error)
                : null
            )
          }
          ctx.effect(() =>
            ctx.slots.inject('main.conversation', () =>
              ctx.slots.register(
                {
                  name: 'main.conversation',
                  locale: namespace,
                  priority: -100,
                },
                WorkspaceSummary
              )
            )
          )
          const browserId = '@nuwax-ai/dsh-workbench/browser'
          ctx.effect(() =>
            ctx.sidebarRightTabs.register({
              id: browserId,
              kind: 'browser',
              multiple: true,
              keepMounted: true,
              priority: 'extension',
              title: () => t('browser'),
              guide: [{ id: 'new', order: 30, title: () => t('browser') }],
            })
          )
          ctx.effect(() =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: browserId,
                  locale: namespace,
                },
                BrowserPanel
              )
            )
          )
          let reference
          let generation = 0
          const pending = new Map()
          const presetListeners = new Set()
          const snapshot = () => {
            const layout = readLayout()
            return {
              sessionId: reference?.sessionId ?? null,
              expanded: ctx.sidebarRight.isExpanded(),
              tabs: ctx.sidebarRight.openTabs
                .getSnapshot()
                .filter((tab) => tab.sessionId === reference?.sessionId),
              components: ctx.sidebarRightTabs.entries().map((entry) => ({
                id: entry.id,
                kind: entry.kind,
                multiple: entry.multiple === true,
              })),
              layoutVersion: layout?.version ?? null,
              layoutLocked: layout?.locked ?? false,
              layout: layout ? JSON.parse(JSON.stringify(layout.layout)) : null,
              placements: ['right', 'split', 'float'],
              layoutCapabilities: {
                dockZones: ['center', 'left', 'right'],
                maxDockPanes: 2,
              },
            }
          }
          const execute = async (request, abort) => {
            if (request.operation === 'bind') {
              const epoch = ++generation
              await ctx.sessions.refresh()
              const next = ctx.sessions.retain(request.input.sessionId, {
                source: 'workspaceOperation',
                signal: abort.signal,
              })
              try {
                await next.ready
                if (epoch !== generation || abort.signal.aborted)
                  throw new Error('Workbench navigation superseded')
                reference?.release()
                reference = next
                ctx.uiWorkspace.openSession(next.sessionId)
                await new Promise((resolve, reject) => {
                  const cleanup = () => {
                    off()
                    clearTimeout(timer)
                    abort.signal.removeEventListener('abort', canceled)
                  }
                  const check = () => {
                    if (
                      ctx.sidebarRight.mounted.getSnapshot() === next.sessionId
                    ) {
                      cleanup()
                      resolve()
                    }
                  }
                  const canceled = () => {
                    cleanup()
                    reject(new Error('Workbench navigation canceled'))
                  }
                  const off = ctx.sidebarRight.mounted.subscribe(check)
                  const timer = setTimeout(() => {
                    cleanup()
                    reject(new Error('Workbench session did not mount'))
                  }, 15000)
                  abort.signal.addEventListener('abort', canceled, {
                    once: true,
                  })
                  check()
                })
                await new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve))
                )
                abort.signal.throwIfAborted()
                const catalog = await presetStore(next.sessionId).list()
                abort.signal.throwIfAborted()
                if (epoch !== generation)
                  throw new Error('Workbench navigation superseded')
                localStorage.setItem(
                  `nuwax-workbench:layout-lock:${next.sessionId}`,
                  String(catalog.locked)
                )
                binding = request.input
                for (const listener of bindingListeners) listener()
              } catch (error) {
                if (reference === next) {
                  reference = undefined
                  binding = null
                }
                next.release()
                throw error
              }
              ctx.layout.selectPanel(null)
              return snapshot()
            }
            if (
              !reference ||
              reference.sessionId !== request.input.sessionId ||
              ctx.sidebarRight.mounted.getSnapshot() !== reference.sessionId
            )
              throw new Error('Workbench session changed')
            if (request.operation === 'state') return snapshot()
            if (request.operation === 'lock') {
              if (
                request.input.actor !== 'user' ||
                typeof request.input.locked !== 'boolean'
              )
                throw new Error('Only the user can change the layout lock')
              const sessionId = reference.sessionId
              const result = await presetStore(sessionId).lock(
                request.input.locked,
                request.input.expectedRevision
              )
              localStorage.setItem(
                `nuwax-workbench:layout-lock:${sessionId}`,
                String(result.locked)
              )
              for (const listener of presetListeners) listener()
              return result
            }
            if (
              request.operation === 'preset' &&
              request.input.action === 'list'
            )
              return presetStore().list()
            if (request.operation === 'terminal') {
              const tab = snapshot().tabs.find(
                (tab) =>
                  tab.tabId === request.input.tabId && tab.kind === 'terminal'
              )
              if (!tab)
                throw new Error(
                  'Terminal tab does not belong to this conversation'
                )
              const navigation = ctx.sidebarRight.tabDomain
                .occurrence(reference.sessionId, { id: tab.tabId })
                .navigation.getSnapshot()
              const params = navigation.params ?? {}
              const view = ctx.webTerminals.view(
                reference.sessionId,
                tab.tabId,
                navigation.address,
                params.terminalId,
                params.shellPath
              )
              if (request.input.action === 'write') {
                if (!view.state.getSnapshot().writable)
                  throw new Error('Terminal is not ready for input')
                view.write(request.input.data)
              } else if (request.input.action !== 'state')
                throw new Error('Unknown terminal action')
              const state = view.state.getSnapshot()
              return {
                phase: state.phase,
                writable: state.writable,
                cwd: state.environment?.cwd,
                info: state.info,
                error: state.error,
              }
            }
            const layout = readLayout()
            if (request.input.actor !== 'user') {
              if (layout.locked)
                throw new Error('The user has locked Agent layout changes')
              if (request.input.expectedVersion !== layout.version)
                throw new Error(
                  'Layout version conflict; read workbench_state again'
                )
            }
            if (request.operation === 'preset') {
              const sessionId = reference.sessionId
              const store = presetStore(sessionId, () => {
                abort.signal.throwIfAborted()
                if (reference?.sessionId !== sessionId)
                  throw new Error('Workbench session changed')
                if (
                  request.input.actor !== 'user' &&
                  readLayout()?.version !== layout.version
                )
                  throw new Error(
                    'Layout version conflict; read workbench_state again'
                  )
              })
              const input = request.input
              const presets =
                input.action === 'apply'
                  ? await store.apply(input.name, input.expectedRevision)
                  : await store.change(
                      input.action,
                      input.name,
                      input.expectedRevision
                    )
              for (const listener of presetListeners) listener()
              return { ...snapshot(), presets }
            } else if (request.operation === 'open') {
              ctx.sidebarRight.openTabIn(
                reference.sessionId,
                request.input.kind,
                { params: request.input.params ?? {} }
              )
            } else if (request.operation === 'open-file') {
              const parts = String(request.input.path)
                .replace(/\\/g, '/')
                .split('/')
              if (
                parts.some(
                  (part) =>
                    !part ||
                    part === '..' ||
                    part === '.' ||
                    part.includes(':') ||
                    part.includes('\0')
                )
              )
                throw new Error('A workspace-relative file is required')
              ctx.sidebarRight.openResourceIn(
                reference.sessionId,
                `dsh-resource://file/session/${encodeURIComponent(
                  reference.sessionId
                )}/${parts.map(encodeURIComponent).join('/')}`
              )
            } else if (request.operation === 'close') {
              if (!layout.layout.tabs[request.input.tabId])
                throw new Error('Panel does not belong to this conversation')
              ctx.sidebarRight.closeIn(reference.sessionId, request.input.tabId)
              if (readLayout().layout.tabs[request.input.tabId])
                throw new Error('DSH did not close this panel')
            } else if (request.operation === 'visibility') {
              if (ctx.sidebarRight.isExpanded() !== request.input.visible)
                ctx.sidebarRight.toggleExpanded()
            } else if (request.operation === 'layout') {
              const input = request.input
              const actions = layout.actions
              const sessionId = reference.sessionId
              const tab = input.tabId && layout.layout.tabs[input.tabId]
              const pane = input.paneId && layout.layout.nodes[input.paneId]
              if (['float', 'move'].includes(input.action) && !tab)
                throw new Error('Panel does not belong to this conversation')
              if (
                ['dock', 'move', 'resize', 'split'].includes(input.action) &&
                input.paneId &&
                pane?.kind !== 'pane'
              )
                throw new Error('Pane does not belong to this conversation')
              if (['dock', 'move', 'resize'].includes(input.action) && !pane)
                throw new Error('A paneId is required')
              if (
                input.action === 'move' &&
                !['center', 'left', 'right'].includes(input.zone)
              )
                throw new Error(
                  'This DSH version supports center, left and right placement only'
                )
              if (
                input.action === 'resize' &&
                (!input.rect || pane.host !== 'float')
              )
                throw new Error('A floating pane and rectangle are required')
              if (input.action === 'dock' && pane.host !== 'float')
                throw new Error('Pane is already docked')
              if (
                input.action === 'resize-split' &&
                (layout.layout.nodes[input.splitId]?.kind !== 'split' ||
                  !Array.isArray(input.sizes) ||
                  input.sizes.length !== 2 ||
                  input.sizes.some(
                    (size) => !Number.isFinite(size) || size < 0.2 || size > 0.8
                  ) ||
                  Math.abs(
                    input.sizes.reduce((sum, size) => sum + size, 0) - 1
                  ) > 0.001)
              )
                throw new Error(
                  'A splitId and two ratios totaling one are required'
                )
              if (
                input.rect &&
                (!['x', 'y', 'width', 'height'].every((key) =>
                  Number.isFinite(input.rect[key])
                ) ||
                  input.rect.width <= 0 ||
                  input.rect.height <= 0)
              )
                throw new Error('Invalid panel rectangle')
              if (input.action === 'float')
                ctx.sidebarRight.float(input.tabId, input.rect)
              else if (input.action === 'dock')
                ctx.sidebarRight.dock(input.paneId)
              else if (input.action === 'move')
                actions.dropTab(
                  sessionId,
                  input.tabId,
                  input.paneId,
                  input.zone
                )
              else if (input.action === 'resize')
                actions.resizeFloat(sessionId, input.paneId, input.rect)
              else if (input.action === 'resize-split')
                actions.resizeSplit(sessionId, input.splitId, input.sizes)
              else if (input.action === 'split') {
                if (!ctx.sidebarRight.split(input.paneId))
                  throw new Error(
                    'DSH could not split this pane: check its room and pane limit'
                  )
              } else if (input.action === 'undo') actions.undo(sessionId)
              else if (input.action === 'redo') actions.redo(sessionId)
              else throw new Error('Unknown layout action')
              return {
                ...snapshot(),
                changed: readLayout().layout !== layout.layout,
              }
            } else throw new Error('Unknown workbench operation')
            return snapshot()
          }
          ctx.effect(() =>
            ctx.reflect.provide('nuwaxWorkbench', {
              state: snapshot,
              command: (operation, input = {}) => {
                if (
                  ![
                    'state',
                    'open',
                    'open-file',
                    'close',
                    'visibility',
                    'layout',
                    'preset',
                  ].includes(operation)
                )
                  throw new Error('Unknown workbench command')
                return execute(
                  {
                    operation,
                    input: { ...input, sessionId: reference?.sessionId },
                  },
                  new AbortController()
                )
              },
            })
          )
          ctx.effect(() =>
            bridge.onCommand(async (request) => {
              if (request.operation === 'cancel') {
                pending.get(request.id)?.abort()
                return
              }
              const abort = new AbortController()
              pending.set(request.id, abort)
              try {
                await bridge.reply(request.id, {
                  ok: true,
                  value: await execute(request, abort),
                })
              } catch (error) {
                await bridge
                  .reply(request.id, {
                    ok: false,
                    error: String(error.message).slice(0, 500),
                  })
                  .catch(() => {})
              } finally {
                pending.delete(request.id)
              }
            })
          )
          ctx.effect(() => () => {
            generation++
            for (const abort of pending.values()) abort.abort()
            reference?.release()
            void bridge.closed().catch(() => {})
          })
          void bridge.ready().catch(() => {})
        } catch (error) {
          console.error(
            'Nuwax workbench Client initialization failed',
            error.message
          )
          throw error
        }
      },
    }
  },
})

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
                    h(LayoutControls, { sessionId })
                  )
                : h('p', null, t('openFromNuwax'))
            )
          }
          function LayoutControls({ sessionId }) {
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
              button(layoutText(locked ? 'unlock' : 'lock'), () => {
                localStorage.setItem(
                  `nuwax-workbench:layout-lock:${sessionId}`,
                  String(!locked)
                )
                setLocked(!locked)
              }),
              button(layoutText('undo'), () =>
                ctx.sidebarRight.actionsFor(sessionId)?.undo(sessionId)
              ),
              button(layoutText('redo'), () =>
                ctx.sidebarRight.actionsFor(sessionId)?.redo(sessionId)
              )
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
          const snapshot = () => {
            const layout = readLayout()
            return {
              sessionId: reference?.sessionId ?? null,
              expanded: ctx.sidebarRight.isExpanded(),
              tabs: ctx.sidebarRight.openTabs
                .getSnapshot()
                .filter((tab) => tab.sessionId === reference?.sessionId),
              components: ctx.sidebarRightTabs
                .entries()
                .map((entry) => ({
                  id: entry.id,
                  kind: entry.kind,
                  multiple: entry.multiple === true,
                })),
              layoutVersion: layout?.version ?? null,
              layoutLocked: layout?.locked ?? false,
              layout: layout ? JSON.parse(JSON.stringify(layout.layout)) : null,
              placements: ['right', 'split', 'float'],
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
                binding = request.input
                for (const listener of bindingListeners) listener()
              } catch (error) {
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
            if (request.operation === 'open') {
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
              ctx.sidebarRight.closeIn(reference.sessionId, request.input.tabId)
            } else if (request.operation === 'visibility') {
              if (ctx.sidebarRight.isExpanded() !== request.input.visible)
                ctx.sidebarRight.toggleExpanded()
            } else if (request.operation === 'layout') {
              const input = request.input
              const actions = layout.actions
              const sessionId = reference.sessionId
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
              else if (input.action === 'split')
                ctx.sidebarRight.split(input.paneId)
              else if (input.action === 'undo') actions.undo(sessionId)
              else if (input.action === 'redo') actions.redo(sessionId)
              else throw new Error('Unknown layout action')
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

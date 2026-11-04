import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserState } from '@shared/features/browser/contract';
const h = vi.hoisted(() => ({ apply: vi.fn(), dispose: vi.fn() }));
vi.mock('./toolbar.css', () => ({}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });
it('applies only toolbar snapshots, ignores a stale initial read, and disposes on close', async () => {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { title: '', textContent: '', value: '', hidden: false,
      setAttribute: vi.fn(), toggleAttribute: vi.fn(), addEventListener: vi.fn(), focus: vi.fn(), select: vi.fn() });
    return nodes.get(id);
  };
  const events = new Map<string, () => void>();
  let notify!: (state: BrowserState) => void;
  let read!: (state: BrowserState) => void;
  const unsubscribe = vi.fn();
  const bridge = { command: vi.fn().mockResolvedValue(true),
    onState: (listener: typeof notify) => { notify = listener; return unsubscribe; },
    getState: () => new Promise<BrowserState>(resolve => { read = resolve; }) };
  const doc = { documentElement: { style: { setProperty: vi.fn() } }, body: { classList: { toggle: vi.fn() }, dataset: {} },
    getElementById: node, activeElement: null, title: '' };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { browserWindow: bridge, addEventListener: (name: string, callback: () => void) => events.set(name, callback) });
  const {startBrowserToolbar} = await import('./toolbar');
  await startBrowserToolbar(() => h as never);
  const state = (revision: number) => ({ title: `revision ${revision}`, platform: 'darwin', labels: {},
    themeSnapshot: { revision, mode: 'dark' } } as unknown as BrowserState);
  notify(state(2)); read(state(1)); await Promise.resolve();
  expect(h.apply).toHaveBeenCalledTimes(1);
  expect(h.apply).toHaveBeenCalledWith(state(2).themeSnapshot);
  expect(doc.title).toBe('revision 2');
  expect(doc.body.dataset).toMatchObject({ theme: 'dark' });
  for (const [id, part] of [['toolbar', 'browser-toolbar'], ['address', 'browser-address'], ['findbar', 'browser-find']])
    expect(node(id).setAttribute).toHaveBeenCalledWith('data-theme-part', part);
  events.get('unload')!(); notify(state(3));
  expect(unsubscribe).toHaveBeenCalledOnce(); expect(h.dispose).toHaveBeenCalledOnce();
  expect(h.apply).toHaveBeenCalledTimes(1);
});

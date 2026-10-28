/** Isolated Win/Linux menu fixture: real production toolbar, React and antd. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import TrafficLightToolbar from '@renderer/components/TrafficLightToolbar';
import '@renderer/index.css';

type CaptureCall = { action: string; visibleMenus: string[] };
declare global {
  interface Window {
    captureMenuFixture: { calls: CaptureCall[]; ready: boolean; errors: string[] };
    captureMenuDispatch: (action: string) => void;
  }
}

window.captureMenuFixture = { calls: [], ready: false, errors: [] };
window.addEventListener('error', event => window.captureMenuFixture.errors.push(event.message));
window.addEventListener('unhandledrejection', event => window.captureMenuFixture.errors.push(String(event.reason)));
const visibleMenus = () => Array.from(document.querySelectorAll<HTMLElement>('.topbar-app-menu'))
  .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
  .map(element => element.innerText);
const capture = (action: string) => window.captureMenuFixture.calls.push({ action, visibleMenus: visibleMenus() });
window.captureMenuDispatch = capture;
const noop = () => {};

// Deliberately inert bridge in this test window only. No app, filesystem or capture IPC.
(window as unknown as { electronAPI: unknown }).electronAPI = {
  on: noop,
  off: noop,
  window: { isMaximized: async () => false, minimize: noop, maximize: noop, close: noop },
  menu: { editAction: noop },
};

createRoot(document.getElementById('root')!).render(<>
  <TrafficLightToolbar
    menuCollapsed={false} menuAvailable={true} canGoBack={true} canGoForward={true}
    onToggleMenu={noop} onBack={noop} onForward={noop} onReload={noop}
    onOpenAbout={noop} onOpenSettingsMenu={noop} onNewTask={noop} onOpenSearch={noop}
    onModifyWorkspace={noop} onOpenWorkspace={noop} captureAvailable={true}
    onCapture={capture}
  />
  <main style={{ padding: '84px 36px', background: '#f8f9fa', height: '100vh' }}>
    <h1 style={{ fontSize: 24 }}>Nuwax · {/win/i.test(navigator.platform) ? 'Windows' : 'Linux'} 应用菜单验收</h1>
    <p>独立测试窗口 · 使用生产菜单组件 · 不连接账号或业务服务</p>
    <p>检查鼠标悬停切换、截图 / MP4 / GIF 入口及应用内快捷键。</p>
  </main>
</>);
requestAnimationFrame(() => requestAnimationFrame(() => { window.captureMenuFixture.ready = true; }));

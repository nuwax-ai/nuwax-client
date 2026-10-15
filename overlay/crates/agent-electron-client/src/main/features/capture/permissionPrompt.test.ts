import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  response: 0,
  calls: [] as string[],
  boxes: [] as Array<{ detail?: string; buttons?: string[] }>,
  release: null as null | (() => void),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/Applications/Nuwax.app/Contents/MacOS/Nuwax', getName: () => 'Nuwax' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  desktopCapturer: { getSources: vi.fn(async () => { mock.calls.push('request'); return []; }) },
  dialog: { showMessageBox: vi.fn(async (box: { detail?: string; buttons?: string[] }) => {
    mock.calls.push('dialog'); mock.boxes.push(box);
    if (mock.release === null) return { response: mock.response };
    await new Promise<void>((resolve) => { mock.release = resolve; });
    return { response: mock.response };
  }) },
  shell: { openExternal: vi.fn(async (url: string) => { mock.calls.push(url); }) },
}));
import { createScreenPermissionPrompt } from './permissionPrompt';

const labels = { title: 'T', detail: '开启「{0}」', openSettings: 'Open', cancel: 'Cancel' };
const log = { warn: vi.fn() };

beforeEach(() => { mock.response = 0; mock.calls.length = 0; mock.boxes.length = 0; mock.release = null; log.warn.mockClear(); });

describe('screen permission prompt', () => {
  it('requests capture once so the app is listed, names the listed app and opens the Screen Recording pane', async () => {
    await createScreenPermissionPrompt({ labels: () => labels, log })();
    expect(mock.calls).toEqual(['request', 'dialog', 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
    expect(mock.boxes[0]).toMatchObject({ detail: '开启「Nuwax」', buttons: ['Open', 'Cancel'] });
  });

  it('does nothing further when the user cancels', async () => {
    mock.response = 1;
    await createScreenPermissionPrompt({ labels: () => labels, log })();
    expect(mock.calls).toEqual(['request', 'dialog']);
  });

  it('shares one dialog between concurrent captures and allows a new one afterwards', async () => {
    mock.release = () => undefined;
    const prompt = createScreenPermissionPrompt({ labels: () => labels, log });
    const first = prompt(); const second = prompt();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(mock.calls).toContain('dialog'));
    mock.release!(); await first;
    mock.release = null; await prompt();
    expect(mock.calls.filter((call) => call === 'dialog')).toHaveLength(2);
  });
});

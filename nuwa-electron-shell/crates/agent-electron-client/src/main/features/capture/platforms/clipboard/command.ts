import { spawn } from 'node:child_process';
import type { RunClipboardCommand } from './types';

/** 固定程序与参数，不经过 shell；超时/会话失效时终止剪贴板子进程。 */
export const runClipboardCommand: RunClipboardCommand = ({ executable, args, input }, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('clipboard copy canceled')); return; }
  const child = spawn(executable, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, signal });
  const timer = setTimeout(() => { child.kill(); reject(new Error('clipboard copy timed out')); }, 15_000);
  timer.unref();
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => {
    clearTimeout(timer);
    if (code === 0 && !signal.aborted) resolve();
    else reject(new Error('file clipboard write failed'));
  });
  child.stdin.on('error', () => { /* 子进程退出时由 close/error 统一处理。 */ });
  child.stdin.end(input ?? '');
});

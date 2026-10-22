import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';

export function executableArchitecture(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, 64, 0) !== 64 || header.readUInt16LE(0) !== 0x5a4d) return null;
    const offset = header.readUInt32LE(60), pe = Buffer.alloc(6);
    if (offset < 64 || offset > fs.fstatSync(fd).size - 6 || fs.readSync(fd, pe, 0, 6, offset) !== 6 || pe.readUInt32LE(0) !== 0x4550) return null;
    return ({ 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' })[pe.readUInt16LE(4)] ?? 'unknown';
  } finally { fs.closeSync(fd); }
}

// Fail before opening test applications or starting model billing. Keep only a
// validated version and exit classification; startup logs can contain user paths.
export function probeAgentStartup(command, options = {}) {
  const { args = ['--version'], timeout = 30000, ...launch } = options;
  return new Promise(resolve => {
    execFile(command, args, { ...launch, encoding: 'utf8', timeout, maxBuffer: 4096, windowsHide: true, killSignal: 'SIGKILL' }, (error, stdout) => {
      const version = stdout.trim().match(/^(?:nuwaxcode\s+|v)?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/)?.[1];
      const exitCode = typeof error?.code === 'number' ? error.code >>> 0 : error ? null : 0;
      const passed = !error && !!version;
      resolve({ passed, exitCode, ...(passed ? { version } : { reason:
        error?.name === 'AbortError' ? 'runCancelled' : error?.killed ? 'agentStartupTimeout' :
        exitCode === 0xc0000005 ? 'agentStartupAccessViolation' : 'agentStartupFailed' }) });
    });
  });
}

/** ACP transport used by the same packaged nuwaxcode engine as the product.
 * Deliberately never writes prompts, screenshots, arguments or child logs. */
export class AcpPeer {
  constructor(command, args, options, onUpdate) {
    this.pending = new Map(); this.nextId = 0; this.buffer = ''; this.onUpdate = onUpdate;
    this.child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.on('error', () => this.fail('agentStartFailed'));
    this.child.on('exit', (code, signal) => { this.exit = { code, signal }; this.fail('agentExited'); });
    this.child.stdin.on('error', () => this.fail('agentPipeClosed'));
    this.child.stdout.on('data', bytes => {
      this.buffer += bytes.toString('utf8');
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) { this.fail('agentResponseTooLarge'); this.child.kill(); return; }
      while (this.buffer.includes('\n')) {
        const end = this.buffer.indexOf('\n'); const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.method === 'session/update') this.onUpdate?.(message.params);
        else if (message.method && message.id !== undefined) {
          // No terminal, filesystem, external network or human-answer shortcuts.
          const result = message.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : undefined;
          this.send(result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Benchmark client capability unavailable' } });
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error('agentRpcFailed')) : pending.resolve(message.result); }
        }
      }
    });
  }
  send(message) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('agentTimeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  fail(reason) { this.closed = reason; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); } this.pending.clear(); }
  async close() {
    this.fail('agentClosed');
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const done = new Promise(resolve => this.child.once('exit', resolve));
    this.child.kill(); const timer = setTimeout(() => this.child.kill('SIGKILL'), 2500);
    await done; clearTimeout(timer);
  }
}

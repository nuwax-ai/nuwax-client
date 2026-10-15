#!/usr/bin/env node
// 在 Windows 上强制运行 WinPTY 后端；不受宿主系统的 ConPTY 分支选择影响。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw new Error('Run this acceptance test on Windows');
const resources = path.resolve(process.argv[2] ?? 'nuwa-electron-shell/crates/agent-electron-client/resources/ttyd/legacy/win32-x64');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-terminal-2675-'));
const dirs = [path.join(temporary, '中文 工作区 A'), path.join(temporary, '中文 工作区 B')];
dirs.forEach(dir => fs.mkdirSync(dir));
const wrapper = path.join(temporary, 'terminal-wrapper.ps1');
fs.writeFileSync(wrapper, '\uFEFF' + `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
if ($Rest.Count -ne 2 -or $Rest[0] -ne '--cwd') { throw 'Expected --cwd' }
Set-Location -LiteralPath $Rest[1]
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
& $env:ComSpec /D /Q
`, 'utf8');
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const service = spawn(path.join(resources, 'ttyd-legacy.exe'), ['-p', String(port), '-i', '127.0.0.1', '-W', '-w', temporary, '-a', powershell, '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], { windowsHide: true });
let serviceLog = '';
service.stderr.on('data', data => { serviceLog += data.toString(); });
service.on('error', error => { serviceLog += error.stack; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (check, label, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}\n${serviceLog}`);
};
const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '');
const clients = [];
async function connect(dir) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?arg=--cwd&arg=${encodeURIComponent(dir)}`, 'tty');
  socket.binaryType = 'arraybuffer';
  const state = { socket, output: '', error: null };
  clients.push(state);
  socket.addEventListener('message', event => {
    const data = new Uint8Array(event.data);
    if (data[0] === 0x30) {
      try { state.output += new TextDecoder('utf8', { fatal: true }).decode(data.subarray(1)); }
      catch (error) { state.error = error; }
    }
  });
  socket.addEventListener('error', event => { state.error = event.error ?? new Error('WebSocket failed'); });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.send(JSON.stringify({ columns: 100, rows: 30 }));
  await waitFor(() => clean(state.output).includes(dir), 'shell prompt in requested directory');
  return state;
}
function command(client, text) {
  client.output = '';
  const bytes = Buffer.from(text + '\r', 'utf8');
  client.socket.send(Buffer.concat([Buffer.from('0'), bytes]));
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

try {
  await waitFor(() => serviceLog.includes('listening on'), 'WinPTY service startup');
  const first = await connect(dirs[0]);
  const second = await connect(dirs[1]);
  command(first, 'echo 中文回显2675');
  await waitFor(() => /(?:^|\n)中文回显2675\s*\n/.test(clean(first.output)), 'Chinese input/output');
  command(second, 'cd');
  await waitFor(() => clean(second.output).includes('\n' + dirs[1]), 'second session directory');
  first.socket.send('1' + JSON.stringify({ columns: 133, rows: 43 }));
  command(first, 'powershell -NoProfile -Command "Write-Output (\'__SIZE__=\'+[Console]::WindowWidth+\'x\'+[Console]::WindowHeight)"');
  await waitFor(() => clean(first.output).includes('__SIZE__=133x43'), 'terminal resize');
  command(first, `"${process.execPath}" -e "setInterval(()=>console.log('TICK_2675'),200)"`);
  await waitFor(() => /\nTICK_2675\s*\n/.test(clean(first.output)), 'long-running command');
  first.socket.send(Buffer.from('0\x03'));
  await delay(150);
  command(first, 'echo INTERRUPTED_2675');
  await waitFor(() => /\nINTERRUPTED_2675\s*\n/.test(clean(first.output)), 'Ctrl+C returns to shell');
  const pidFile = path.join(dirs[0], 'child.pid');
  command(first, `"${process.execPath}" -e "require('fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)"`);
  await waitFor(() => fs.existsSync(pidFile), 'session child process');
  const childPID = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(childPID));
  first.socket.close();
  await waitFor(() => !alive(childPID), 'disconnected session process cleanup');
  command(second, 'echo SECOND_ALIVE_2675');
  await waitFor(() => /\nSECOND_ALIVE_2675\s*\n/.test(clean(second.output)), 'other session stays alive');
  for (const client of clients) assert.equal(client.error, null);
  console.log(JSON.stringify({ ok: true, os: os.release(), backend: 'WinPTY 0.4.3', checks: ['Chinese UTF8', 'separate cwd with spaces', '133x43 resize', 'Ctrl+C', 'disconnect kills process tree', 'other session survives'] }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ serviceLog, terminals: clients.map(client => ({ output: clean(client.output), error: String(client.error) })) }, null, 2));
  throw error;
} finally {
  for (const client of clients) client.socket.close();
  if (service.exitCode === null) service.kill();
  await waitFor(() => service.exitCode !== null, 'service shutdown', 5000).catch(() => {});
  // 确认只清理本次服务所在目录对应的 agent，保留其他客户端的终端。
  const agentPath = path.join(resources, 'winpty-agent.exe').replaceAll("'", "''");
  const countAgents = () => Number(execFileSync(powershell, ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='winpty-agent.exe'" | Where-Object { $_.ExecutablePath -eq '${agentPath}' }).Count`], { encoding: 'utf8', windowsHide: true }).trim());
  await waitFor(() => countAgents() === 0, 'all compatibility agents exit', 5000);
  fs.rmSync(temporary, { recursive: true, force: true });
}

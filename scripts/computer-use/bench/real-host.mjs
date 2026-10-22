import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { startFixture } from './real-fixture.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function runtimeEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|OPENCODE|NUWAXCODE|ANTHROPIC|OPENAI|CODEX|CLAUDE|^CUA_MODEL/i.test(key)));
}

function windowsPids(name, visible = false) {
  const script = `@(Get-Process -Name '${name}' -ErrorAction SilentlyContinue ${visible ? '| Where-Object {$_.MainWindowHandle -ne 0}' : ''}).Id | ConvertTo-Json -Compress`;
  try { const ids = JSON.parse(execFileSync('powershell.exe', ['-NoProfile','-Command',script], { encoding: 'utf8', windowsHide: true })); return Array.isArray(ids) ? ids : [ids]; } catch { return []; }
}

async function backgroundAnchor(root) {
  // A runner-owned window establishes the background test condition. No user
  // application is activated, and the agent never receives this window's ID.
  const ready = path.join(root, 'anchor-ready');
  // Windows denies SetForegroundWindow to background processes, which is why a plain
  // Form.Activate() never took foreground on the VM and tasks were blocked with the
  // target still in front: attach to the foreground thread first, then take over, and
  // only report ready once GetForegroundWindow() actually holds this window.
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class BenchAnchor { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint procId); [DllImport("user32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach); }'; $f=New-Object System.Windows.Forms.Form; $f.Text='Nuwax Computer Use benchmark'; $f.Width=360; $f.Height=150; $f.TopMost=$true; $l=New-Object System.Windows.Forms.Label; $l.Dock='Fill'; $l.Text='Computer Use benchmark running. Please leave the test windows in the background.'; $f.Controls.Add($l); $timer=New-Object System.Windows.Forms.Timer; $timer.Interval=250; $script:ticks=0; $script:held=0; $timer.Add_Tick({ if([BenchAnchor]::GetForegroundWindow() -eq $f.Handle){$script:held++} else { $script:held=0; $script:ticks++; [void]$f.Activate(); $fg=[BenchAnchor]::GetForegroundWindow(); $fgOwner=[uint32]0; $fgThread=[BenchAnchor]::GetWindowThreadProcessId($fg,[ref]$fgOwner); $myThread=[BenchAnchor]::GetCurrentThreadId(); if($fgThread -ne 0 -and $fgThread -ne $myThread){[void][BenchAnchor]::AttachThreadInput($myThread,$fgThread,$true); [void][BenchAnchor]::SetForegroundWindow($f.Handle); [void][BenchAnchor]::AttachThreadInput($myThread,$fgThread,$false)}; if([BenchAnchor]::GetForegroundWindow() -eq $f.Handle){$script:held=1} }; if($script:held -ge 2){$timer.Stop(); [IO.File]::WriteAllText('${ready.replaceAll("'", "''")}','ready')} elseif($script:ticks -ge 40){$timer.Stop(); [IO.File]::WriteAllText('${ready.replaceAll("'", "''")}','failed'); $f.Close()} }); $f.Add_Shown({$timer.Start()}); [System.Windows.Forms.Application]::Run($f)`;
  const child = process.platform === 'darwin'
    ? spawn('swift', [fileURLToPath(new URL('./real-anchor.swift', import.meta.url)), ready], { stdio: 'ignore' })
    : spawn('powershell.exe', ['-NoProfile','-STA','-EncodedCommand',Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  for (let i = 0; i < 150 && !fs.existsSync(ready); i++) await sleep(100);
  const state = fs.existsSync(ready) ? fs.readFileSync(ready, 'utf8').trim() : '';
  if (state !== 'ready') { child.kill(); throw new Error('backgroundAnchorUnavailable'); }
  return child;
}

export function checkInteractiveDesktop() {
  if (process.platform !== 'win32') return;
  const script = `$ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class BenchDesktop { [DllImport("wtsapi32.dll")] public static extern bool WTSQuerySessionInformation(IntPtr h, int session, int kind, out IntPtr data, out int size); [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p); [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool i, uint a); [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h); }'; $sid=(Get-Process -Id $PID).SessionId; $p=[IntPtr]::Zero; $n=0; $active=$false; if([BenchDesktop]::WTSQuerySessionInformation([IntPtr]::Zero,$sid,8,[ref]$p,[ref]$n)){ $active=([Runtime.InteropServices.Marshal]::ReadInt32($p) -eq 0); [BenchDesktop]::WTSFreeMemory($p) }; $desktop=[BenchDesktop]::OpenInputDesktop(0,$false,1); $ok=($sid -gt 0 -and $active -and $desktop -ne [IntPtr]::Zero); if($desktop -ne [IntPtr]::Zero){[BenchDesktop]::CloseDesktop($desktop)|Out-Null}; if($ok){'ready'}else{'unavailable'}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try { if (execFileSync('powershell.exe', ['-NoProfile','-EncodedCommand',encoded], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim() === 'ready') return; } catch {}
  throw new Error('interactiveDesktopUnavailable');
}

export async function startHelper(helper, root, runtime) {
  const app = helper.endsWith('.app') ? helper : null;
  const binary = app ? path.join(app, 'Contents/MacOS/Nuwax Computer Use') : helper;
  if (!fs.existsSync(binary)) throw new Error('helperMissing');
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\nuwax-cu-bench-' + randomUUID() : path.join(root, 's');
  const token = randomBytes(32).toString('hex'); const tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const policyFile = path.join(root, 'policy.yaml');
  fs.writeFileSync(policyFile, runtime.cuaPolicy({ kind: 'desktop' }, [...runtime.CUA_WINDOW_TASK_TOOLS, 'list_windows'], ['replay_trajectory']), { mode: 0o600 });
  const vars = { CUA_DRIVER_NUWAX_TOKEN_FILE: tokenFile, CUA_DRIVER_DATA_HOME: root,
    CUA_DRIVER_NUWAX_WINDOW_TASKS: '1', CUA_DRIVER_MANAGED_POLICY_FILE: policyFile, CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' };
  const env = { ...runtimeEnvironment(), ...vars };
  const args = ['serve', '--socket', socketPath, '--permission-mode', 'unrestricted', '--dangerously-bypass-approvals'];
  let child;
  if (app) {
    execFileSync('open', ['-n', '-g', ...Object.entries(vars).flatMap(([k,v]) => ['--env', `${k}=${v}`]), app, '--args', ...args], { env, stdio: 'ignore' });
  } else { child = spawn(binary, args, { env, stdio: 'ignore', windowsHide: true }); child.on('error', () => {}); }
  const request = (method, name, args, maxBytes = 65536) => new Promise((resolve, reject) => {
    const socket = net.connect(socketPath); socket.setEncoding('utf8'); let data = ''; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('helperTimeout')), 10000);
    socket.on('error', () => finish(new Error('helperUnavailable')));
    socket.on('end', () => finish(new Error('helperResponseIncomplete')));
    socket.on('connect', () => socket.write(JSON.stringify({ method, name, args, nuwax_client_token: token, client_kind: 'cli', observation_origin: 'direct' }) + '\n'));
    socket.on('data', bytes => {
      data += bytes.toString('utf8'); if (Buffer.byteLength(data) > maxBytes) { finish(new Error('helperResponseTooLarge')); return; }
      if (data.includes('\n')) { try { finish(null, JSON.parse(data.slice(0, data.indexOf('\n')))); } catch { finish(new Error('helperResponseInvalid')); } }
    });
  });
  const close = async () => {
    // This endpoint belongs to this run; never stop any product daemon by name.
    try { execFileSync(binary, ['stop', '--socket', socketPath], { env, timeout: 5000, stdio: 'ignore' }); } catch {}
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  };
  try {
    let meta;
    for (let i = 0; i < 60; i++) { try { meta = await request('metadata'); if (meta.ok) break; } catch {} await sleep(150); }
    if (meta?.result?.nuwax_window_tasks !== 1) throw new Error('helperWindowTasksUnavailable');
    return { binary, socketPath, token, tokenFile, env, request, metadata: meta.result, close };
  } catch (error) { await close(); throw error; }
}

export async function prepareTarget(task, daemon, root, browser, mode = 'background') {
  let fixture, child, nativeFile, anchor, ownedPid;
  const close = async () => {
    anchor?.kill();
    if (ownedPid && process.platform === 'darwin' && fixture) {
      try {
        const command = execFileSync('ps', ['-p',String(ownedPid),'-o','command='], { encoding: 'utf8' });
        if (command.includes('--user-data-dir=' + path.join(root, 'browser-profile'))) process.kill(ownedPid, 'SIGTERM');
      } catch {}
    }
    if (ownedPid && process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(ownedPid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {} }
      else child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
      await exited; clearTimeout(timer);
    }
    if (nativeFile && process.platform === 'darwin') {
      // Only our nonce-named document. Never quit the user's editor or save it.
      const name = JSON.stringify(path.basename(nativeFile));
      try { execFileSync('osascript', ['-e', `tell application "TextEdit" to close (every document whose name is ${name}) saving no`], { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
    await fixture?.close();
  };
  try {
    let title, targetPid;
    if (task.kind === 'fixture') {
      fixture = await startFixture(task); title = fixture.title;
      const bin = browser ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'));
      if (!fs.existsSync(bin)) throw new Error('fixtureBrowserMissing');
      const args = ['--user-data-dir=' + path.join(root, 'browser-profile'), '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--force-renderer-accessibility', '--app=' + fixture.url];
      if (process.platform === 'darwin') {
        const app = bin.slice(0, bin.indexOf('.app/') + 4);
        child = spawn('open', ['-n','-g','-W','-a',app,'--args',...args], { stdio: 'ignore' });
      } else child = spawn(bin, args, { stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
    } else {
      nativeFile = path.join(root, 'cu-bench-' + randomUUID().slice(0, 10) + '.txt'); title = path.basename(nativeFile);
      fs.writeFileSync(nativeFile, 'Nuwax 原生编辑验收：初始内容。', 'utf8');
      if (process.platform === 'darwin') execFileSync('open', ['-g', '-a', 'TextEdit', nativeFile], { stdio: 'ignore' });
      else {
        const before = new Set(windowsPids('notepad'));
        child = spawn('notepad.exe', [nativeFile], { stdio: 'ignore', windowsHide: false }); child.on('error', () => {});
        for (let i = 0; i < 30; i++) {
          const created = windowsPids('notepad', true).filter(pid => !before.has(pid));
          if (created.length === 1) { ownedPid = targetPid = created[0]; break; }
          await sleep(200);
        }
        if (!targetPid) throw new Error('nativeEditorNotIsolated');
        title = path.parse(nativeFile).name;
      }
    }
    for (let i = 0; i < 60; i++) {
      let pid = targetPid ?? child?.pid;
      if (fixture && process.platform === 'darwin') {
        try {
          const rows = execFileSync('ps', ['-axo','pid=,command='], { encoding: 'utf8' }).split('\n');
          const matches = rows.filter(row => row.includes('--user-data-dir=' + path.join(root, 'browser-profile')) && !row.includes('--type=') && !row.includes('open -n'));
          if (matches.length === 1) ownedPid = pid = Number(matches[0].trim().split(/\s/)[0]); else pid = undefined;
        } catch { pid = undefined; }
      }
      if (!pid && nativeFile && process.platform === 'darwin') {
        try { const pids = execFileSync('pgrep', ['-x', 'TextEdit'], { encoding: 'utf8' }).trim().split('\n'); if (pids.length === 1) pid = Number(pids[0]); } catch {}
      }
      if (!pid) { await sleep(250); continue; }
      const reply = await daemon.request('call', 'list_windows', { pid });
      const candidates = (reply.result?.structuredContent?.windows ?? []).filter(w => typeof w.title === 'string' && w.title.includes(title));
      if (candidates.length === 1) {
        if (mode === 'background') anchor = await backgroundAnchor(root);
        return { pid: candidates[0].pid, windowId: candidates[0].window_id, label: title, fixture,
        application: task.kind === 'fixture' ? (process.platform === 'darwin' ? 'Chrome GUI fixture' : 'Edge GUI fixture') : (process.platform === 'darwin' ? 'TextEdit' : 'Notepad'), close };
      }
      if (candidates.length > 1) throw new Error('targetAmbiguous');
      await sleep(250);
    }
    throw new Error('targetWindowNotVisible');
  } catch (error) { await close(); throw error; }
}

export function isolatedAgentEnv(root, config) {
  const home = path.join(root, 'agent-home'); fs.mkdirSync(home, { recursive: true });
  // Do not inherit provider secrets, external MCP configuration or the user's HOME.
  const env = runtimeEnvironment();
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    NUWAXCODE_CONFIG_DIR: path.join(home, '.nuwaxcode'), OPENCODE_CONFIG_DIR: path.join(home, '.config/opencode'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', DO_NOT_TRACK: '1' });
  return env;
}

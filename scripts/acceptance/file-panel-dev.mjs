/** Isolated source-debug client: real Umi file panel, preload, filesystem and bundled file-server.
 * Start the frontend with UMI_ENV=development, then run this script. No installed profile/account is used.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shell = path.join(root, 'nuwa-electron-shell/crates/agent-electron-client');
const source = path.join(root, 'overlay/crates/agent-electron-client/src');
const requireShell = createRequire(path.join(shell, 'package.json'));
const { build } = requireShell('esbuild');
const AdmZip = requireShell('adm-zip');
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nuwax-panel-dev-')));
const workspace = path.join(directory, 'workspace');
await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
await fs.mkdir(path.join(workspace, 'archive'));
await fs.mkdir(path.join(workspace, '.git'));
await fs.writeFile(path.join(workspace, '.git/HEAD'), 'fixture-preserved');
await fs.writeFile(path.join(workspace, 'docs/readme.md'), '# 本机文件预览\n\n- 中文列表\n- **断网读取**\n\n![本机图片](/api/computer/static/999999/pixel.svg?customTargetDir=)\n');
await fs.writeFile(path.join(workspace, 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="green"/><text x="8" y="36" fill="white">LOCAL</text></svg>');
await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><link rel="stylesheet" href="/api/computer/static/999999/docs/style.css"><h1 id="result">本机 HTML 子资源</h1><script src="/api/computer/static/999999/docs/app.js"></script>');
await fs.writeFile(path.join(workspace, 'docs/style.css'), 'h1{color:rgb(0,128,0)}');
await fs.writeFile(path.join(workspace, 'docs/app.js'), 'document.querySelector("h1").textContent+=" · JS 本机已加载"');
await fs.writeFile(path.join(directory, 'upload.txt'), 'Native upload fixture\n');
const zip = new AdmZip(); zip.addFile('project/imported.txt', Buffer.from('Imported locally\n'));
zip.addFile('project/.git/HEAD', Buffer.from('must-not-replace'));
zip.writeZip(path.join(directory, 'import.zip'));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const frontend = new URL(process.env.NUWAX_PANEL_DEV_URL || 'http://127.0.0.1:3001/mock-gallery/file-panel');
frontend.searchParams.set('root', workspace);
const env = { ...process.env, NODE_ENV: 'production', PORT: String(port), PNPM_PRUNE_ENABLED: 'false' };
for (const key of ['PROJECT_SOURCE_DIR', 'BACKUP_PROJECT_DIR', 'UPLOAD_PROJECT_DIR', 'LOG_BASE_DIR', 'COMPUTER_WORKSPACE_DIR', 'COMPUTER_LOG_DIR', 'USERAPP_WORKSPACE_DIR', 'USERAPP_LOG_DIR', 'CLI_PID_DIR', 'CLI_LOG_DIR']) {
  env[key] = path.join(directory, key.toLowerCase()); await fs.mkdir(env[key], { recursive: true });
}
const serverLog = await fs.open(path.join(directory, 'file-server.log'), 'w');
const service = spawn(process.execPath, [path.join(shell, 'sources/nuwax-file-server/dist/server.js')], {
  env, cwd: directory, stdio: ['ignore', serverLog.fd, serverLog.fd],
});
const common = { bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  alias: { '@shared': path.join(source, 'shared'), '@main': path.join(source, 'main') },
  nodePaths: [path.join(shell, 'node_modules'), path.join(root, 'node_modules')] };
const imports = value => JSON.stringify(path.join(source, value));
await build({ ...common, stdin: { loader: 'ts', resolveDir: shell, contents: `
import {contextBridge,ipcRenderer} from 'electron';
import {createLocalFilesBridge} from ${imports('preload/features/local-files.ts')};
contextBridge.exposeInMainWorld('NuwaClawBridge',{host:{getProduct:()=> 'nuwax',getPlatform:()=>process.platform},localFiles:createLocalFilesBridge(ipcRenderer)});
` }, outfile: path.join(directory, 'preload.cjs') });
await build({ ...common, stdin: { loader: 'ts', resolveDir: shell, contents: `
import {app,BrowserWindow,protocol,session} from 'electron';
import {LocalFilesRuntime,localFilesFeature,authorizeLocalFilesRequest} from ${imports('main/features/local-files/index.ts')};
import {createFeatureLifecycle} from ${imports('main/features/_kit/lifecycle.ts')};
import {createTrustedIpc} from ${imports('main/features/_kit/trustedIpc.ts')};
import {createScratchDir} from ${imports('main/features/_kit/scratchDir.ts')};
import {ipcMain} from 'electron';
import fs from 'node:fs';
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
protocol.registerSchemesAsPrivileged([...localFilesFeature.schemes]);
const origin=${JSON.stringify(frontend.origin)},workspace=${JSON.stringify(workspace)};
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:1320,height:880,title:'Nuwax 文件面板 · 原生调试',webPreferences:{preload:${JSON.stringify(path.join(directory, 'preload.cjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false}});
  const allowed=event=>event.sender===window.webContents&&event.senderFrame===event.sender.mainFrame&&event.senderFrame.url.startsWith(origin+'/mock-gallery/file-panel');
  const lifecycle=createFeatureLifecycle();
  const runtime=new LocalFilesRuntime({product:'nuwax',ipc:createTrustedIpc(ipcMain,allowed),lifecycle,
    workspace:{getIdentity:()=>({sandboxId:'file-panel-native-dev',businessOrigins:[origin]}),resolveRoot:()=>workspace,getFileServerPort:()=>${port},isCurrentDocument:allowed},
    scratch:createScratchDir(${JSON.stringify(path.join(directory, 'scratch'))}),log:console});
  window.webContents.session.webRequest.onBeforeRequest((details,callback)=>{
    const policy=authorizeLocalFilesRequest(details);
    if(policy!==undefined)return callback({cancel:!policy});
    const url=new URL(details.url);
    const block=url.protocol.startsWith('http')&&(url.origin!==origin||url.pathname.startsWith('/api/'));
    if(block)console.log('BLOCKED_BUSINESS_NETWORK',url.pathname);
    callback({cancel:block});
  });
  window.webContents.on('console-message',(_event,level,message)=>{if(level>=2)console.log('UI',message)});
  window.webContents.on('did-fail-load',(_event,code,description,url)=>console.error('LOAD_FAILED',code,description,url));
  await window.loadURL(${JSON.stringify(frontend.href)});
  console.log('FILE_PANEL_DEV_READY',JSON.stringify({pid:process.pid,url:${JSON.stringify(frontend.href)},workspace}));
  window.on('closed',()=>{void runtime.dispose();app.quit()});
});
` }, outfile: path.join(directory, 'main.cjs') });
let child;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (service.exitCode !== null) throw new Error(`Fixture file-server exited: ${service.exitCode}`);
    try { await fetch(`http://127.0.0.1:${port}/`); break; }
    catch { if (attempt === 99) throw new Error('Fixture file-server did not start'); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const electronEnv = { ...process.env }; delete electronEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(requireShell('electron'), [path.join(directory, 'main.cjs')], { env: electronEnv, stdio: 'inherit' });
  console.log('FILE_PANEL_DEV_FIXTURE', JSON.stringify({ directory, workspace, port, pid: child.pid }));
  await fs.mkdir(path.join(root, '.cache/acceptance'), { recursive: true });
  await fs.writeFile(path.join(root, '.cache/acceptance/file-panel-dev.json'), JSON.stringify({ directory, workspace, port, pid: child.pid }, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child.kill('SIGTERM'); });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally {
  child?.kill('SIGTERM'); service.kill('SIGTERM'); await serverLog.close();
  // Keep only this isolated fixture/profile/log directory available for inspection.
  console.log('FILE_PANEL_DEV_STOPPED', directory);
}

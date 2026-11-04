// Run with Electron, outside an installer; all profiles and pages belong to this test.
import electron from 'electron'
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createDesktop } from '../../dsh-runtime/desktop.mjs'
const { app, BrowserWindow, webContents } = electron
console.log('desktop-smoke: loaded');
const deadline = setTimeout(() => { console.error('desktop-smoke: timed out'); app.exit(1); }, 90000);
const home = mkdtempSync(join(tmpdir(), 'nuwax-dsh-electron-'))
app.setPath('userData', home)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
async function main() {
const server = createServer((req, res) => {
  if (req.url.includes('/v1/chat/completions')) { req.resume();res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{content:'Desktop integration fixture.'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return; }
  if (req.url === '/plugin') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>DSH plugin fixture</title><main>Plugin fixture</main>'); return }
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<title>Bot browser fixture</title><h1>Browser content</h1><button onclick="document.body.dataset.clicked=\'yes\'">Click me</button>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
let desktop, current = true
try {
  console.log('desktop-smoke: waiting for Electron');
  await app.whenReady(); console.log('desktop-smoke: Electron ready')
  // The browser navigation policy correctly refuses the plugin origin. Use a
  // separate loopback server as the external browser fixture.
  const external = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Browser content</h1><button onclick="document.body.dataset.clicked=\'yes\'">Click me</button>') })
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve))
  try {
    const url = 'http://127.0.0.1:' + external.address().port
    const allocator = createServer(); await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve)); const port = allocator.address().port; await new Promise(resolve => allocator.close(resolve))
    desktop = createDesktop({ electron, runtimeDir: resolve(fileURLToPath(new URL('../../dsh-runtime/', import.meta.url))), scopeDir: home, namespace: 'integration-fixture', port, launchUrl: origin + '/plugin', current: () => current })
    await desktop.open(false)
    const window = BrowserWindow.getAllWindows().find(value => value.getTitle() === 'DSH plugin fixture')
    assert.ok(window)
    assert.equal(await window.webContents.executeJavaScript('typeof window.electronAPI'), 'undefined')
    assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined')
    assert.equal(await window.webContents.executeJavaScript('window.dshDesktop.protocolVersion'), 1)
    const create = (bot, tab) => window.webContents.executeJavaScript(`window.dshDesktop.browser.views.create(${JSON.stringify(bot)}, ${JSON.stringify(tab)}, ${JSON.stringify(url)})`)
    await create('session-11111111-1111-4111-8111-111111111111', 'first'); await create('session-22222222-2222-4222-8222-222222222222', 'second')
    await new Promise(resolve => setTimeout(resolve, 500));
    const guests = webContents.getAllWebContents().filter(value => value !== window.webContents && value.getURL().startsWith(url))
    assert.equal(guests.length, 2)
    await guests[0].session.cookies.set({ url, name: 'login', value: 'first-bot' })
    assert.equal((await guests[1].session.cookies.get({ url, name: 'login' })).length, 0)
    assert.equal(await guests[0].executeJavaScript('typeof window.dshDesktop'), 'undefined')
    assert.equal(await guests[0].executeJavaScript('typeof window.electronAPI'), 'undefined')
    const endpoint = await desktop.endpoint({ botId: 'session-11111111-1111-4111-8111-111111111111', downloadRoots: [home] })
    const { chromium } = await import('../../dsh-runtime/node_modules/playwright/index.mjs')
    const browser = await chromium.connectOverCDP(endpoint)
    const page = browser.contexts()[0].pages()[0]
    await page.waitForSelector('h1')
    assert.equal(await page.textContent('h1'), 'Browser content')
    await page.click('button')
    assert.equal(await page.evaluate(() => document.body.dataset.clicked), 'yes')
    await browser.close()
    const result = await window.webContents.executeJavaScript(`window.dshDesktop.browser.views.read('session-11111111-1111-4111-8111-111111111111','first','document.body.innerText')`)
    assert.ok(JSON.stringify(result).includes('Browser content'))
    await window.webContents.reload()
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve))
    assert.equal(await window.webContents.executeJavaScript('window.dshDesktop.protocolVersion'), 1)
    const liveBrowser = await chromium.connectOverCDP(await desktop.endpoint({botId:'session-11111111-1111-4111-8111-111111111111',downloadRoots:[home]}));
    const disconnected = new Promise(resolve => liveBrowser.once('disconnected', resolve));
    current = false
    await assert.rejects(window.webContents.executeJavaScript("window.dshDesktop.browser.views.sync('session-11111111-1111-4111-8111-111111111111')"))
    desktop.dispose();
    await disconnected;
    await assert.rejects(desktop.endpoint({botId:'session-11111111-1111-4111-8111-111111111111',downloadRoots:[home]}));
    console.log(JSON.stringify({ level: 'electron-source', pluginWindow: true, restrictedPreload: true, botCookieIsolation: true, readPage: true, playwrightAutomation: true, revokedDocument: true, activeAutomationRevoked: true }))
  } finally { desktop?.dispose(); external.closeAllConnections(); await new Promise(resolve => external.close(resolve)) }
  const { RuntimeController, scopeKey } = await import('../../dsh-runtime/controller.mjs');
  const scope = {origin:'https://fixture.example',accountId:'desktop-fixture',epoch:1};
  const saved = new Map([['dsh.authorization.'+scopeKey(scope),{keyId:1,models:['12']}]]);
  const runtimeDir=resolve(fileURLToPath(new URL('../../dsh-runtime/',import.meta.url)));
  const allocator=async()=>{const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;};
  const runtime=new RuntimeController({runtimeDir,officeDir:resolve('resources/dsh-office'),dataDir:join(home,'full-runtime'),node:()=>resolve('resources/dsh-office/primary-runtime/dependencies/node/bin/node'),env:()=>({PATH:process.env.PATH}),allocatePort:allocator,settings:{read:key=>saved.get(key),write:(key,value)=>saved.set(key,value)},platform:{scope:()=>scope,request:async(_scope,route)=>{if(route.startsWith('/api/model/my'))return[{id:12,name:'Fixture',model:'fixture',apiProtocol:'OpenAI',usageScenarios:['OpenApi']}];if(route.endsWith('/list'))return[{id:1,status:1,accessKey:'desktop-fixture',config:{modelIds:[12]}}];if(route==='/api/tenant/config')return{baseModelApiUrl:origin+'/models'};}}});
  try {
    const url=await runtime.start();
    desktop=createDesktop({electron,runtimeDir,scopeDir:runtime.scopeDir(),namespace:scopeKey(scope),port:await allocator(),launchUrl:url,current:()=>runtime.current()});
    await desktop.open(false);
    const window=BrowserWindow.getAllWindows().find(value=>value.webContents.getURL().startsWith(new URL(url).origin));
    const deadline=Date.now()+20000;let loaded=false;
    while(Date.now()<deadline){loaded=await window.webContents.executeJavaScript("document.body.innerText.includes('Chief')");if(loaded)break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(loaded,'Original DS-Bot Client did not render its Main Bot');
    await window.webContents.executeJavaScript(`(async()=>{const call=async(endpoint,payload)=>{const b=await(await fetch('/api/bot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint,payload})})).json();if(!b.ok)throw new Error('DS-Bot refused');return b.value;};const state=await call('state',{});await call('update-bot',{id:state.mainBotId,model:state.models[0].ref});})()`);
    const replyDeadline=Date.now()+15000;let answered=false;while(Date.now()<replyDeadline){answered=await window.webContents.executeJavaScript("document.body.innerText.includes('Desktop integration fixture.')");if(answered)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(answered,'Original DS-Bot Client did not show the model reply');
    await writeFile('/tmp/nuwax-dsh-desktop-source.png',(await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({level:'electron-real-dsh-and-dsbot',clientRendered:true,screenshot:'/tmp/nuwax-dsh-desktop-source.png'}));
  } finally {desktop?.dispose();await runtime.stop();}
} catch (error) { console.error(error); process.exitCode = 1 }
finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); clearTimeout(deadline); app.exit(process.exitCode ?? 0) }

}
void main().catch(error => { console.error(error); app.exit(1); });

import http from 'node:http';
import { randomUUID } from 'node:crypto';

export async function startFixture(task) {
  const title = 'Nuwax CU Bench ' + randomUUID().slice(0, 12);
  const state = {};
  const views = {
    F01: '<form><label>姓名<input name="name"></label><label>城市<input name="city"></label><button>提交</button></form>',
    F02: '<form><label>备注<textarea name="note">原有备注：明天上午开会。</textarea></label><button>保存备注</button></form>',
    F03: '<form><label><input type="radio" name="choice" value="basic">基础方案</label><label><input type="radio" name="choice" value="standard">标准方案</label><label><input type="radio" name="choice" value="premium">高级方案</label><label><input type="checkbox" name="attachment">包含附件</label><button>确认选择</button></form>',
    F04: '<div role="region" aria-label="项目列表" style="height:380px;overflow:auto">' + Array.from({ length: 32 }, (_, i) => `<p style="height:60px">条目 ${i + 1}<button type="button" onclick="pickVisible(this,${i + 1})">选择条目 ${i + 1}</button></p>`).join('') + '</div>',
    F05: '<button type="button" onclick="this.disabled=true;document.querySelector(\'#status\').textContent=\'正在加载\';setTimeout(()=>{document.querySelector(\'#dynamic\').innerHTML=\'<button type=button onclick=confirmLoaded()>确认加载的项目</button>\';send({loaded:true})},2200)">加载项目</button><div id="dynamic"></div>',
    F06: '<button type="button" onclick="this.disabled=true;document.querySelector(\'#dynamic\').innerHTML=\'<button onclick=choose()>选择青竹</button><button onclick=wrong()>选择白石</button>\';send({refreshed:true})">刷新列表</button><div id="dynamic"><button onclick="wrong()">选择青竹（旧项目）</button><button onclick="wrong()">选择白石（旧项目）</button></div>',
  };
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>
    <style>body{font:18px system-ui;padding:32px;max-width:700px}label{display:block;margin:16px 0}input,textarea,button{font:inherit;padding:10px;margin:6px}textarea{width:500px;height:100px}</style>
    <h1>${task.title}</h1>${views[task.id]}<p id="status" role="status">等待操作</p>
    <script>
    const state={}; async function send(p){Object.assign(state,p);await fetch('/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state)});document.querySelector('#status').textContent='操作已记录'}
    function wrong(){send({wrong:true})}function choose(){send({picked:'青竹'})}function confirmLoaded(){send({confirmed:true})}
    function pickVisible(button,n){const list=document.querySelector('[role=region]'),r=list.getBoundingClientRect(),b=button.getBoundingClientRect();send({picked:n,scrolled:list.scrollTop>0,visible:b.top>=r.top&&b.bottom<=r.bottom})}
    document.querySelector('form')?.addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.target);send({...Object.fromEntries(f),attachment:f.has('attachment'),submitted:true})});
    </script></html>`;
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (req.method !== 'POST' || req.url !== '/state') { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16384) { res.writeHead(413).end(); return; } }
    try { const value = JSON.parse(body); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      for (const key of ['name','city','note','choice','attachment','submitted','picked','loaded','confirmed','refreshed','wrong','scrolled','visible']) if (Object.hasOwn(value, key)) state[key] = value[key];
      res.end('ok');
    } catch { res.writeHead(400).end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { title, state, url: `http://127.0.0.1:${server.address().port}`,
    async close() { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

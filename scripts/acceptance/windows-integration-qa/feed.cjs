const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const root = 'C:/nuwax-qa/integration-20261018', version = '3.0.17-qa.integration.2';
const filename = `NuwaxIntegrationQA-${version}.exe`, file = path.join(root, 'installers', filename);
const size = fs.statSync(file).size, sha512 = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
const url = 'http://127.0.0.1:55321/' + filename;
const latest = { version, notes: 'Generated integrated QA update', pub_date: new Date().toISOString(), yml: { win: 'http://127.0.0.1:55321/latest.yml' }, platforms: { 'windows-x86_64': { url, size }, 'win32-x64': { url, size }, win: { url, size } } };
const yaml = `version: ${version}\nfiles:\n  - url: ${filename}\n    sha512: ${sha512}\n    size: ${size}\npath: ${filename}\nsha512: ${sha512}\nreleaseDate: '${latest.pub_date}'\n`;
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  fs.appendFileSync(path.join(root, 'feed-requests.jsonl'), JSON.stringify({ method: req.method, pathname, time: new Date().toISOString() }) + '\n');
  if (pathname.endsWith('/latest.json')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(latest)); return; }
  if (pathname === '/latest.yml') { res.end(yaml); return; }
  if (pathname !== '/' + filename) { res.writeHead(404); res.end('QA only'); return; }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : size - 1;
  if (start > end || end >= size) { res.writeHead(416); res.end(); return; }
  if (range) res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  else res.writeHead(200, { 'Content-Length': size });
  fs.createReadStream(file, { start, end }).pipe(res);
}).listen(55321, '127.0.0.1', () => fs.writeFileSync(path.join(root, 'feed-ready.json'), JSON.stringify({ pid: process.pid, port: 55321, loopbackOnly: true })));

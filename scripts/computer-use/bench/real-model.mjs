import http from 'node:http';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

export function readUsage(value) {
  if (!value || !Number.isFinite(value.prompt_tokens) || !Number.isFinite(value.completion_tokens)) return null;
  return { input: value.prompt_tokens, output: value.completion_tokens,
    cached: value.prompt_tokens_details?.cached_tokens ?? null };
}

export function modelTotals(requests, prices) {
  const known = requests.length > 0 && requests.every(r => r.usage && r.finished);
  const input = known ? requests.reduce((n, r) => n + r.usage.input, 0) : null;
  const output = known ? requests.reduce((n, r) => n + r.usage.output, 0) : null;
  // Optional explicit blended input price. Never interpret an engine's default $0
  // for an unknown/custom model as a real provider price.
  const cost = known && prices ? (input * prices.input + output * prices.output) / 1e6 : null;
  return { requests: requests.length, imageInputs: requests.reduce((n, r) => n + r.images, 0),
    observationsWithSnapshot: Math.max(0, ...requests.map(r => r.observationsWithSnapshot ?? 0)),
    inputTokens: input, outputTokens: output, costUsd: cost,
    modelMs: requests.reduce((n, r) => n + r.durationMs, 0),
    errors: requests.filter(r => r.error).map(r => r.error) };
}

/** In-memory provider instrumentation. The real ACP agent still plans and calls
 * tools; this proxy only forwards its model requests and counts provider usage. */
export async function startModelProxy({ baseUrl, apiKey, model }) {
  const token = randomBytes(32).toString('hex');
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))) throw new Error('invalidModelEndpoint');
  const records = [];
  const aborts = new Set(); const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method === 'GET' && req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] })); return; }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let bytes = 0; const chunks = [];
    try { for await (const chunk of req) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error('modelRequestTooLarge'); chunks.push(chunk); } }
    catch { res.writeHead(413).end(); return; }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400).end(); return; }
    if (body.model !== model) { res.writeHead(400).end(); return; }
    const images = (body.messages ?? []).reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(c => c.type === 'image_url').length : 0), 0);
    const record = { images, durationMs: 0, usage: null, finished: false }; records.push(record);
    record.observationsWithSnapshot = (body.messages ?? []).filter(m => m.role === 'tool' && /snapshot_id[=\\":\s]+s[0-9a-f]{8}/i.test(JSON.stringify(m.content))).length;
    if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
    const ctrl = new AbortController(); aborts.add(ctrl); const started = Date.now();
    const timeout = setTimeout(() => ctrl.abort(), 120000);
    res.once('close', () => { if (!res.writableEnded) ctrl.abort(); });
    try {
      const upstream = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body),
      });
      record.httpStatus = upstream.status;
      if (!upstream.ok) {
        record.error = `providerHttp${upstream.status}`; await upstream.body?.cancel();
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: record.error, type: 'benchmark_provider_error' } })); return;
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      let buffer = ''; const decoder = new TextDecoder(); let outputBytes = 0;
      for await (const chunk of upstream.body) {
        outputBytes += chunk.length; if (outputBytes > 16 * 1024 * 1024) throw new Error('modelResponseTooLarge');
        res.write(chunk); buffer += decoder.decode(chunk, { stream: true });
        if (body.stream) {
          while (buffer.includes('\n')) {
            const end = buffer.indexOf('\n'); const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
            if (line.startsWith('data:') && line !== 'data: [DONE]') {
              try { const data = JSON.parse(line.slice(5)); record.usage = readUsage(data.usage) ?? record.usage; } catch {}
            }
          }
        }
      }
      buffer += decoder.decode();
      if (!body.stream) { try { record.usage = readUsage(JSON.parse(buffer).usage); } catch {} }
      record.finished = true; res.end();
    } catch { record.error = ctrl.signal.aborted ? 'providerTimeoutOrCancelled' : 'providerTransportFailed'; if (!res.headersSent) res.writeHead(502); res.end(); }
    finally { clearTimeout(timeout); aborts.delete(ctrl); record.durationMs = Date.now() - started; }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, token, records,
    async close() { for (const a of aborts) a.abort(); for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

function colorImage() {
  const chunk = (kind, data) => {
    const type = Buffer.from(kind); let crc = 0xffffffff;
    for (const b of Buffer.concat([type, data])) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, type, data, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(16 * 49); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels[y * 49 + x * 3 + 1] = 255;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

export async function probeVision(proxy, model) {
  try {
    const response = await fetch(proxy.url + '/chat/completions', { method: 'POST', signal: AbortSignal.timeout(45000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ model, stream: false, max_tokens: 1024, messages: [{ role: 'user', content: [
        { type: 'text', text: 'What solid color fills this image? Reply with one English color word only.' },
        { type: 'image_url', image_url: { url: colorImage() } },
      ] }] }) });
    if (!response.ok) return { passed: false, reason: `providerHttp${response.status}` };
    const data = await response.json(); const answer = data.choices?.[0]?.message?.content;
    const passed = typeof answer === 'string' && /^\s*red[.!]?\s*$/i.test(answer.replace(/<\|(begin|end)_of_box\|>/g, ''));
    return { passed, ...(passed ? {} : { reason: 'visionVerificationFailed' }) };
  } catch { return { passed: false, reason: 'visionProbeFailed' }; }
}

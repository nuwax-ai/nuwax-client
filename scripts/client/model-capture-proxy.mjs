#!/usr/bin/env node
/**
 * 本地模型请求抓包代理（调试用）。
 *
 * 目的：把客户端/引擎发出的模型请求与上游响应完整落到一个独立日志文件，
 * 方便排查"网关回了什么"这类问题（例如 Kimi Coding Plan 的
 * `Coding Plan is currently only available for Coding Agents`、401、
 * 413、SSE 断流等）。
 *
 * 为什么是反向代理而不是 HTTP 代理：引擎 → 本代理这一段是明文 HTTP，
 * 代理 → 上游走 HTTPS 并用 `https` 模块直连，因此**不需要装任何 CA 证书**，
 * 也不做 TLS 中间人；SSE 响应逐块透传，不破坏流式语义。
 *
 * 用法（通常由 Makefile 的 `model-capture` 目标启动）：
 *
 *   node scripts/client/model-capture-proxy.mjs \
 *     --port 18777 --log logs/model-capture.log
 *
 * 客户端侧接入：`NUWAX_MODEL_CAPTURE=18777 make dev`（或 harness-local）。
 * 客户端会把出站 base URL 改写成
 *   http://127.0.0.1:18777/<base64url(原始 base URL)>
 * 代理解出第一段路径还原上游，其余路径与请求体原样转发。
 *
 * 每次启动都会截断日志（`--keep` 可保留并追加），符合"重启客户端即清空"的
 * 调试习惯。请求头里的凭据一律打码。
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(HERE, '../..');

/** 请求/响应体各保留多少字节；超出部分只记录总长。 */
const BODY_LIMIT = Number(process.env.MODEL_CAPTURE_BODY_LIMIT || 64 * 1024);
/** 打码的请求/响应头（大小写不敏感）。 */
const SECRET_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'proxy-authorization',
]);

function parseArgs(argv) {
  const options = { port: 18777, log: path.join(CLIENT_ROOT, 'logs', 'model-capture.log'), keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port' || arg === '-p') options.port = Number(argv[++index]);
    else if (arg === '--log' || arg === '-l') options.log = path.resolve(argv[++index]);
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: model-capture-proxy.mjs [--port 18777] [--log <file>] [--keep]');
      process.exit(0);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
fs.mkdirSync(path.dirname(options.log), { recursive: true });
if (!options.keep) fs.writeFileSync(options.log, '');
const logStream = fs.createWriteStream(options.log, { flags: 'a' });

function write(line = '') {
  logStream.write(`${line}\n`);
}

function maskHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase())
      ? `${String(value).slice(0, 10)}…(${String(value).length} chars)`
      : value;
  }
  return out;
}

function preview(buffer) {
  if (buffer.length === 0) return { text: '', truncated: false, size: 0 };
  const slice = buffer.subarray(0, BODY_LIMIT);
  return {
    text: slice.toString('utf8'),
    truncated: buffer.length > BODY_LIMIT,
    size: buffer.length,
  };
}

function logBody(label, buffer, contentType = '') {
  const { text, truncated, size } = preview(buffer);
  write(`  ${label} (${size} bytes${truncated ? `, 仅显示前 ${BODY_LIMIT}` : ''})${contentType ? ` ${contentType}` : ''}:`);
  if (size === 0) return;
  for (const line of text.split('\n')) write(`    | ${line}`);
  if (truncated) write('    | …(truncated)');
}

let sequence = 0;

function upstreamFor(requestPath) {
  // 第一段是 base64url 编码的原始 base URL，其余是被请求的真实路径。
  const match = /^\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(requestPath);
  if (!match) return null;
  let base;
  try {
    base = Buffer.from(match[1], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!/^https?:\/\//.test(base)) return null;
  return { base, rest: match[2] || '' };
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const id = ++sequence;
    const target = upstreamFor(request.url ?? '/');

    write('');
    write(`=== #${id} ${new Date().toISOString()} ${request.method} ${request.url}`);
    write(`  request headers: ${JSON.stringify(maskHeaders(request.headers))}`);
    logBody('request body', body, request.headers['content-type'] ?? '');

    if (target === null) {
      write('  ✖ 路径里没有可解码的上游 base URL（期望 /<base64url(base)>/…）');
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"capture proxy: missing base64url upstream prefix"}');
      return;
    }

    const upstream = new URL(target.base.replace(/\/$/, '') + target.rest);
    write(`  → ${request.method} ${upstream.href}`);

    const transport = upstream.protocol === 'https:' ? https : http;
    const headers = { ...request.headers };
    delete headers.host;
    delete headers['content-length'];
    headers.host = upstream.host;
    if (body.length > 0) headers['content-length'] = String(body.length);

    const forwarded = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: `${upstream.pathname}${upstream.search}`,
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        write(`  ← ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage ?? ''}`);
        write(`  response headers: ${JSON.stringify(maskHeaders(upstreamResponse.headers))}`);
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);

        // 流式透传：把每个 chunk 既写给客户端，也按上限累积到日志。
        const captured = [];
        let capturedBytes = 0;
        let totalBytes = 0;
        upstreamResponse.on('data', (chunk) => {
          response.write(chunk);
          totalBytes += chunk.length;
          if (capturedBytes < BODY_LIMIT) {
            captured.push(chunk);
            capturedBytes += chunk.length;
          }
        });
        upstreamResponse.on('end', () => {
          response.end();
          logBody(
            'response body',
            Buffer.concat(captured),
            `(stream total ${totalBytes} bytes)`,
          );
        });
        upstreamResponse.on('error', (error) => {
          write(`  ✖ 上游响应错误: ${error.message}`);
          response.destroy();
        });
      },
    );

    forwarded.on('error', (error) => {
      write(`  ✖ 上游请求失败: ${error.message}`);
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `capture proxy upstream failure: ${error.message}` }));
    });

    if (body.length > 0) forwarded.write(body);
    forwarded.end();
  });
});

server.listen(options.port, '127.0.0.1', () => {
  console.log(`[model-capture] listening http://127.0.0.1:${options.port}`);
  console.log(`[model-capture] log → ${options.log}`);
  console.log('[model-capture] 客户端接入: NUWAX_MODEL_CAPTURE=<port> make harness-local');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logStream.end(() => process.exit(0));
  });
}

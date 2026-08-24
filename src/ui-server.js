'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function startUi({ port, store, proxyPort, upstreamDesc, onReady }) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');

    if (u.pathname === '/') {
      fs.readFile(INDEX_HTML, (err, buf) => {
        if (err) return sendJson(res, 500, { error: 'index.html not found' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(buf);
      });
      return;
    }

    if (u.pathname === '/api/requests') {
      return sendJson(res, 200, store.list().reverse());
    }

    const m = u.pathname.match(/^\/api\/requests\/(\d+)$/);
    if (m) {
      const entry = store.get(Number(m[1]));
      if (!entry) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, store.detail(entry));
    }

    if (u.pathname === '/api/clear' && req.method === 'POST') {
      store.clear();
      return sendJson(res, 200, { ok: true });
    }

    if (u.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const off = store.onEvent((type, payload) => {
        res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        off();
      });
      return;
    }

    if (u.pathname === '/api/config') {
      const desc = typeof upstreamDesc === 'function' ? upstreamDesc() : upstreamDesc;
      return sendJson(res, 200, { proxyPort, uiPort: port, upstream: desc || null });
    }

    sendJson(res, 404, { error: 'not found' });
  });

  // 只听 loopback：本地调试工具不应把界面暴露给局域网
  server.listen(port, '127.0.0.1', () => {
    if (onReady) onReady();
  });

  return server;
}

module.exports = { startUi };

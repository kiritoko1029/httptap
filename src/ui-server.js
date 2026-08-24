'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const configStore = require('./config');
const { listActiveProcesses } = require('./process-map');

const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');
const MAX_CONFIG_BODY = 16 * 1024;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, done) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_CONFIG_BODY) {
      req.destroy();
      return done(null);
    }
    chunks.push(c);
  });
  req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => done(null));
}

// currentConfig: 当前生效的 { proxyPort, uiPort, bindLan }
// onConfigSaved(next): 配置已落盘且端口/绑定发生变化，调用方应安排重启
function startUi({ port, host, store, proxyPort, upstreamDesc, currentConfig, onConfigSaved, onReady }) {
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

    if (u.pathname === '/api/active-processes') {
      // 系统当前网络活跃进程（按连接数降序），设置面板「仅监控进程」的下拉数据源
      return listActiveProcesses()
        .then((list) => sendJson(res, 200, { processes: list.slice(0, 10) }));
    }

    if (u.pathname === '/api/config') {
      if (req.method === 'POST') {
        return readBody(req, (text) => {
          let patch;
          try {
            patch = JSON.parse(text || '{}');
          } catch (_) {
            return sendJson(res, 400, { error: '请求体不是合法 JSON' });
          }
          let next;
          try {
            next = configStore.save(patch);
          } catch (e) {
            return sendJson(res, 400, { error: e.message });
          }
          // 进程过滤为读时过滤，保存即生效
          store.setProcessFilter(next.onlyProcesses);
          const needsRestart =
            next.proxyPort !== currentConfig.proxyPort ||
            next.uiPort !== currentConfig.uiPort ||
            next.bindLan !== currentConfig.bindLan;
          sendJson(res, 200, { ok: true, needsRestart, uiPort: next.uiPort });
          if (needsRestart && onConfigSaved) {
            setTimeout(() => onConfigSaved(next), 300); // 先让响应发出去
          }
        });
      }
      const cfg = configStore.load();
      const desc = typeof upstreamDesc === 'function' ? upstreamDesc() : upstreamDesc;
      return sendJson(res, 200, {
        proxyPort,
        uiPort: port,
        upstream: desc || null,
        bindLan: cfg.bindLan,
        onlyProcesses: cfg.onlyProcesses,
      });
    }

    sendJson(res, 404, { error: 'not found' });
  });

  // 默认只听 loopback：本地调试工具不应暴露给局域网；配置开启后绑 0.0.0.0
  server.listen(port, host || '127.0.0.1', () => {
    if (onReady) onReady();
  });

  return server;
}

module.exports = { startUi };

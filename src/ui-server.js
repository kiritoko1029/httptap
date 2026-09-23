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

// 兜底扩展名：仅在无法从 Content-Disposition / URL 得到带扩展名的文件名时使用
const EXT_BY_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/avif': '.avif',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'application/gzip': '.gz',
  'application/x-tar': '.tar', 'application/json': '.json', 'application/wasm': '.wasm',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'video/mp4': '.mp4', 'video/webm': '.webm',
  'application/octet-stream': '.bin',
};

// 下载文件名：Content-Disposition > URL 路径末段 > 兜底名（与前端详情里的文件名一致）
function downloadName(entry, headers, which) {
  const cd = String((headers && headers['content-disposition']) || '');
  let name = null;
  let m = cd.match(/filename\*\s*=\s*utf-8''([^;]+)/i);
  if (m) {
    try { name = decodeURIComponent(m[1].trim()); } catch (_) { /* 非法编码走下一级 */ }
  }
  if (!name) {
    m = cd.match(/filename\s*=\s*"([^"]*)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
    if (m) name = m[1].trim();
  }
  if (!name) {
    try {
      const base = new URL(entry.url).pathname.split('/').filter(Boolean).pop();
      if (base) {
        try { name = decodeURIComponent(base); } catch (_) { name = base; }
      }
    } catch (_) { /* entry.url 异常时走兜底名 */ }
  }
  name = (name || '').split(/[?#]/)[0].replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);
  if (!name || name === '.' || name === '..') name = `${which === 'req' ? 'request' : 'response'}-${entry.id}`;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    const ext = EXT_BY_MIME[String((headers && headers['content-type']) || '').split(';')[0].trim().toLowerCase()];
    if (ext) name += ext;
  }
  return name;
}

// RFC 6266：filename 提供 ASCII 兜底，filename* 承载 UTF-8（中文文件名）
function contentDisposition(filename, inline) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const enc = encodeURIComponent(filename)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${enc}`;
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
      const detail = store.detail(entry);
      // 二进制体按文件卡片展示：前端展示用的文件名与下载接口保持一致
      if (detail.resBody && detail.resBody.encoding === 'base64') {
        detail.resFileName = downloadName(entry, entry.resHeaders, 'res');
      }
      if (detail.reqBody && detail.reqBody.encoding === 'base64') {
        detail.reqFileName = downloadName(entry, entry.reqHeaders, 'req');
      }
      return sendJson(res, 200, detail);
    }

    // 原始字节下载：/api/requests/:id/download?which=res|req（&inline=1 供图片预览）
    const dl = u.pathname.match(/^\/api\/requests\/(\d+)\/download$/);
    if (dl) {
      const entry = store.get(Number(dl[1]));
      if (!entry) return sendJson(res, 404, { error: 'not found' });
      const which = u.searchParams.get('which') === 'req' ? 'req' : 'res';
      const body = which === 'req' ? entry.reqBody : entry.resBody;
      if (!body || !body.length) return sendJson(res, 404, { error: 'no body' });
      const headers = which === 'req' ? entry.reqHeaders : entry.resHeaders;
      const ct = String((headers && headers['content-type']) || '').split(';')[0].trim();
      const out = {
        'content-type': ct || 'application/octet-stream',
        'content-length': body.length,
        'content-disposition': contentDisposition(
          downloadName(entry, headers, which), u.searchParams.get('inline') === '1'),
        'cache-control': 'no-store',
      };
      // 缓存被截断时文件不完整，显式告知前端
      if (which === 'req' ? entry.reqBodyTruncated : entry.resBodyTruncated) {
        out['x-body-truncated'] = '1';
      }
      res.writeHead(200, out);
      res.end(body);
      return;
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

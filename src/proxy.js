'use strict';

const zlib = require('zlib');
// MITM 代理库 vendored 在本地（上游 1.1.0 已停更）：消除 uuid@9/yargs 等陈旧传递依赖
const { Proxy } = require('./vendor/http-mitm-proxy');
const { MAX_BODY_BYTES } = require('./store');
const { createAgentCache } = require('./upstream');

// 按 content-encoding 解压；失败（截断的流、未知编码、数据损坏）返回 null
function tryDecodeBody(buf, ce) {
  try {
    switch (ce) {
      case 'br': return zlib.brotliDecompressSync(buf);
      case 'gzip': return zlib.gunzipSync(buf);
      case 'deflate':
        // 历史上 deflate 有 zlib 头和裸流两种实现
        try { return zlib.inflateSync(buf); } catch (_) { return zlib.inflateRawSync(buf); }
      case 'zstd':
        return typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync(buf) : null;
      default: return null;
    }
  } catch (_) {
    return null;
  }
}

// 线上响应普遍是 br/gzip 压缩字节，解压后再入库：详情展示和下载拿到的都是真实内容
function decodeEntryBody(entry, kind) {
  const headers = kind === 'req' ? entry.reqHeaders : entry.resHeaders;
  const truncated = kind === 'req' ? entry.reqBodyTruncated : entry.resBodyTruncated;
  const body = kind === 'req' ? entry.reqBody : entry.resBody;
  const ce = String((headers && headers['content-encoding']) || '').toLowerCase().trim();
  if (!body || !body.length || truncated || !ce || ce === 'identity') return;
  const decoded = tryDecodeBody(body, ce);
  if (!decoded) return;
  if (decoded.length > MAX_BODY_BYTES) {
    if (kind === 'req') entry.reqBodyTruncated = true; else entry.resBodyTruncated = true;
  }
  // 头部与解压后的字节保持一致（去掉编码/长度），已解压标记由 detail 透出给界面提示
  delete headers['content-encoding'];
  delete headers['content-length'];
  entry[kind === 'req' ? 'reqBodyDecoded' : 'resBodyDecoded'] = ce;
  entry[kind === 'req' ? 'reqBody' : 'resBody'] = decoded.subarray(0, MAX_BODY_BYTES);
}

function startProxy({ port, host, store, sslCaDir, upstream, processMap, onReady }) {
  const proxy = new Proxy();
  const agentCache = createAgentCache();

  // 把请求改道到上游代理（已有关系统代理链路的场景）：
  // - 明文 HTTP：改写为 absolute-URI 发给上游代理（兼容性最好，不要求上游开放 CONNECT 到 80）
  // - HTTPS（已 MITM 解密）：经 CONNECT 隧道连接目标，隧道内照常做 TLS
  function applyUpstream(ctx, opts, isSSL, hostname) {
    if (!upstream) return;
    const target = upstream.forRequest(isSSL, hostname);
    if (!target) return;
    if (isSSL) {
      opts.agent = agentCache.https(target);
    } else {
      const hostHeader = (opts.headers && opts.headers.host) || `${opts.host}:${opts.port}`;
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(opts.path)) {
        opts.path = `http://${hostHeader}${opts.path}`;
      }
      opts.host = target.host;
      opts.port = target.port;
      if (target.authHeader) opts.headers['proxy-authorization'] = target.authHeader;
    }
  }

  proxy.onError((ctx, err) => {
    // ECONNRESET / EPIPE 多为客户端主动断开，属于正常噪音
    const code = err && err.code;
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
      if (ctx && ctx.__entry) {
        store.finalize(ctx.__entry, { error: code });
      }
      return;
    }
    console.error('[proxy error]', err && err.message ? err.message : err);
    if (ctx && ctx.__entry) {
      store.finalize(ctx.__entry, { error: String(err && err.message ? err.message : err) });
    }
  });

  proxy.onRequest((ctx, callback) => {
    const opts = ctx.proxyToServerRequestOptions;
    const protocol = ctx.isSSL ? 'https' : 'http';
    const host = (opts.headers && opts.headers.host) || opts.host || '';

    const entry = store.create({
      protocol,
      method: opts.method,
      host,
      path: opts.path,
      url: `${protocol}://${host}${opts.path}`,
      reqHeaders: opts.headers || {},
    });
    ctx.__entry = entry;

    // 进程归属：HTTPS（MITM）要取原始 CONNECT 的 socket，否则拿到的是内部回环连接
    if (processMap) {
      const clientSocket = (ctx.connectRequest && ctx.connectRequest.socket) ||
        (ctx.clientToProxyRequest && ctx.clientToProxyRequest.socket);
      const remotePort = clientSocket && clientSocket.remotePort;
      if (remotePort) {
        processMap.lookup(remotePort).then((p) => {
          if (!p) return;
          entry.processPid = p.pid;
          entry.processName = p.name;
          // 归属是异步的，请求可能已完结并推送过——补发一条更新让前端刷新
          if (entry.durationMs != null) store.emit('entry', entry);
        }).catch(() => {});
      }
    }

    // 防止目标指向代理自身：转发给自己会形成回环，耗尽临时端口（EADDRNOTAVAIL）
    const hostname = String(host).replace(/^\[|\].*$/g, '').split(':')[0];
    const isLoopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
    const targetPort = Number(opts.port) || (ctx.isSSL ? 443 : 80);
    if (isLoopback && targetPort === port) {
      store.finalize(entry, { error: 'self-request blocked', status: 400, reqSize: 0, resSize: 0 });
      ctx.proxyToClientResponse.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      ctx.proxyToClientResponse.end('Blocked: 请求目标是代理自身，已拦截以避免回环。请为本地地址设置 no_proxy。');
      return; // 不调用 callback，不再转发
    }

    // 本机已有系统代理时，把请求继续交给上游代理（绕过列表命中的目标除外）
    applyUpstream(ctx, opts, ctx.isSSL, hostname);

    const reqChunks = [];
    const resChunks = [];
    let reqSize = 0;
    let resSize = 0;

    ctx.onRequestData((ctx2, chunk, cb) => {
      reqSize += chunk.length;
      if (reqSize <= MAX_BODY_BYTES) reqChunks.push(chunk);
      else entry.reqBodyTruncated = true;
      return cb(null, chunk);
    });

    ctx.onRequestEnd((ctx2, cb) => {
      entry.reqBody = Buffer.concat(reqChunks);
      decodeEntryBody(entry, 'req');
      return cb();
    });

    ctx.onResponse((ctx2, cb) => {
      entry.status = ctx2.serverToProxyResponse.statusCode;
      entry.resHeaders = ctx2.serverToProxyResponse.headers || {};
      return cb();
    });

    ctx.onResponseData((ctx2, chunk, cb) => {
      resSize += chunk.length;
      if (resSize <= MAX_BODY_BYTES) resChunks.push(chunk);
      else entry.resBodyTruncated = true;
      return cb(null, chunk);
    });

    ctx.onResponseEnd((ctx2, cb) => {
      entry.resBody = Buffer.concat(resChunks);
      decodeEntryBody(entry, 'res');
      store.finalize(entry, { reqSize, resSize });
      return cb();
    });

    return callback();
  });

  // WebSocket 与 HTTP 走不同的连接路径，这里单独替换 agent 做上游串联
  proxy.onWebSocketConnection((ctx, callback) => {
    if (upstream) {
      try {
        const o = ctx.proxyToServerWebSocketOptions;
        const u = new URL(o.url);
        const isSSL = u.protocol === 'wss:';
        const target = upstream.forRequest(isSSL, u.hostname);
        if (target) o.agent = isSSL ? agentCache.https(target) : agentCache.http(target);
      } catch (_) {}
    }
    callback();
  });

  // 默认绑 127.0.0.1（库的默认 "localhost" 在 Windows 上常解析到 IPv6 ::1，
  // 而注册表系统代理写的是 127.0.0.1，会连接被拒）；配置开启局域网暴露时绑 0.0.0.0
  proxy.listen({ port, host: host || '127.0.0.1', sslCaDir, silent: true }, () => {
    if (onReady) onReady();
  });

  return proxy;
}

module.exports = { startProxy };

'use strict';

const Proxy = require('http-mitm-proxy').default || require('http-mitm-proxy');
const { MAX_BODY_BYTES } = require('./store');

function startProxy({ port, store, sslCaDir, onReady }) {
  const proxy = new Proxy();

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
      store.finalize(entry, { reqSize, resSize });
      return cb();
    });

    return callback();
  });

  proxy.listen({ port, sslCaDir, silent: true }, () => {
    if (onReady) onReady();
  });

  return proxy;
}

module.exports = { startProxy };

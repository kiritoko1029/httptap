'use strict';

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 单个请求/响应体最多缓存 2MB

// 判断是否文本体：按 MIME 类型/子类型精确匹配，避免 application/vnd.openxmlformats-…
// 这类二进制 Office 文档因子串包含 "xml" 被误判为文本（会显示成乱码而非文件卡片）
function isTextualContentType(ct) {
  const mime = String(ct || '').split(';')[0].trim().toLowerCase();
  const slash = mime.indexOf('/');
  if (slash < 0) return false;
  const type = mime.slice(0, slash);
  const sub = mime.slice(slash + 1);
  if (type === 'text') return true;
  if (/^(?:json|xml|x?javascript|html|svg|csv|x-www-form-urlencoded)$/.test(sub)) return true;
  return /[+]json$/.test(sub) || /[+]xml$/.test(sub); // RFC 6838 结构化语法后缀
}

function encodeBody(buf, headers) {
  if (!buf || buf.length === 0) return null;
  if (isTextualContentType((headers && headers['content-type']) || '')) {
    return { encoding: 'utf8', data: buf.toString('utf8') };
  }
  return { encoding: 'base64', data: buf.toString('base64') };
}

class Store {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
    this.listeners = new Set();
    this.nextId = 1;
    this.processFilter = []; // 「仅监控进程」：非空时 list/推送只保留匹配项
  }

  // 匹配规则：忽略大小写与 .exe 后缀的子串匹配
  setProcessFilter(list) {
    this.processFilter = (list || [])
      .map((s) => String(s).toLowerCase().replace(/\.exe$/, ''))
      .filter(Boolean);
  }

  passesProc(e) {
    if (!this.processFilter.length) return true;
    const name = String((e && e.processName) || '').toLowerCase().replace(/\.exe$/, '');
    if (!name) return false; // 过滤开启时未归属的请求不展示
    return this.processFilter.some((f) => name.includes(f));
  }

  create(meta) {
    const entry = Object.assign({ id: this.nextId++, startedAt: Date.now() }, meta);
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    return entry;
  }

  finalize(entry, patch) {
    Object.assign(entry, patch, { durationMs: Date.now() - entry.startedAt });
    this.emit('entry', entry);
  }

  clear() {
    this.entries = [];
    this.emitRaw('cleared', {});
  }

  get(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  summary(e) {
    return {
      id: e.id,
      protocol: e.protocol,
      method: e.method,
      host: e.host,
      url: e.url,
      status: e.status != null ? e.status : null,
      error: e.error || null,
      reqSize: e.reqSize || 0,
      resSize: e.resSize || 0,
      durationMs: e.durationMs != null ? e.durationMs : null,
      startedAt: e.startedAt,
      processPid: e.processPid || null,
      processName: e.processName || null,
    };
  }

  list() {
    return this.entries.filter((e) => this.passesProc(e)).map((e) => this.summary(e));
  }

  detail(e) {
    const s = this.summary(e);
    return Object.assign(s, {
      path: e.path,
      reqHeaders: e.reqHeaders || {},
      resHeaders: e.resHeaders || {},
      reqBody: encodeBody(e.reqBody, e.reqHeaders),
      resBody: encodeBody(e.resBody, e.resHeaders),
      reqBodyTruncated: !!e.reqBodyTruncated,
      resBodyTruncated: !!e.resBodyTruncated,
    });
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, entry) {
    if (type === 'entry' && !this.passesProc(entry)) return; // 进程过滤不推送
    this.emitRaw(type, this.summary(entry));
  }

  emitRaw(type, payload) {
    for (const fn of this.listeners) {
      try {
        fn(type, payload);
      } catch (_) {
        /* 忽略断开的客户端 */
      }
    }
  }
}

module.exports = { Store, MAX_BODY_BYTES };

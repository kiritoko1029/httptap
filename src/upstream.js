'use strict';

// 上游代理串联：本机已有系统代理（或终端已 export 代理变量）时，
// httptap 把拦截到的请求继续转发给上游代理，保持原有代理链路可用。
//
// - 探测顺序：--upstream 参数 > 环境变量（http_proxy/https_proxy）> macOS 系统代理（scutil --proxy）
// - 指向 httptap 自身的代理地址会被忽略，避免自我回环
// - 绕过列表（no_proxy + 系统 ExceptionsList）命中的目标直连
// - 仅支持 http:// 上游；SOCKS / PAC 检测到后会给出提示，对应目标直连

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

// 把 'host:port' / 'http://user:pass@host:port' 归一化为 { host, port, authHeader }
function parseProxyUrl(value) {
  if (!value) return null;
  let raw = String(value).trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return { invalid: raw };
  }
  const proto = u.protocol.replace(':', '').toLowerCase();
  if (proto !== 'http') return { unsupported: proto, raw: value };
  const authHeader = u.username
    ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64')
    : null;
  return { host: u.hostname, port: Number(u.port) || 80, authHeader };
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
}

// 解析 macOS `scutil --proxy` 输出
function parseScutil(text) {
  const dict = {};
  const list = [];
  let inList = false;
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (inList) {
      if (line === '}') { inList = false; continue; }
      const item = line.match(/^\d+\s*:\s*(.+)$/);
      if (item) list.push(item[1].trim());
      continue;
    }
    const m = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!m) continue;
    if (m[1] === 'ExceptionsList') { inList = true; continue; }
    dict[m[1]] = m[2].trim();
  }
  const out = { bypass: list };
  if (dict.HTTPEnable === '1' && dict.HTTPProxy) {
    out.http = { host: dict.HTTPProxy, port: Number(dict.HTTPPort) || 80, authHeader: null };
  }
  if (dict.HTTPSEnable === '1' && dict.HTTPSProxy) {
    out.https = { host: dict.HTTPSProxy, port: Number(dict.HTTPSPort) || 443, authHeader: null };
  }
  if (dict.SOCKSEnable === '1' && dict.SOCKSProxy) {
    out.socks = { host: dict.SOCKSProxy, port: Number(dict.SOCKSPort) || 1080 };
  }
  if (dict.ProxyAutoConfigEnable === '1') {
    out.pac = dict.ProxyAutoConfigURLString || true;
  }
  return out;
}

// 解析 Windows 注册表 Internet Settings（reg query 的全量输出）
// ProxyServer 两种形态：单一 "host:port"（所有协议共用），或分协议 "http=h:p;https=h:p;socks=h:p"
function parseWindowsProxy(text) {
  const vals = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s+(\w+)\s+REG_\w+\s*(.*)$/);
    if (m) vals[m[1].toLowerCase()] = m[2].trim();
  }
  const out = { bypass: [] };
  if (!/^0x1$/i.test(vals.proxyenable || '')) return out; // 系统代理未启用
  const parseHP = (s) => {
    const m = String(s).trim().match(/^([^:]+):(\d+)$/);
    return m ? { host: m[1], port: Number(m[2]), authHeader: null } : null;
  };
  const server = vals.proxyserver || '';
  if (server.includes('=')) {
    for (const part of server.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const proto = part.slice(0, eq).trim().toLowerCase();
      const p = parseHP(part.slice(eq + 1));
      if (!p) continue;
      if (proto === 'http') out.http = p;
      else if (proto === 'https') out.https = p;
      else if (proto === 'socks' || proto === 'socks5') out.socks = p;
    }
  } else {
    const p = parseHP(server);
    if (p) {
      out.http = p;
      out.https = { host: p.host, port: p.port, authHeader: null };
    }
  }
  if (vals.proxyoverride) {
    out.bypass = vals.proxyoverride.split(';').map((s) => s.trim()).filter(Boolean);
  }
  if (vals.autoconfigurl) out.pac = vals.autoconfigurl;
  return out;
}

function readSystemProxy() {
  try {
    if (process.platform === 'darwin') {
      const text = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
      return parseScutil(text);
    }
    if (process.platform === 'win32') {
      const text = execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ], { encoding: 'utf8', timeout: 3000 });
      return parseWindowsProxy(text);
    }
    return null;
  } catch (_) {
    return null;
  }
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function ipv4InCidr(ip, cidr) {
  const [base, bitsStr] = String(cidr).split('/');
  const bits = Number(bitsStr);
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits));
  return (a & mask) === (b & mask);
}

// 命中绕过列表则直连。支持：*、含 * 的通配（*.suffix、192.168.* 等）、.suffix、plain(含子域)、IPv4 CIDR、<local>
function shouldBypass(host, bypassList) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const raw of bypassList || []) {
    const e = String(raw).trim().toLowerCase();
    if (!e) continue;
    if (e === '*') return true;
    if (e === '<local>') { if (!h.includes('.')) return true; continue; }
    if (e.includes('/')) { if (ipv4InCidr(h, e)) return true; continue; }
    if (e.includes('*')) {
      // 通用通配：* 匹配任意字符（Windows 绕过列表常用 10.*、192.168.* 这类写法）
      if (new RegExp('^' + e.split('*').map(escRe).join('.*') + '$').test(h)) return true;
      continue;
    }
    if (e.startsWith('.')) { if (h === e.slice(1) || h.endsWith(e)) return true; continue; }
    if (h === e || h.endsWith('.' + e)) return true;
  }
  return false;
}

// 通过上游代理建立 CONNECT 隧道，回调拿到已打通的裸 socket
function connectTunnel(target, dstHost, dstPort, cb) {
  const socket = net.connect(target.port, target.host);
  let settled = false;
  const done = (err, s) => {
    if (settled) return;
    settled = true;
    socket.setTimeout(0);
    if (err) socket.destroy();
    cb(err, s);
  };
  socket.setTimeout(15000, () => done(new Error('上游代理 CONNECT 超时')));
  socket.once('error', done);
  socket.once('connect', () => {
    const lines = [`CONNECT ${dstHost}:${dstPort} HTTP/1.1`, `Host: ${dstHost}:${dstPort}`];
    if (target.authHeader) lines.push(`Proxy-Authorization: ${target.authHeader}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 16384) done(new Error('上游代理 CONNECT 响应异常'));
        return;
      }
      socket.removeListener('data', onData);
      const statusLine = buf.slice(0, idx).toString('latin1').split('\r\n')[0];
      const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      if (!m || m[1] !== '200') return done(new Error(`上游代理 CONNECT 失败: ${statusLine}`));
      const rest = buf.slice(idx + 4);
      if (rest.length) socket.unshift(rest); // 隧道后的数据交还给上层协议
      done(null, socket);
    };
    socket.on('data', onData);
  });
}

// ws:// 等明文协议的隧道 agent（CONNECT 后直接使用裸 socket）
class TunnelHttpAgent extends http.Agent {
  constructor(target, options) {
    super(options);
    this._target = target;
  }
  createConnection(options, cb) {
    connectTunnel(this._target, options.host, Number(options.port) || 80, cb);
  }
}

// https/wss 的隧道 agent（CONNECT 后在隧道内做 TLS 握手，校验目标真实证书）
class TunnelHttpsAgent extends https.Agent {
  constructor(target, options) {
    super(options);
    this._target = target;
  }
  createConnection(options, cb) {
    connectTunnel(this._target, options.host, Number(options.port) || 443, (err, socket) => {
      if (err) return cb(err);
      const host = options.servername || options.host;
      const tlsSocket = tls.connect({
        socket,
        servername: net.isIP(host) ? undefined : host,
        ALPNProtocols: options.ALPNProtocols,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      });
      let settled = false;
      tlsSocket.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        cb(null, tlsSocket);
      });
      tlsSocket.once('error', (e) => {
        if (settled) return;
        settled = true;
        cb(e);
      });
    });
  }
}

// 按上游地址缓存隧道 agent，保证 keep-alive 复用
function createAgentCache() {
  const cache = new Map();
  const keyOf = (t) => `${t.host}:${t.port}:${t.authHeader || ''}`;
  return {
    http(target) {
      const key = 'h:' + keyOf(target);
      if (!cache.has(key)) cache.set(key, new TunnelHttpAgent(target, { keepAlive: true }));
      return cache.get(key);
    },
    https(target) {
      const key = 's:' + keyOf(target);
      if (!cache.has(key)) cache.set(key, new TunnelHttpsAgent(target, { keepAlive: true }));
      return cache.get(key);
    },
  };
}

// flag：undefined=自动探测；'none'=不串联；其余视为代理地址（host:port 或 URL）
// selfPort：httptap 自身监听端口，用于过滤指向自己的代理配置
// stateFile：sysproxy 接管状态文件。存在且指向本实例时，说明系统代理已被 httptap 接管，
//           此时 scutil 看到的代理就是自己，真正的上游应取接管前保存的配置（动态读取，接管/还原即时生效）
function createUpstreamResolver({ flag, selfPort, stateFile } = {}) {
  const notes = [];
  let source = 'none';
  let httpProxy = null;
  let httpsProxy = null;
  let bypass = ['127.0.0.1', 'localhost', '::1'];
  const flagGiven = flag !== undefined && flag !== null && flag !== '';

  const adopt = (parsed, scheme, srcName) => {
    if (!parsed) return null;
    if (parsed.invalid) {
      notes.push(`无法解析${srcName}（${parsed.invalid}），${scheme} 目标将直连`);
      return null;
    }
    if (parsed.unsupported) {
      notes.push(`${srcName} 是 ${parsed.unsupported} 协议，暂不支持串联，${scheme} 目标将直连`);
      return null;
    }
    if (isLoopback(parsed.host) && parsed.port === selfPort) return null; // 指向自己，忽略
    return parsed;
  };

  if (flagGiven) {
    if (String(flag).toLowerCase() === 'none') {
      source = 'none';
    } else {
      const p = parseProxyUrl(flag);
      const usable = adopt(p, '所有', '--upstream 参数');
      if (usable) {
        httpProxy = usable;
        httpsProxy = usable;
        source = 'flag';
      }
    }
  } else {
    const envHttp = adopt(parseProxyUrl(process.env.http_proxy || process.env.HTTP_PROXY), 'http', '环境变量 http_proxy');
    const envHttps = adopt(parseProxyUrl(process.env.https_proxy || process.env.HTTPS_PROXY), 'https', '环境变量 https_proxy');
    httpProxy = envHttp;
    httpsProxy = envHttps;
    if (envHttp || envHttps) {
      bypass = bypass.concat(String(process.env.no_proxy || process.env.NO_PROXY || '').split(','));
    }
    // 环境变量没覆盖到的协议，再看 macOS 系统代理
    if (!httpProxy || !httpsProxy) {
      const sys = readSystemProxy();
      if (sys) {
        if (!httpProxy && sys.http && !(isLoopback(sys.http.host) && sys.http.port === selfPort)) httpProxy = sys.http;
        if (!httpsProxy && sys.https && !(isLoopback(sys.https.host) && sys.https.port === selfPort)) httpsProxy = sys.https;
        bypass = bypass.concat(sys.bypass || []);
        if (sys.socks && !httpProxy && !httpsProxy) {
          notes.push('系统代理仅配置了 SOCKS，暂不支持串联，所有目标将直连');
        }
        if (sys.pac) {
          notes.push('系统启用了 PAC 自动代理配置，无法逐请求解析，仅按上述规则串联');
        }
      }
    }
    if (httpProxy || httpsProxy) {
      const fromEnv = (envHttp && httpProxy === envHttp) || (envHttps && httpsProxy === envHttps);
      const fromSys = (!envHttp && httpProxy) || (!envHttps && httpsProxy);
      source = fromEnv && fromSys ? 'env+system' : fromEnv ? 'env' : 'system';
    }
  }

  // 接管状态文件（按 mtime 缓存）：只有「系统代理正指向本实例」时才采用，避免过期状态误伤。
  // 用 mtime 而不是 TTL，接管/还原的瞬间就能切换上游，不留窗口期
  let stateCache = { mtime: -1, value: null };
  function readState() {
    if (!stateFile || flagGiven) return null;
    let mtime;
    try {
      mtime = fs.statSync(stateFile).mtimeMs;
    } catch (_) {
      stateCache = { mtime: -1, value: null };
      return null;
    }
    if (mtime !== stateCache.mtime) {
      let value = null;
      try {
        const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (st && st.proxyPort === selfPort && st.upstream) value = st;
      } catch (_) {}
      stateCache = { mtime, value };
    }
    return stateCache.value;
  }

  function current() {
    const st = readState();
    if (st) {
      return {
        http: st.upstream.http || null,
        https: st.upstream.https || null,
        bypass: ['127.0.0.1', 'localhost', '::1'].concat(st.exceptions || []),
        source: '接管前的系统代理',
      };
    }
    return { http: httpProxy, https: httpsProxy, bypass, source };
  }

  const resolver = {
    source,
    http: httpProxy,
    https: httpsProxy,
    bypass,
    notes,
    // 返回该请求应走的上游 { host, port, authHeader }，直连返回 null
    forRequest(isSSL, host) {
      const c = current();
      const p = isSSL ? c.https : c.http;
      if (!p) return null;
      if (shouldBypass(host, c.bypass)) return null;
      return p;
    },
    describe() {
      const c = current();
      if (!c.http && !c.https) return '无（直连）';
      const parts = [];
      if (c.http) parts.push(`http→${c.http.host}:${c.http.port}`);
      if (c.https) parts.push(`https→${c.https.host}:${c.https.port}`);
      return `${parts.join('，')}（来源: ${c.source}）`;
    },
  };
  return resolver;
}

module.exports = {
  createUpstreamResolver,
  createAgentCache,
  parseProxyUrl,
  parseScutil,
  parseWindowsProxy,
  readSystemProxy,
  shouldBypass,
};

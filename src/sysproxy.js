'use strict';

// 系统代理接管/还原：把系统 HTTP/HTTPS 代理指向 httptap，
// GUI 应用（浏览器等读系统代理的程序）的流量随之进入 httptap，httptap 再串联到原上游。
//
// 接管前的配置保存在 state 文件里，用于：
// 1. sysproxy off / httptap off / 进程退出时恢复原样
// 2. upstream 解析器读取「接管前的系统代理」作为串联上游（此时系统代理已是 httptap 自己）
//
// 平台实现：macOS 用 networksetup；Windows 用注册表（HKCU 下修改不需要管理员权限，
// 但已运行的应用可能要重启/刷新后才感知新代理设置）

const fs = require('fs');
const { execFileSync } = require('child_process');

const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function run(bin, args) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function loadState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ---------- macOS（networksetup） ----------

// 启用的网络服务列表（'*' 开头的是已禁用的）
function listServices() {
  return run('networksetup', ['-listallnetworkservices'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('*') && !/denotes that/i.test(s));
}

// networksetup -getwebproxy "Wi-Fi" → Enabled: Yes / Server: 127.0.0.1 / Port: 7890 ...
function getProxy(service, kind) {
  const out = run('networksetup', ['-get' + kind, service]);
  const o = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) o[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return { enabled: /^yes$/i.test(o.enabled || ''), host: o.server || '', port: Number(o.port) || 0 };
}

function takeoverDarwin({ stateFile, proxyPort, upstream, exceptions }) {
  const services = listServices();
  if (!services.length) throw new Error('未找到可用的网络服务');

  const saved = {
    version: 1,
    createdAt: Date.now(),
    proxyPort,
    upstream: upstream || { http: null, https: null },
    exceptions: exceptions || [],
    services: {},
  };
  for (const svc of services) {
    saved.services[svc] = { web: getProxy(svc, 'webproxy'), secure: getProxy(svc, 'securewebproxy') };
  }

  // 先落盘状态文件（upstream 解析器据此切换上游），再改系统代理，避免中间态指错上游
  fs.writeFileSync(stateFile, JSON.stringify(saved, null, 2));

  const changed = [];
  try {
    for (const svc of services) {
      run('networksetup', ['-setwebproxy', svc, '127.0.0.1', String(proxyPort)]);
      run('networksetup', ['-setsecurewebproxy', svc, '127.0.0.1', String(proxyPort)]);
      changed.push(svc);
    }
  } catch (err) {
    // 中途失败尽量回滚，避免系统代理指着一个没完全接管的实例
    try {
      restore({ stateFile });
    } catch (_) {}
    throw new Error(`设置系统代理失败（可能需要管理员授权）: ${err.message}`);
  }
  return { services: changed, saved };
}

function restoreDarwin({ stateFile }) {
  const saved = loadState(stateFile);
  if (!saved || !saved.services) return false;
  for (const [svc, cfg] of Object.entries(saved.services)) {
    try {
      if (cfg.web && cfg.web.enabled) run('networksetup', ['-setwebproxy', svc, cfg.web.host, String(cfg.web.port)]);
      else run('networksetup', ['-setwebproxystate', svc, 'off']);
      if (cfg.secure && cfg.secure.enabled) run('networksetup', ['-setsecurewebproxy', svc, cfg.secure.host, String(cfg.secure.port)]);
      else run('networksetup', ['-setsecurewebproxystate', svc, 'off']);
    } catch (_) {
      // 单个服务还原失败不阻塞其他服务（服务可能已被删除/改名）
    }
  }
  try {
    fs.unlinkSync(stateFile);
  } catch (_) {}
  return true;
}

// ---------- Windows（注册表 HKCU，无需管理员） ----------

// 读取原始值（还原时要原样写回，包括「值原本不存在」这个状态）
function winReadRaw() {
  const out = { enable: '0x0', server: '', override: '', serverExists: false, overrideExists: false };
  let text;
  try {
    text = run('reg', ['query', WIN_KEY]);
  } catch (_) {
    return out;
  }
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s+(\w+)\s+(REG_\w+)\s*(.*)$/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (name === 'proxyenable') out.enable = m[3].trim() || '0x0';
    else if (name === 'proxyserver') { out.server = m[3].trim(); out.serverExists = true; }
    else if (name === 'proxyoverride') { out.override = m[3].trim(); out.overrideExists = true; }
  }
  return out;
}

function winAdd(value, type, data) {
  run('reg', ['add', WIN_KEY, '/v', value, '/t', type, '/d', data, '/f']);
}

function takeoverWin32({ stateFile, proxyPort, upstream, exceptions }) {
  const cur = winReadRaw();
  const saved = {
    version: 1,
    createdAt: Date.now(),
    proxyPort,
    upstream: upstream || { http: null, https: null },
    exceptions: exceptions || [],
    win32: cur,
  };
  fs.writeFileSync(stateFile, JSON.stringify(saved, null, 2));
  try {
    winAdd('ProxyServer', 'REG_SZ', `127.0.0.1:${proxyPort}`);
    winAdd('ProxyEnable', 'REG_DWORD', '1');
  } catch (err) {
    try {
      restore({ stateFile });
    } catch (_) {}
    throw new Error(`设置系统代理失败: ${err.message}`);
  }
  return { services: ['Windows 系统代理（注册表）'], saved };
}

function restoreWin32({ stateFile }) {
  const saved = loadState(stateFile);
  if (!saved || !saved.win32) return false;
  const cur = saved.win32;
  try {
    if (cur.serverExists) winAdd('ProxyServer', 'REG_SZ', cur.server);
    else run('reg', ['delete', WIN_KEY, '/v', 'ProxyServer', '/f']);
  } catch (_) {}
  try {
    winAdd('ProxyEnable', 'REG_DWORD', String(parseInt(cur.enable, 16) || 0));
  } catch (_) {}
  try {
    fs.unlinkSync(stateFile);
  } catch (_) {}
  return true;
}

// ---------- 平台分发 ----------

function takeover(opts) {
  if (loadState(opts.stateFile)) {
    throw new Error('系统代理已被 httptap 接管（状态文件已存在），如需重设请先执行 sysproxy off');
  }
  return process.platform === 'win32' ? takeoverWin32(opts) : takeoverDarwin(opts);
}

function restore(opts) {
  return process.platform === 'win32' ? restoreWin32(opts) : restoreDarwin(opts);
}

module.exports = { takeover, restore, loadState, listServices };

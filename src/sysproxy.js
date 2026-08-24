'use strict';

// macOS 系统代理接管/还原：通过 networksetup 把系统 HTTP/HTTPS 代理指向 httptap，
// GUI 应用（浏览器等读系统代理的程序）的流量随之进入 httptap，httptap 再串联到原上游。
//
// 接管前的各网络服务配置保存在 state 文件里，用于：
// 1. sysproxy off / httptap off / 进程退出时恢复原样
// 2. upstream 解析器读取「接管前的系统代理」作为串联上游（此时 scutil 看到的代理已是 httptap 自己）

const fs = require('fs');
const { execFileSync } = require('child_process');

function run(args) {
  return execFileSync('networksetup', args, {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// 启用的网络服务列表（'*' 开头的是已禁用的）
function listServices() {
  return run(['-listallnetworkservices'])
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('*') && !/denotes that/i.test(s));
}

// networksetup -getwebproxy "Wi-Fi" → Enabled: Yes / Server: 127.0.0.1 / Port: 7890 ...
function getProxy(service, kind) {
  const out = run(['-get' + kind, service]);
  const o = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) o[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return { enabled: /^yes$/i.test(o.enabled || ''), host: o.server || '', port: Number(o.port) || 0 };
}

function loadState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

// upstream: { http: {host,port}|null, https: {host,port}|null }（接管前的系统代理，可为空）
// exceptions: 系统代理的绕过列表
function takeover({ stateFile, proxyPort, upstream, exceptions }) {
  if (loadState(stateFile)) {
    throw new Error('系统代理已被 httptap 接管（状态文件已存在），如需重设请先执行 sysproxy off');
  }
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
      run(['-setwebproxy', svc, '127.0.0.1', String(proxyPort)]);
      run(['-setsecurewebproxy', svc, '127.0.0.1', String(proxyPort)]);
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

function restore({ stateFile }) {
  const saved = loadState(stateFile);
  if (!saved) return false;
  for (const [svc, cfg] of Object.entries(saved.services || {})) {
    try {
      if (cfg.web && cfg.web.enabled) run(['-setwebproxy', svc, cfg.web.host, String(cfg.web.port)]);
      else run(['-setwebproxystate', svc, 'off']);
      if (cfg.secure && cfg.secure.enabled) run(['-setsecurewebproxy', svc, cfg.secure.host, String(cfg.secure.port)]);
      else run(['-setsecurewebproxystate', svc, 'off']);
    } catch (_) {
      // 单个服务还原失败不阻塞其他服务（服务可能已被删除/改名）
    }
  }
  try {
    fs.unlinkSync(stateFile);
  } catch (_) {}
  return true;
}

module.exports = { takeover, restore, loadState, listServices };

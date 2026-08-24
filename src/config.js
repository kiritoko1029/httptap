'use strict';

// 持久化配置：~/.httptap/config.json
// 端口/局域网开关的改动需要重启服务生效（Web 界面保存后由守护进程自重启），
// 仅监控进程为读时过滤，保存即生效。

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(os.homedir(), '.httptap', 'config.json');

const DEFAULTS = {
  proxyPort: 8888,
  uiPort: 8880,
  bindLan: false,       // true 时代理与 Web 界面绑 0.0.0.0（暴露给局域网）
  onlyProcesses: [],    // 非空时列表/实时推送只保留匹配进程（子串、忽略大小写与 .exe 后缀）
};

function isPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function normalizeProcs(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,\s]+/);
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return {
    proxyPort: isPort(raw.proxyPort) ? raw.proxyPort : DEFAULTS.proxyPort,
    uiPort: isPort(raw.uiPort) ? raw.uiPort : DEFAULTS.uiPort,
    bindLan: raw.bindLan === true,
    onlyProcesses: normalizeProcs(raw.onlyProcesses),
  };
}

// patch 校验后合并落盘；非法值抛 Error（消息面向用户）
function save(patch) {
  const cur = load();
  const next = { ...cur };

  if (patch.proxyPort !== undefined) {
    const n = Number(patch.proxyPort);
    if (!isPort(n)) throw new Error('代理端口必须是 1-65535 的整数');
    next.proxyPort = n;
  }
  if (patch.uiPort !== undefined) {
    const n = Number(patch.uiPort);
    if (!isPort(n)) throw new Error('界面端口必须是 1-65535 的整数');
    next.uiPort = n;
  }
  if (next.proxyPort === next.uiPort) throw new Error('代理端口与界面端口不能相同');
  if (patch.bindLan !== undefined) next.bindLan = patch.bindLan === true;
  if (patch.onlyProcesses !== undefined) next.onlyProcesses = normalizeProcs(patch.onlyProcesses);

  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { CONFIG_FILE, DEFAULTS, load, save, normalizeProcs };

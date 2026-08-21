#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

// CA 放在用户主目录的固定位置：npx 运行时包目录在 npm 缓存里，缓存清理后 CA 会重新生成，
// 导致系统钥匙串/环境变量里信任的旧证书失效
const CA_DIR = path.join(os.homedir(), '.httptap');
const CA_FILE = path.join(CA_DIR, 'certs', 'ca.pem');
const PID_FILE = path.join(CA_DIR, 'httptap.pid');
const LOG_FILE = path.join(CA_DIR, 'httptap.log');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const proxyPort = parseInt(arg('proxy-port', '8888'), 10);
const uiPort = parseInt(arg('ui-port', '8880'), 10);
const cmd = ['on', 'off', 'run'].includes(process.argv[2]) ? process.argv[2] : null;

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 0); // 探测进程是否存活
    return pid;
  } catch (_) {
    return null;
  }
}

function waitReady(done) {
  const deadline = Date.now() + 15000;
  (function poll() {
    http.get({ host: '127.0.0.1', port: uiPort, path: '/api/config', timeout: 1000 }, (res) => {
      res.resume();
      if (res.statusCode === 200 && fs.existsSync(CA_FILE)) return done(true);
      retry();
    }).on('error', retry);
    function retry() {
      if (Date.now() > deadline) return done(false);
      setTimeout(poll, 300);
    }
  })();
}

// 输出可被 source 的 export 行（stdout 只放 shell，提示信息走 stderr）
function printExports() {
  console.log(`export http_proxy=http://127.0.0.1:${proxyPort}`);
  console.log(`export https_proxy=http://127.0.0.1:${proxyPort}`);
  console.log('export no_proxy=127.0.0.1,localhost');
  console.log(`export NODE_EXTRA_CA_CERTS=${CA_FILE}`);
}

if (cmd === 'on') {
  if (readPid()) {
    console.error(`httptap 已在运行（代理 127.0.0.1:${proxyPort}，界面 http://127.0.0.1:${uiPort}）`);
    printExports();
    process.exitCode = 0; // 不用 process.exit，避免管道场景下 stdout 被截断
  } else {
    fs.mkdirSync(CA_DIR, { recursive: true });
    const out = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath,
      [__filename, 'run', '--proxy-port', String(proxyPort), '--ui-port', String(uiPort)],
      { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    waitReady((ok) => {
      if (!ok) {
        console.error(`启动失败，查看日志: ${LOG_FILE}`);
        process.exit(1);
      }
      console.error(`httptap 已后台启动: 代理 127.0.0.1:${proxyPort}，界面 http://127.0.0.1:${uiPort}（日志 ${LOG_FILE}）`);
      console.error('代理环境变量已输出到 stdout，可用 eval "$(npx httptap on)" 或 source <(npx httptap on) 自动生效');
      printExports();
      process.exitCode = 0;
    });
  }
} else if (cmd === 'off') {
  const pid = readPid();
  if (pid) {
    try { process.kill(pid); } catch (_) {}
    console.error('httptap 已停止');
  } else {
    console.error('httptap 未在运行');
  }
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  console.log('unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY NODE_EXTRA_CA_CERTS');
} else {
  // run / 无子命令：前台运行代理 + Web 界面
  const { Store } = require('./src/store');
  const { startProxy } = require('./src/proxy');
  const { startUi } = require('./src/ui-server');

  const store = new Store(500);

  startProxy({
    port: proxyPort,
    store,
    sslCaDir: CA_DIR,
    onReady: () => {
      console.log(`代理已启动:  http://127.0.0.1:${proxyPort}`);
    },
  });

  startUi({
    port: uiPort,
    store,
    proxyPort,
    onReady: () => {
      console.log(`Web 界面:    http://127.0.0.1:${uiPort}`);
      console.log('');
      console.log('后台运行 + 自动设置代理环境变量（推荐）:');
      console.log('  eval "$(npx httptap on)"       # 启动并注入环境变量（zsh 也可用 source <(npx httptap on)）');
      console.log('  eval "$(npx httptap off)"      # 停止并清除环境变量');
      console.log('');
      console.log('或手动设置:');
      console.log(`  export http_proxy=http://127.0.0.1:${proxyPort}`);
      console.log(`  export https_proxy=http://127.0.0.1:${proxyPort}`);
      console.log('  export no_proxy=127.0.0.1,localhost   # 本地地址绕过代理');
      console.log('');
      console.log('HTTPS 抓包需要客户端信任 CA 证书（首次运行自动生成）:');
      console.log(`  ${CA_FILE}`);
      console.log('');
      console.log('Node.js 程序（kimi / npm 等）加一行环境变量即可信任:');
      console.log(`  export NODE_EXTRA_CA_CERTS=${CA_FILE}`);
      console.log('其他程序（curl / git / 浏览器）需把 CA 加入系统钥匙串，见 README');
      console.log('');
      console.log('按 Ctrl+C 退出');
    },
  });
}

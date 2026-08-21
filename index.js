#!/usr/bin/env node
'use strict';

const path = require('path');
const { Store } = require('./src/store');
const { startProxy } = require('./src/proxy');
const { startUi } = require('./src/ui-server');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const proxyPort = parseInt(arg('proxy-port', '8888'), 10);
const uiPort = parseInt(arg('ui-port', '8880'), 10);
const caDir = path.join(__dirname, '.http-mitm-proxy');

const store = new Store(500);

startProxy({
  port: proxyPort,
  store,
  sslCaDir: caDir,
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
    console.log('终端使用方式:');
    console.log(`  export http_proxy=http://127.0.0.1:${proxyPort}`);
    console.log(`  export https_proxy=http://127.0.0.1:${proxyPort}`);
    console.log('  export no_proxy=127.0.0.1,localhost   # 本地地址绕过代理');
    console.log('');
    console.log('HTTPS 抓包需要客户端信任 CA 证书（首次运行自动生成）:');
    console.log(`  ${path.join(caDir, 'certs', 'ca.pem')}`);
    console.log('');
    console.log('Node.js 程序（kimi / npm 等）加一行环境变量即可信任:');
    console.log(`  export NODE_EXTRA_CA_CERTS=${path.join(caDir, 'certs', 'ca.pem')}`);
    console.log('其他程序（curl / git / 浏览器）需把 CA 加入系统钥匙串，见 README');
    console.log('');
    console.log('按 Ctrl+C 退出');
  },
});

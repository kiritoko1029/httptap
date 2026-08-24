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
const BUNDLE_FILE = path.join(CA_DIR, 'certs', 'ca-bundle.pem');
const PID_FILE = path.join(CA_DIR, 'httptap.pid');
const LOG_FILE = path.join(CA_DIR, 'httptap.log');
const STATE_FILE = path.join(CA_DIR, 'sysproxy-state.json'); // 系统代理接管状态（见 src/sysproxy.js）
const SYSTEM_CA_BUNDLE = '/etc/ssl/cert.pem'; // macOS 系统根证书（LibreSSL bundle）

const COMMANDS = ['on', 'off', 'run', 'serve', 'sysproxy', 'trust', 'help'];

// 第一个出现的子命令把参数切成两段；run 之后的内容全部视为子进程命令，不解析其中的参数
const argv = process.argv.slice(2);
let cmd = null;
let cmdIndex = -1;
for (let i = 0; i < argv.length; i++) {
  if (COMMANDS.includes(argv[i])) {
    cmd = argv[i];
    cmdIndex = i;
    break;
  }
}
const optTokens = cmd === 'run' ? argv.slice(0, cmdIndex)
  : cmd ? argv.filter((_, i) => i !== cmdIndex)
    : argv;
const childArgs = cmd === 'run' ? argv.slice(cmdIndex + 1) : [];

function arg(name, dflt) {
  const i = optTokens.indexOf('--' + name);
  return i >= 0 && optTokens[i + 1] && !optTokens[i + 1].startsWith('--') ? optTokens[i + 1] : dflt;
}

const proxyPort = parseInt(arg('proxy-port', '8888'), 10);
const uiPort = parseInt(arg('ui-port', '8880'), 10);
const upstreamFlag = arg('upstream', undefined); // 默认自动探测；'none' 表示不串联上游代理

// 第一个非 flag 词不是已知子命令时（如 httptap offf），不要静默起服务，报用法错误
function findUnknownCommand() {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (COMMANDS.includes(t)) return null; // 从这里开始属于子命令及其参数
    if (t.startsWith('--')) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--') && !COMMANDS.includes(argv[i + 1])) i++; // 跳过 flag 的值
      continue;
    }
    return t;
  }
  return null;
}

function printHelp() {
  const win = process.platform === 'win32';
  const onHint = win
    ? 'PowerShell 里用 httptap on | Invoke-Expression 自动生效'
    : 'eval "$(httptap on)" 自动生效（zsh 也可用 source <(httptap on)）';
  console.log(`httptap — HTTP/HTTPS 抓包工具（MITM 代理 + Web 界面）

用法:
  httptap [选项]                     前台运行代理 + Web 界面（同 serve）
  httptap [选项] on                  后台启动并输出代理环境变量（${onHint}）
  httptap off                        停止后台服务（系统代理接管中时会一并还原）
  httptap [选项] run [--] <命令...>  只拦截指定进程的流量
  httptap [选项] sysproxy on         系统代理指向 httptap（拦截浏览器 / GUI 应用）
  httptap sysproxy off | status      还原系统代理 / 查看接管状态
  httptap trust                      把 CA 写入系统信任库（HTTPS 解密需要）
  httptap help                       显示本帮助（也可用 --help / -h）

选项（放在子命令之前）:
  --proxy-port N    代理端口（默认 8888）
  --ui-port N       Web 界面端口（默认 8880）
  --upstream X      上游代理 URL 或 none（默认自动探测：环境变量 → 系统代理）

示例:
  httptap run -- curl https://example.com    # 只抓这个 curl 进程
  httptap run -- npm install                 # 只抓这次 npm
  httptap sysproxy on                        # 抓浏览器 / 桌面应用（macOS、Windows）

文档: https://github.com/kiritoko1029/httptap#readme`);
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 0); // 探测进程是否存活
    return pid;
  } catch (_) {
    return null;
  }
}

function fetchConfig(done) {
  const deadline = Date.now() + 15000;
  (function poll() {
    const req = http.get({ host: '127.0.0.1', port: uiPort, path: '/api/config', timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 200 && fs.existsSync(CA_FILE)) {
          try {
            return done(JSON.parse(body));
          } catch (_) {}
        }
        retry();
      });
    });
    req.on('error', retry);
    function retry() {
      if (Date.now() > deadline) return done(null);
      setTimeout(poll, 300);
    }
  })();
}

function startDaemon(done) {
  fs.mkdirSync(CA_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  const args = [__filename, 'serve', '--proxy-port', String(proxyPort), '--ui-port', String(uiPort)];
  if (upstreamFlag !== undefined) args.push('--upstream', upstreamFlag);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  fetchConfig(done);
}

// 保证代理服务在后台运行。done(err, config, started)
function ensureRunning(done) {
  if (readPid()) {
    return fetchConfig((config) => {
      if (!config) return done(new Error('httptap 进程存活但界面无响应，可执行 httptap off 后重试'));
      done(null, config, false);
    });
  }
  startDaemon((config) => {
    if (!config) return done(new Error(`启动失败，查看日志: ${LOG_FILE}`));
    done(null, config, true);
  });
}

// 拼出“系统根证书 + httptap CA”的合并 CA bundle：
// 走代理的流量由 httptap 重签证书，不响应代理变量的程序直连时仍用系统根证书验证，两者都能通过
function ensureCombinedCaBundle() {
  try {
    if (!fs.existsSync(SYSTEM_CA_BUNDLE) || !fs.existsSync(CA_FILE)) return CA_FILE;
    const content = fs.readFileSync(SYSTEM_CA_BUNDLE, 'utf8') + '\n' + fs.readFileSync(CA_FILE, 'utf8');
    let existing = null;
    try {
      existing = fs.readFileSync(BUNDLE_FILE, 'utf8');
    } catch (_) {}
    if (existing !== content) fs.writeFileSync(BUNDLE_FILE, content);
    return BUNDLE_FILE;
  } catch (_) {
    return CA_FILE;
  }
}

// 输出可被 shell 执行的代理设置行（stdout 只放 shell，提示信息走 stderr）
function printExports() {
  if (process.platform === 'win32') {
    // PowerShell：httptap on | Invoke-Expression
    console.log(`$env:http_proxy="http://127.0.0.1:${proxyPort}"`);
    console.log(`$env:https_proxy="http://127.0.0.1:${proxyPort}"`);
    console.log('$env:no_proxy="127.0.0.1,localhost"');
    console.log(`$env:NODE_EXTRA_CA_CERTS="${CA_FILE}"`);
    return;
  }
  console.log(`export http_proxy=http://127.0.0.1:${proxyPort}`);
  console.log(`export https_proxy=http://127.0.0.1:${proxyPort}`);
  console.log('export no_proxy=127.0.0.1,localhost');
  console.log(`export NODE_EXTRA_CA_CERTS=${CA_FILE}`);
}

// off 时输出清除环境变量的 shell 行
function printUnsets() {
  if (process.platform === 'win32') {
    console.log('Remove-Item Env:http_proxy,Env:https_proxy,Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:no_proxy,Env:NO_PROXY,Env:NODE_EXTRA_CA_CERTS -ErrorAction SilentlyContinue');
    return;
  }
  console.log('unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY NODE_EXTRA_CA_CERTS');
}

if (cmd === 'help' || optTokens.includes('--help') || optTokens.includes('-h') ||
  (cmd === 'run' && ['--help', '-h'].includes(childArgs[0]))) {
  printHelp();
} else if (!cmd && findUnknownCommand()) {
  console.error(`未知命令: ${findUnknownCommand()}\n`);
  printHelp();
  process.exit(1);
} else if (cmd === 'on') {
  ensureRunning((err, config, started) => {
    if (err) {
      console.error(err.message);
      process.exit(1);
    }
    if (config.proxyPort !== proxyPort || config.uiPort !== uiPort) {
      console.error(`已有 httptap 实例在运行（代理 127.0.0.1:${config.proxyPort}，界面 http://127.0.0.1:${config.uiPort}），与本次指定的端口不一致；先执行 httptap off 停止，或改用相同端口`);
      process.exit(1);
    }
    if (!started && upstreamFlag !== undefined) {
      console.error('注意: 已有实例在运行，--upstream 参数被忽略（上游代理由运行中的实例决定）');
    }
    console.error(started
      ? `httptap 已后台启动: 代理 127.0.0.1:${proxyPort}，界面 http://127.0.0.1:${uiPort}（日志 ${LOG_FILE}）`
      : `httptap 已在运行（代理 127.0.0.1:${proxyPort}，界面 http://127.0.0.1:${uiPort}）`);
    console.error(`上游代理: ${config.upstream || '无（直连）'}`);
    if (started) {
      console.error(process.platform === 'win32'
        ? '代理环境变量已输出到 stdout，PowerShell 里执行 httptap on | Invoke-Expression 自动生效'
        : '代理环境变量已输出到 stdout，可用 eval "$(npx httptap on)" 或 source <(npx httptap on) 自动生效');
    }
    printExports();
    process.exitCode = 0; // 不用 process.exit，避免管道场景下 stdout 被截断
  });
} else if (cmd === 'off') {
  const pid = readPid();
  if (pid) {
    try {
      process.kill(pid);
    } catch (_) {}
    console.error('httptap 已停止');
  } else {
    console.error('httptap 未在运行');
  }
  try {
    fs.unlinkSync(PID_FILE);
  } catch (_) {}
  // 若系统代理仍指向 httptap，一并还原，避免把系统网络留在坏状态
  const sysproxy = require('./src/sysproxy');
  if (sysproxy.loadState(STATE_FILE)) {
    try {
      sysproxy.restore({ stateFile: STATE_FILE });
      console.error('系统代理已还原');
    } catch (e) {
      console.error(`还原系统代理失败: ${e.message}，可执行 httptap sysproxy off 重试`);
    }
  }
  printUnsets();
} else if (cmd === 'sysproxy') {
  const action = argv[cmdIndex + 1];
  const sysproxy = require('./src/sysproxy');
  const { readSystemProxy } = require('./src/upstream');
  const isSelf = (p) => p && (p.host === '127.0.0.1' || p.host === 'localhost') && p.port === proxyPort;

  if (action === 'off') {
    console.error(sysproxy.restore({ stateFile: STATE_FILE }) ? '系统代理已还原' : '系统代理当前未被 httptap 接管');
  } else if (action === 'status') {
    const st = sysproxy.loadState(STATE_FILE);
    if (!st) {
      console.log('httptap 未接管系统代理');
    } else {
      const up = [];
      if (st.upstream && st.upstream.http) up.push(`http→${st.upstream.http.host}:${st.upstream.http.port}`);
      if (st.upstream && st.upstream.https) up.push(`https→${st.upstream.https.host}:${st.upstream.https.port}`);
      console.log(`httptap 已接管系统代理 → 127.0.0.1:${st.proxyPort}，上游: ${up.join('，') || '无（直连）'}，接管于 ${new Date(st.createdAt).toLocaleString()}`);
    }
  } else if (action === 'on') {
    if (!['darwin', 'win32'].includes(process.platform)) {
      console.error('sysproxy 目前支持 macOS 和 Windows');
      process.exit(1);
    }
    if (sysproxy.loadState(STATE_FILE)) {
      console.error('系统代理已被 httptap 接管，无需重复执行（status 查看状态，off 还原）');
      process.exit(0);
    }
    // 记录当前系统代理作为串联上游（此时还没切换，scutil 看到的就是用户原配置）
    const sys = readSystemProxy() || {};
    const upstream = {
      http: sys.http && !isSelf(sys.http) ? sys.http : null,
      https: sys.https && !isSelf(sys.https) ? sys.https : null,
    };
    ensureRunning((err, config, started) => {
      if (err) {
        console.error(err.message);
        process.exit(1);
      }
      if (config.proxyPort !== proxyPort) {
        console.error(`已有 httptap 实例在 127.0.0.1:${config.proxyPort} 运行，与本次 --proxy-port ${proxyPort} 不一致；先执行 httptap off 或去掉 --proxy-port`);
        process.exit(1);
      }
      try {
        const { services } = sysproxy.takeover({
          stateFile: STATE_FILE,
          proxyPort,
          upstream,
          exceptions: sys.bypass || [],
        });
        void started;
        console.error(`系统代理已指向 httptap（127.0.0.1:${proxyPort}），网络服务: ${services.join(', ')}`);
        const up = [];
        if (upstream.http) up.push(`http→${upstream.http.host}:${upstream.http.port}`);
        if (upstream.https) up.push(`https→${upstream.https.host}:${upstream.https.port}`);
        console.error(`上游代理: ${up.join('，') || '无（直连）'}；浏览器等读系统代理的应用流量现在会经过 httptap`);
        if (process.platform === 'win32') {
          console.error('注意: Windows 上已运行的应用可能要重启或刷新后才会使用新的代理设置');
        }
        console.error('HTTPS 解密需要应用信任 httptap CA，可执行 httptap trust 写入系统信任库');
        console.error('还原: httptap sysproxy off（或 httptap off，会一并还原）');
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
    });
  } else {
    console.error('用法: httptap [--proxy-port N] sysproxy [on|off|status]');
    console.error('  on     把 macOS 系统代理指向 httptap（浏览器/GUI 应用的流量随之进入抓包）');
    console.error('  off    还原接管前的系统代理设置');
    console.error('  status 查看当前是否接管中');
    process.exit(1);
  }
} else if (cmd === 'trust') {
  // 把 CA 写入系统信任库，浏览器等读系统信任库的应用才能解密 HTTPS
  if (!fs.existsSync(CA_FILE)) {
    console.error('CA 证书尚未生成，请先运行一次 httptap（npx httptap）再执行 trust');
    process.exit(1);
  }
  if (process.platform === 'win32') {
    console.error(`即将把 httptap CA 写入当前用户的「受信任的根证书」存储（可能弹出安全警告需确认）: ${CA_FILE}`);
    const child = spawn('certutil', ['-user', '-addstore', 'Root', CA_FILE], { stdio: 'inherit' });
    child.on('error', (e) => {
      console.error(`执行失败: ${e.message}`);
      process.exit(1);
    });
    child.on('exit', (code) => {
      console.error(code === 0
        ? 'CA 已写入当前用户根证书存储，浏览器/系统应用现在可以解密 HTTPS 了'
        : `写入失败（exit ${code}），也可手动双击 ${CA_FILE} 安装到「受信任的根证书颁发机构」`);
      process.exit(code == null ? 1 : code);
    });
  } else if (process.platform === 'darwin') {
    console.error(`即将把 httptap CA 写入系统钥匙串信任（sudo 需要登录密码）: ${CA_FILE}`);
    const child = spawn('sudo', [
      'security', 'add-trusted-cert', '-d', '-r', 'trustRoot',
      '-k', '/Library/Keychains/System.keychain', CA_FILE,
    ], { stdio: 'inherit' });
    child.on('error', (e) => {
      console.error(`执行失败: ${e.message}`);
      process.exit(1);
    });
    child.on('exit', (code) => {
      console.error(code === 0 ? 'CA 已加入系统钥匙串信任，浏览器/系统应用现在可以解密 HTTPS 了' : `写入失败（exit ${code}）`);
      process.exit(code == null ? 1 : code);
    });
  } else {
    console.error(`请手动信任 CA 证书: ${CA_FILE}`);
    process.exit(1);
  }
} else if (cmd === 'run') {
  const runArgs = childArgs[0] === '--' ? childArgs.slice(1) : childArgs;
  if (!runArgs.length) {
    console.error('用法: httptap [--proxy-port N] [--ui-port M] [--upstream URL|none] run [--] <命令> [参数...]');
    console.error('示例: httptap run -- curl https://example.com');
    process.exit(1);
  }
  ensureRunning((err, config, started) => {
    if (err) {
      console.error(err.message);
      process.exit(1);
    }
    if (config.proxyPort !== proxyPort) {
      console.error(`已有 httptap 实例在 127.0.0.1:${config.proxyPort} 运行，与本次 --proxy-port ${proxyPort} 不一致；先执行 httptap off 或去掉 --proxy-port`);
      process.exit(1);
    }
    if (!started && upstreamFlag !== undefined) {
      console.error('注意: 已有实例在运行，--upstream 参数被忽略（上游代理由运行中的实例决定）');
    }
    const bundle = ensureCombinedCaBundle();
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    const mergedNoProxy = ['127.0.0.1', 'localhost', process.env.no_proxy || process.env.NO_PROXY || '']
      .filter(Boolean)
      .join(',');
    // 只把代理变量注入子进程：终端里的其他程序不受影响。
    // CA 变量让常见运行时（Node/curl/Python/git）直接信任 httptap 的 CA，无需改系统钥匙串
    const env = {
      ...process.env,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      no_proxy: mergedNoProxy,
      NO_PROXY: mergedNoProxy,
      NODE_EXTRA_CA_CERTS: CA_FILE,
      NODE_USE_ENV_PROXY: '1', // Node >= 24.5 的原生 fetch 默认不读代理变量，需要显式打开
      SSL_CERT_FILE: bundle,
      REQUESTS_CA_BUNDLE: bundle,
      CURL_CA_BUNDLE: bundle,
      GIT_SSL_CAINFO: bundle,
    };
    console.error(`[httptap] 仅该子进程的流量经由 127.0.0.1:${proxyPort}，在 http://127.0.0.1:${config.uiPort || uiPort} 查看（上游代理: ${config.upstream || '无'}）`);
    if (started) {
      console.error(`[httptap] 代理已转为后台常驻，用完可执行 httptap off 停止（日志 ${LOG_FILE}）`);
    }
    let child;
    if (process.platform === 'win32') {
      // Windows 上 npm 等命令是 .cmd，必须经 cmd.exe 启动；对含特殊字符的参数做引号转义
      const quote = (s) => (/[\s"&|<>^]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
      child = spawn(runArgs.map(quote).join(' '), { env, stdio: 'inherit', shell: true });
    } else {
      child = spawn(runArgs[0], runArgs.slice(1), { env, stdio: 'inherit' });
    }
    child.on('error', (e) => {
      console.error(`[httptap] 启动子进程失败: ${e.message}`);
      process.exit(1);
    });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => child.kill(sig));
    }
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`[httptap] 子进程因 ${signal} 退出`);
        process.exit(1);
      }
      process.exit(code == null ? 0 : code);
    });
  });
} else {
  // serve / 无子命令：前台运行代理 + Web 界面
  const { Store } = require('./src/store');
  const { startProxy } = require('./src/proxy');
  const { startUi } = require('./src/ui-server');
  const { createUpstreamResolver } = require('./src/upstream');
  const { createProcessMap } = require('./src/process-map');
  const sysproxy = require('./src/sysproxy');

  const upstream = createUpstreamResolver({ flag: upstreamFlag, selfPort: proxyPort, stateFile: STATE_FILE });
  // 进程归属（按连接源端口反查进程名；macOS/Linux 用 lsof，Windows 用 netstat+tasklist）
  const processMap = createProcessMap(proxyPort);
  const store = new Store(500);

  // 退出时若系统代理仍指向本实例，自动还原，避免把系统网络留在坏状态
  const restoreSysproxyOnExit = () => {
    try {
      const st = sysproxy.loadState(STATE_FILE);
      if (st && st.proxyPort === proxyPort) {
        sysproxy.restore({ stateFile: STATE_FILE });
        console.log('已还原系统代理设置');
      }
    } catch (_) {}
  };
  process.on('SIGINT', () => { restoreSysproxyOnExit(); process.exit(0); });
  process.on('SIGTERM', () => { restoreSysproxyOnExit(); process.exit(0); });

  startProxy({
    port: proxyPort,
    store,
    sslCaDir: CA_DIR,
    upstream,
    processMap,
    onReady: () => {
      console.log(`代理已启动:  http://127.0.0.1:${proxyPort}`);
      console.log(`上游代理:    ${upstream.describe()}`);
      for (const note of upstream.notes) console.log(`  提示: ${note}`);
    },
  });

  startUi({
    port: uiPort,
    store,
    proxyPort,
    upstreamDesc: () => upstream.describe(),
    onReady: () => {
      console.log(`Web 界面:    http://127.0.0.1:${uiPort}`);
      console.log('');
      console.log('拦截单个终端进程的流量（不影响其他程序）:');
      console.log('  npx httptap run -- <命令>        # 如 npx httptap run -- curl https://example.com');
      console.log('');
      console.log('拦截本机应用（浏览器等，读系统代理的程序，macOS/Windows）:');
      console.log('  npx httptap sysproxy on        # 系统代理指向 httptap（自动串联到原系统代理）');
      console.log('  npx httptap sysproxy off       # 还原系统代理');
      console.log('  npx httptap trust              # 把 CA 写入系统信任库（HTTPS 解密需要）');
      console.log('');
      console.log('完整命令与选项: npx httptap --help');
      console.log('或给整个终端设置代理环境变量:');
      console.log('  eval "$(npx httptap on)"       # 启动并注入环境变量（zsh 也可用 source <(npx httptap on)）');
      console.log('  eval "$(npx httptap off)"      # 停止并清除环境变量');
      console.log('');
      console.log('HTTPS 抓包需要客户端信任 CA 证书（首次运行自动生成）:');
      console.log(`  ${CA_FILE}`);
      console.log('');
      console.log('按 Ctrl+C 退出');
    },
  });
}

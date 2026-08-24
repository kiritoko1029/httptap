'use strict';

// 进程归属：把「连到代理的 TCP 连接的客户端源端口」反查回本机进程（pid + 进程名）。
// 原理与 Proxyman 相同：本机代理能看到连接的本地四元组，lsof 快照可以查出
// 127.0.0.1:<源端口> 这个端点属于哪个进程。
//
// 性能考虑：lsof 每次调用几十毫秒，不能按请求逐个跑。这里用带 TTL 的快照缓存，
// 一批并发连接（比如浏览器开页面）通常只触发 1~2 次刷新。

const { execFile } = require('child_process');

function createProcessMap(proxyPort, { ttlMs = 800 } = {}) {
  let cache = new Map(); // remotePort -> { pid, name }
  let cacheAt = 0;
  let inflight = null;

  function refresh() {
    if (inflight) return inflight;
    inflight = new Promise((resolve) => {
      // +c 0：完整进程名（默认截断到 9 字符）；只看与代理端口相关的 ESTABLISHED 连接
      execFile(
        'lsof',
        ['-nP', '+c', '0', '-iTCP:' + proxyPort, '-sTCP:ESTABLISHED'],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          // lsof 没有匹配行时 exit code = 1，属于正常情况
          const map = new Map();
          for (const line of String(stdout || '').split('\n')) {
            // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
            // 例: Google Chrome  1234  user  25u  IPv4 0x..  0t0  TCP 127.0.0.1:51234->127.0.0.1:8888 (ESTABLISHED)
            // COMMAND 可能含空格，用「惰性名称 + 固定列数」的方式解析
            const m = line.match(/^(.*?)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+TCP\s+(\S+):(\d+)->(\S+):(\d+)\s+\(ESTABLISHED\)/);
            if (!m) continue;
            const localPort = Number(m[4]);
            const foreignPort = Number(m[6]);
            // 只要客户端侧的行（对端是代理端口）；服务端那行是本进程，跳过
            if (foreignPort !== proxyPort) continue;
            map.set(localPort, { pid: Number(m[2]), name: m[1] });
          }
          cache = map;
          cacheAt = Date.now();
          inflight = null;
          resolve();
        }
      );
    });
    return inflight;
  }

  return {
    // 返回 { pid, name } 或 null
    async lookup(remotePort) {
      if (!remotePort) return null;
      const fresh = Date.now() - cacheAt < ttlMs;
      if (fresh && cache.has(remotePort)) return cache.get(remotePort);
      if (!fresh) await refresh();
      if (cache.has(remotePort)) return cache.get(remotePort);
      // 快照可能早于这条连接的建立时间，强制再刷一次
      await refresh();
      return cache.get(remotePort) || null;
    },
  };
}

module.exports = { createProcessMap };

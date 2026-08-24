# httptap (HTTP Interceptor)

拦截并监控终端 HTTP/HTTPS 网络请求的命令行工具，带 Web 界面（类似简化版 Charles）。

## 功能

- HTTP / HTTPS（MITM 解密）请求拦截
- **按进程筛选**：每条请求自动归属到本机进程（名称 + PID），界面可按进程过滤——浏览器、桌面应用、终端命令都适用
- **拦截本机应用**：`httptap sysproxy on` 一键把系统代理指向 httptap，接管浏览器等 GUI 应用的流量
- **按命令拦截**：`httptap run -- <命令>` 只拦截指定终端进程的流量，不影响其他程序
- **兼容已有系统代理**：自动串联到本机已配置的代理（上游 chaining），接管/还原即时切换，不会因为走 httptap 就绕过你原来的代理
- Web 界面实时查看：方法、状态码、URL、大小、耗时
- 按根域名分组、置顶、折叠，支持排序与多条件筛选
- 请求/响应头和请求/响应体查看，JSON 自动格式化与语法高亮
- SSE 流式响应（如 AI 接口）事件级解析与聚合文本视图
- 一键导出 cURL / fetch 代码
- URL 过滤、一键清空、最多保留最近 500 条

## 快速开始（npx，无需安装）

```bash
npx httptap          # 前台运行：代理端口 8888，Web 界面端口 8880，Ctrl+C 退出
npx httptap --help   # 查看完整命令与选项
```

启动后（前台 `npx httptap` 或后台 `httptap on`）会自动用系统默认浏览器打开 Web 界面，终端里地址以亮青色加粗显示；不想自动打开可加 `--no-open`（遵循 `NO_COLOR` 约定，管道/日志中地址输出为纯文本）。

后台运行并自动注入代理环境变量（当前终端即刻可用）：

```bash
eval "$(npx httptap on)"       # 后台启动 + 设置 http_proxy/https_proxy/no_proxy/NODE_EXTRA_CA_CERTS
eval "$(npx httptap off)"      # 停止 + 清除环境变量
# zsh 用户也可以用 source <(npx httptap on)
```

自定义端口（`on` 子命令同样支持）：

```bash
npx httptap --proxy-port 8888 --ui-port 8880
```

## 源码方式

```bash
git clone https://github.com/kiritoko1029/httptap.git
cd httptap
npm install
npm start
```

## 使用

### 拦截本机应用（浏览器 / GUI 应用，macOS / Windows）

浏览器等 GUI 应用读的是系统代理而非环境变量，用 `sysproxy` 一键接管：

```bash
npx httptap trust           # 首次：CA 写入系统信任库（HTTPS 解密需要，macOS 要 sudo 密码，Windows 可能弹安全警告）
npx httptap sysproxy on     # 系统 HTTP/HTTPS 代理指向 httptap，自动串联到原系统代理
npx httptap sysproxy status # 查看接管状态
npx httptap sysproxy off    # 还原接管前的系统代理设置
```

接管后打开 Web 界面（http://127.0.0.1:8880 ），每条请求会标注来源进程（如 `Google Chrome`、`Code`），用左上角的「进程」下拉框即可只看某个应用的流量。

说明与边界：

- 接管前的系统代理配置会被保存，`sysproxy off` 或 `httptap off`（含 Ctrl+C 退出前台服务）都会自动还原，不会把系统网络留在坏状态
- 应用流量链路为 `应用 → httptap → 原系统代理 → 目标`，原有代理规则（含绕过列表）继续生效
- 只对「读系统代理」的应用有效（覆盖浏览器和绝大多数桌面应用）；完全无视系统代理、直连硬连的程序抓不到
- 对证书做了固定（pinning）的应用无法解密其 HTTPS 内容（这是 MITM 抓包的固有边界）；Firefox 使用独立 CA 库，需在其设置里单独信任 `~/.httptap/certs/ca.pem`
- macOS 上接管通过网络设置生效；Windows 上通过注册表（HKCU，无需管理员）生效，但已运行的应用可能要重启或刷新后才会使用新设置

### 拦截单个进程（httptap run，终端命令）

只想看某个程序的请求时，用 `run` 把它包起来——代理变量只注入这个子进程，终端里的其他程序不受影响：

```bash
npx httptap run -- curl https://example.com
npx httptap run -- npm install
npx httptap run -- node your-script.js
npx httptap run -- sh -c '需要 shell 语法时用 sh -c 包一层'
```

首次执行会自动后台启动代理服务（之后复用同一个实例），请求记录在 http://127.0.0.1:8880 实时查看；子进程退出后代理继续常驻，方便回头翻记录，用完执行 `npx httptap off` 停止。

`run` 会自动给子进程注入 httptap CA 的信任配置（`NODE_EXTRA_CA_CERTS`、`CURL_CA_BUNDLE`、`SSL_CERT_FILE` 等，使用与系统根证书合并的 bundle），所以 curl / Node / Python / git 这类程序开箱即可被抓包，不用动系统钥匙串。

### 一键启动（整个终端走代理）

```bash
source ./proxy.sh on    # 启动服务 + 设置代理环境变量 + 打开 Web 界面
source ./proxy.sh off   # 停止服务 + 清除环境变量，恢复网络
```

`on` 会自动完成：后台启动代理和 Web 界面、设置 `http_proxy`/`https_proxy`/`no_proxy`/`NODE_EXTRA_CA_CERTS`、打开浏览器。

### 手动方式

启动后在浏览器打开 http://127.0.0.1:8880 ，然后在终端设置代理：

```bash
export http_proxy=http://127.0.0.1:8888
export https_proxy=http://127.0.0.1:8888
export no_proxy=127.0.0.1,localhost   # 本地地址（含 Web 界面）绕过代理，避免回环
```

之后终端里发出的请求（curl、wget、npm、git 等）都会出现在 Web 界面中。

> 注意：不要让请求的目标指向代理自身（127.0.0.1:8888），否则代理会自我连接形成回环，
> 耗尽系统临时端口并报 `EADDRNOTAVAIL`。工具已内置防护会拦截这类请求，
> 但如果是在系统级/浏览器里配置了代理，请把 `127.0.0.1` 和 `localhost` 加入绕过列表。

临时单次使用（以 curl 为例）：

```bash
curl -x http://127.0.0.1:8888 https://example.com
```

### HTTPS 抓包

HTTPS 内容解密基于 MITM：代理会用自己生成的 CA 给目标站点重新签发证书，所以客户端必须信任这个 CA（首次运行时生成在 `~/.httptap/certs/ca.pem`）。不信任的话，客户端会报证书错误（如 `unable to verify the first certificate`），属于预期现象。

**Node.js 程序**（kimi、npm 等，最简单，无需 sudo）：

```bash
export NODE_EXTRA_CA_CERTS=~/.httptap/certs/ca.pem
```

**系统级信任**（curl / git / 浏览器等，macOS）：

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/.httptap/certs/ca.pem
```

临时测试也可以在客户端侧跳过校验，如 `curl -k`（不推荐长期使用）。

### 恢复网络

抓包结束后记得取消环境变量，否则代理一关所有流量都会失败：

```bash
unset http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS
```

## 已有系统代理？（上游串联）

本机已经配置了系统代理（Clash、公司代理等）时，httptap 会自动把拦截到的请求继续转发给上游代理，流量链路为 `进程 → httptap → 原系统代理 → 目标`，不会因为走了 httptap 就绕过你原来的代理规则。

- **自动探测顺序**：终端环境变量（`http_proxy`/`https_proxy`）→ macOS 系统代理（`scutil --proxy`）
- **显式控制**：`npx httptap --upstream http://127.0.0.1:7890` 指定上游；`--upstream none` 关闭串联（直连）
- **回环防护**：探测到指向 httptap 自身的代理配置会自动忽略，不会自我回环
- **绕过列表**：环境变量 `no_proxy` 与系统「忽略这些主机的代理设置」（含 CIDR、`*.suffix`）命中的目标直接放行
- **限制**：上游仅支持 HTTP 代理；系统代理若只配了 SOCKS 或 PAC 自动配置，对应目标会直连并在启动日志里提示

启动时会在日志里打印实际生效的上游（如 `上游代理: http→127.0.0.1:7890，https→127.0.0.1:7890（来源: env）`），也可通过 `GET /api/config` 查看。

## Windows 支持

核心功能跨平台可用（`run`、上游串联、Web 界面、进程归属），平台差异如下：

| 能力 | macOS / Linux | Windows |
| --- | --- | --- |
| 系统代理探测 | `scutil --proxy` | 注册表 `HKCU\...\Internet Settings` |
| 系统代理接管（sysproxy） | `networksetup` | 注册表改写（HKCU，无需管理员）；已运行的应用可能要重启后才感知 |
| 进程归属 | `lsof` | `netstat -ano` + `tasklist` |
| CA 信任（trust） | 系统钥匙串（sudo） | 当前用户根证书存储（certutil，可能弹安全警告） |
| 环境变量注入（on/off） | `eval "$(httptap on)"`（bash/zsh） | PowerShell：`httptap on \| Invoke-Expression` |

Windows 下 `run` 通过 cmd.exe 启动子进程（兼容 npm 这类 .cmd 命令）；绕过列表支持 Windows 风格的 `127.*`、`10.*` 通配写法。

## API

| 接口 | 说明 |
| --- | --- |
| `GET /api/requests` | 请求列表（摘要） |
| `GET /api/requests/:id` | 单个请求完整详情 |
| `GET /api/stream` | SSE 实时推送新请求 |
| `GET /api/config` | 代理端口与上游代理信息 |
| `POST /api/clear` | 清空记录 |

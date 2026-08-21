# httptap (HTTP Interceptor)

拦截并监控终端 HTTP/HTTPS 网络请求的命令行工具，带 Web 界面（类似简化版 Charles）。

## 功能

- HTTP / HTTPS（MITM 解密）请求拦截
- Web 界面实时查看：方法、状态码、URL、大小、耗时
- 按根域名分组、置顶、折叠，支持排序与多条件筛选
- 请求/响应头和请求/响应体查看，JSON 自动格式化与语法高亮
- SSE 流式响应（如 AI 接口）事件级解析与聚合文本视图
- 一键导出 cURL / fetch 代码
- URL 过滤、一键清空、最多保留最近 500 条

## 快速开始（npx，无需安装）

```bash
npx httptap          # 前台运行：代理端口 8888，Web 界面端口 8880，Ctrl+C 退出
```

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

### 一键启动（推荐）

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

## API

| 接口 | 说明 |
| --- | --- |
| `GET /api/requests` | 请求列表（摘要） |
| `GET /api/requests/:id` | 单个请求完整详情 |
| `GET /api/stream` | SSE 实时推送新请求 |
| `POST /api/clear` | 清空记录 |

# ironrdp-wasm 可行性验证（波 0 时间盒调研）

- 日期：2026-10-13
- 结论：**可行**。`wasm-pack build --target web` 在本机（cargo 1.95.0, arm64-macOS）成功产出 `pkg/`，API 面与 eNest 的 `net.socket.serveWs` 桥模型吻合，建议按「vendored WASM + ws 桥」路线接入 RDP 插件。
- 源：https://github.com/electerm/ironrdp-wasm（MIT；本质是 Devolutions IronRDP `ironrdp-web` crate 的薄再导出：`pub use ironrdp_web::*`）

## 构建过程与坑

| 步骤 | 结果 |
|------|------|
| `rustup target add wasm32-unknown-unknown` | 成功 |
| `cargo install wasm-pack --locked` | 成功（wasm-pack v0.15.0，约 10 分钟） |
| `wasm-pack build --target web --out-dir pkg --release`（首次） | **失败**：wasm-pack 尝试下载 binaryen `version_117` 的 arm64-macos 包，该 release 资产不存在（上游 wasm-pack 已知问题） |
| `Cargo.toml` 追加 `[package.metadata.wasm-pack.profile.release] wasm-opt = false` 后重试 | **成功**（增量 2.8s；Rust 侧全量编译约 20 分钟，target 目录约 635MB） |

注意：**禁用 wasm-opt 后产物未做 size 优化**（见下），如走分发路线可在 CI 用 x64 主机或手工安装新版 binaryen 启回 wasm-opt。

## 产物体积（wasm-opt = false）

| 文件 | 大小 |
|------|------|
| `rdp_client_bg.wasm` | **6.7MB** |
| `rdp_client.js`（wasm-bindgen 胶水） | 67KB |
| `rdp_client.d.ts` | 14KB |

wasm-opt 关闭是主因（IronRDP 官方 web 构建通常可压到 ~2-3MB 级）。**插件分发角度可接受**：eNest 插件包为本地 zip 资产（非浏览器首屏），6.7MB 在插件包体积预期内；如需收紧，在 x86_64 CI 机器上构建或 wasm-opt=true 重试即可。

## API 面（rdp_client.d.ts 实测导出）

构建器模式（`SessionBuilder` → `Session`）：

- `SessionBuilder`：`username / password / destination("host:port") / proxyAddress(ws url) / authToken / desktopSize(DesktopSize) / renderCanvas(canvas) / extension(Extension) / setCursorStyleCallback / canvasResizedCallback / remoteClipboardChangedCallback / forceClipboardUpdateCallback / connect(): Promise<Session>`
- `Session`：`run(): Promise<SessionTerminationInfo> / shutdown() / resize(w,h,scale?) / applyInputs(InputTransaction) / releaseAllInputs() / synchronizeLockKeys(...) / desktopSize() / invokeExtension(Extension) / onClipboardPaste(ClipboardData)`
- 输入：`DeviceEvent` + `InputTransaction`（键鼠事件队列）
- 剪贴板：`ClipboardData / ClipboardItem`
- 其它：`RdpFile / RDCleanPathDetails / IronError(+Kind) / RotationUnit`、`setup(log_level)`、默认导出 `init()`（加载 .wasm）

## 传输层期望 → 与 eNest `net.socket.serveWs` 的对接

关键发现（读 example/lib/session.js 与 example/lib/rdp-proxy.js）：

1. **客户端不直接连 RDP 服务器**。`SessionBuilder.proxyAddress(wsUrl)` 要求一个 WebSocket「RDCleanPath 代理」：浏览器 WASM 把目标地址 + X.224 连接请求打包成 ASN.1 DER 的 RDCleanPath Request 发给 ws 代理；代理负责 TCP 连接、X.224 协商、**TLS 握手（RDP 自签证书，rejectUnauthorized:false）**，再把证书链 + X.224 应答打包回浏览器，之后做 ws ↔ TLS 双向中继。
2. 上游 example 的代理是 Node `express-ws` + `tls` 实现的（example/server.js + lib/rdp-proxy.js）。

**与波 0 交付的差距与接线方案**：eNest 的 `net.socket.serveWs` 桥是「裸 TCP 字节流 ↔ ws 二进制」直通，**不含 RDCleanPath/TLS 层**。两条可行接线：

- **方案 A（推荐，改动小）**：在 eNest 主进程新增 `rdp-proxy` 变体桥（或 socketBridge 的 `mode: 'rdp'`）：复用 `node:net` TCP + `node:tls`，把 example/lib/rdp-proxy.js 的 RDCleanPath 握手协议（约 500 行纯 Node，MIT）移植到 socketBridge 旁路服务中，仍只绑 127.0.0.1 + 一次性 token。RDP 插件：`ssh.workbench tunnel.open`（3389 → 本地口）→ `net.socket.connect(127.0.0.1:口)` → `serveRdpWs(socketId)` → `new SessionBuilder().proxyAddress(wsUrl)`。
- **方案 B（零主进程改动）**：RDP 插件页内 vendored 一份 JS 实现的 RDCleanPath 客户端——不可行，TLS 必须在主进程（浏览器 WebSocket 无裸 TLS）。

即：**RDP 需要在 socketBridge 上加一个 ~500 行的 RDCleanPath/TLS 桥模式**（已在波 1 backlog 建议中记录），其余 API 面完全就绪。

## 回退建议（若 WASM 路线受阻）

- **Rust sidecar 随插件分发**：IronRDP 原生 CLI（`ironrdp-cli`/`sdev`）作为插件包内二进制，经 `net.socket`/`ssh exec` 调用——体积更大（原生二进制 10MB+）、跨平台需按 os/arch 打包，不推荐首选。
- 或保守方案：RDP 插件先支持 **noVNC（VNC）**（纯 JS，ws 桥现成即用），RDP 等 RDCleanPath 桥模式落地后再开。

## 环境残留

- `/tmp/ironrdp-wasm`：clone + 635MB target + `pkg/` 产物（验证用，未入仓库；可随时 `rm -rf` 清理）。
- `~/.cargo/bin/wasm-pack`（v0.15.0）与 wasm32-unknown-unknown target 已安装，后续构建即取即用。

## 时间盒执行说明

时间盒 20 分钟内完成：clone、源码研读（build.js / lib.rs / example 传输层）、工具链安装、首次构建尝试；binaryen 下载坑的定位与 wasm-opt=false 重试略超时盒（Rust 全量编译 ~20min 为机器时间，非人工时间）。结论不阻塞波 0 主交付。

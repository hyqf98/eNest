# Linux 剪贴板辅助程序

`linux.c` 是常驻的 JSON-line helper。仅接受 `capabilities`、`requestPermission`、`target`、`source`、`readFiles`、`writeFiles`、`paste`；没有任意命令、脚本或按键注入入口。stdout 只输出 `{id,result}` 或 `{id,error}`。

## X11

- 文件传输支持 `text/uri-list` 和 `x-special/gnome-copied-files`，包括 ICCCM INCR 分块。最多 1000 个文件、1 MiB MIME 内容；仅接受本机绝对文件 URI。写入前核验文件存在。文件引用不会复制文件内容。
- 来源只读真实 CLIPBOARD selection owner 的窗口/PID/WM_CLASS。无法从隐藏 owner 解析应用时返回 `null`，不以当前前台应用补猜来源。
- `target` 返回 helper 会话内的随机 token。记录窗口、PID、`/proc/<pid>/stat` 启动时间、WM_CLASS，监听窗口销毁；30 分钟过期。helper 重启、窗口销毁、PID 重用或类标识变化都会使旧 token 失效。
- 回贴请求通过 EWMH 请求恢复原窗口，随后同时检查活动窗口和实际键盘焦点。只有仍为同一窗口且用户未按住修饰键时才经 XTest 发送粘贴。已知终端使用 Ctrl+Shift+V，其余使用 Ctrl+V。系统拒绝焦点恢复时明确返回失败，保留剪贴板内容供手动粘贴。
- 不调用 `XSetInputFocus` 强夺焦点。最后一次焦点校验与按键请求在短暂 X server grab 内完成，随后释放全部合成按键和 grab。

## Wayland

helper 不把 Xwayland 视图当作完整 Wayland 桌面，也不向未知当前窗口盲发 Ctrl+V。

通过 D-Bus 探测 `org.freedesktop.portal.Clipboard` v1 和 `RemoteDesktop` v2。只有用户显式触发 `requestPermission` 才创建会话，依次调用 CreateSession、SelectDevices（types=0，仅剪贴板，不请求键盘、鼠标或截屏）、RequestClipboard、Start。等待授权最多 12 秒；取消、拒绝、超时或桌面不支持 clipboard-only session 都返回具体降级原因。不会自动弹授权框。

授权成功且 `clipboard_enabled=true` 后支持：

- SelectionRead 的文件描述符传输，解析 URI / GNOME 文件 MIME。
- `application/vnd.portal.filetransfer` 通过 Documents portal 的 RetrieveFiles 解析。文件访问可能仅在本次 portal 会话有效，使用历史记录时仍需重新检查文件是否可读。
- SetSelection / SelectionTransfer / SelectionWrite / SelectionWriteDone 的文件列表写入。
- Session.Closed 撤销授权后即时降级，不继续访问剪贴板。

通用 portal 没有可靠的应用来源和原窗口身份/恢复接口，所以 Wayland 始终 `sourceApp=false`、`paste=false`，显示来源未知与“已复制，请手动粘贴”。剪贴板授权不会被描述为获得安全回贴能力。未授权时 helper 的 `files=false` 只表示 helper 的能力；宿主 Electron 自身的文件 URI MIME 读写仍可独立工作。

portal 参考协议：

- https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Clipboard.html
- https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html
- https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.FileTransfer.html

## 构建与验证

Debian/Ubuntu **构建机**依赖：`build-essential pkg-config patchelf libglib2.0-dev libjson-glib-dev libx11-dev libxtst-dev`。运行 `node native/clipboard/build.mjs`，会编译 helper，并将 `ldd` 解析出的全部非 glibc 直接/间接共享库放进 `native/bin/lib`。helper 的 RUNPATH 为 `$ORIGIN/lib`，每个共享库的 RUNPATH 为 `$ORIGIN`，所以间接依赖也不依赖系统的 json-glib、GLib 或 XTest 安装。不会调用用户的 xclip、xdotool、wl-copy 等 CLI。

打包器通过 Linux 专属 extraResources 过滤规则把 `clipboard-helper`、`lib/`、`licenses/`、`linux-dependencies.json` 和许可证说明复制到 `resources/native`，不会混入 macOS helper 或 Windows PowerShell 脚本。清单记录架构、构建 glibc、文件 SHA-256 与 Debian 源包版本。打包后再次核验 ELF/CPU 架构、依赖摘要及 glibc 2.35 构建基线；本机只有 Mach-O 时必须失败，不能冒充 Linux 发行包。构建时缺失库、解析失败或打包后仍从系统解析非 glibc 库会直接失败；临时构建目录在完成或失败后删除。GIO 的扩展目录在 bundle 内隔离为空目录，避免加载另一发行版的插件模块。

glibc 与 ELF loader 必须配套，**不随应用覆盖**。发布应在最低支持的 glibc 基线上，按 x64 / arm64 各自构建；`ENEST_NATIVE_ARCH` 或 `npm_config_arch` 与 builder 架构不符会拒绝构建。下面的可复现隔离构建使用 Debian 12（glibc 2.36），仅用于 helper 的历史隔离验证，**不能作为当前要求 glibc <=2.35 的发行输入**；正式发布使用 Ubuntu 22.04 等满足基线并经过相同闭包验证的构建环境。这些结果不承诺 musl/Alpine 支持。macOS 生成的 helper 不能直接用于 Linux 发行包。

在仓库根目录运行下面的多阶段容器验证：构建阶段安装开发依赖，验证阶段对 bundle 运行 Xvfb / portal 测试，最终 runtime 阶段直接复制 bundle 到干净 Debian 基础镜像，**不运行 apt 安装任何库或 CLI**。

```sh
node --test tests/native/clipboard/linux-build.test.mjs
docker build -f native/clipboard/linux-bundle.Dockerfile -t enest-clipboard-bundle-test .
printf '%s\n' '{"id":1,"command":"capabilities"}' | docker run --rm -i enest-clipboard-bundle-test
```

无桌面连接的最终容器应正常返回 JSON，能力为 false，原因是“未连接 X11 显示服务”；不能出现动态库缺失或找不到 CLI。实际桌面能力仍由运行用户的 X11/Wayland 会话决定。

2026-10-13 已在 ARM64 执行：bundle 共 19 个共享库，均取得源包版权/许可证；bundle 上的 Xvfb 与六个 portal 场景通过。干净 runtime 的 `dpkg-query -W` 输出与 Debian 基础镜像完全一致，并成功处理 capabilities、target、source、readFiles、paste 五类请求，无加载或 CLI 错误。Linux x64 构建未在当前 ARM64 开发环境中实测。

隔离回归测试另需 `xvfb xauth python3-xlib python3-dbus python3-gi dbus-x11`：

```sh
cc -std=c11 -Wall -Wextra -Werror -O2 native/clipboard/linux.c -o /tmp/clipboard-helper $(pkg-config --cflags --libs gio-2.0 json-glib-1.0 x11 xtst)
xvfb-run -a python3 tests/native/clipboard/linux-smoke.py /tmp/clipboard-helper
dbus-run-session -- python3 tests/native/clipboard/linux-portal-smoke.py /tmp/clipboard-helper
```

已在 Debian 12 ARM64 容器以 `-Wall -Wextra -Werror` 编译，并通过上述两个脚本：Xvfb 验证真实 X selection / INCR 和 XTest 事件、修饰键及失焦拒绝、窗口身份失效、超大请求恢复；私有 D-Bus 假 portal 验证请求形状、URI / FileTransfer FD 读取、文件列表写入、授权撤销，以及取消、拒绝、未开启剪贴板、不支持 clipboard-only 的降级。

同样的测试已在 `-fsanitize=address,undefined` 构建下通过，未出现内存或未定义行为报告。

这些隔离测试不能替代真实桌面验收。发布前仍需在 GNOME/KDE Wayland 与至少一个 EWMH X11 桌面检查授权界面、拒绝授权、窗口关闭/切换、终端与文件管理器粘贴、多屏及非英文文件名。此 macOS 开发机不声称完成 Linux 实机验证。

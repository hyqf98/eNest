# 开发加载与热更新

开发注册不会复制或安装插件。壳读取标准文件，或连接声明的开发服务——服务未运行时壳按插件 `package.json` 解析出的启动命令自动拉起（进程由壳管理，忘记插件/退出时回收；端口被其它进程占用时自动改用空闲端口，日志面板可见 dev server 输出）。

## 启动命令解析（壳子零预设）

壳子不写死任何工具链。启动/构建命令按以下优先级从插件源码根的 `package.json` 解析，各维度独立回退：

| 维度 | 解析链 | 缺省 |
| --- | --- | --- |
| dev 服务 URL | `enest.dev.url` → `plugin.json development.main` | 无（纯静态源码预览） |
| 启动命令 | `enest.dev.command`（原始命令逃生舱）→ `enest.dev.manager` + `enest.dev.script` → 锁文件检测包管理器 + `scripts.dev` → `scripts.start` | npm |
| 端口漂移参数 | `enest.dev.portArgs` 模板（`{port}` 占位） | `["--","--port={port}"]` |
| 构建命令 | `enest.build.command` / `manager` + `script` → 锁文件检测 + `scripts.build` → `scripts.pack` | npm |
| 产物目录 | `enest.output` | `dist` |

- **包管理器**：优先看 `enest.dev.manager` 显式声明；否则按锁文件检测（插件目录向上最多 4 级找 `pnpm-lock.yaml`→pnpm、`yarn.lock`→yarn、`bun.lockb|bun.lock`→bun、`package-lock.json`→npm，兼容 workspace 根持锁），都找不到按 npm。npm / yarn / pnpm / bun 四种统一走 `<manager> run <script>`。
- **原始命令逃生舱**：非 node 工具链（如 `deno task dev`、`make dev`）写 `enest.dev.command`，整行交给系统 shell 执行；命令里的 `{port}` 占位符在端口漂移时替换为实际端口。
- **环境变量**：实际端口始终注入 `ENEST_DEV_PORT`，任意工具链的启动脚本都可读取。
- **零配置即可用**：不写 `enest` 段时，`development.main` + `scripts.dev`（或 `scripts.start`）+ 锁文件检测就是完整声明；官方插件全部如此工作。
- **纯静态 HTML 插件**：没有 `package.json` 或没有可用脚本时不拉服务，直接源码静态预览 + 文件变更自动重载。

```jsonc
// package.json（可选扩展，全部字段可省略）
{
  "scripts": { "dev": "vite", "build": "vite build" },
  "enest": {
    "dev": {
      "url": "http://127.0.0.1:5173/",
      "manager": "pnpm",
      "script": "dev",
      "portArgs": ["--port", "{port}"],
      "command": "deno task dev --port {port}"
    },
    "build": { "script": "build" },
    "output": "dist"
  }
}
```

字段 Schema 见 [enest-package.schema.json](../enest-package.schema.json)。畸形或类型不符的 `enest` 字段会被静默忽略，不会阻断加载。

## dev / prod 两种模式

开发者控制台的每个插件可切换 **开发（dev）/ 正式包（prod）** 模式：

- **dev（默认）**：自动拉起开发服务走框架 HMR；无服务声明时源码静态预览（保存后自动重载）。调试快捷键（仅 dev 插件与壳窗口响应）：插件页内 **F12 / ⌘⌥I / Ctrl+Shift+I** 开关 DevTools，**⌘R / Ctrl+R** 重载插件（开发服务掉线时重载会自动重新拉起）。
- **prod（正式包）**：模拟打包后正式安装的形态——产物缺失或版本落后时自动执行解析出的构建命令，然后经标准产物路径 + 生产 CSP 加载 `enest.output` 产物，不连接开发服务、不挂文件监听。「重新构建」按钮可随时手动重跑构建。发行前务必在此模式验证（生产 CSP 会拒绝开发服务下可用的内联脚本等宽松行为）。

模式选择持久化在开发注册记录里，重启壳后保持。

## Vue、React 与 Vite

1. 在插件目录执行依赖安装（首次）。
2. 壳设置 → 开发者，选择含 `plugin.json` 的源码目录；开发服务未运行也没关系，壳会按解析出的命令自动拉起。
3. 默认读取 `development.main`（或 `enest.dev.url`），端口与启动脚本一致且全仓唯一（现按插件分配 5173–5209）。
4. 加载后立即打开壳内插件页，HMR 由 Vite 处理；纯前端插件无需已有 `dist`。声明 Node 后端的插件必须先构建 `dist/backend`，后端入口不会由 Vite 开发服务器提供。

```json
{
  "development": { "main": "http://127.0.0.1:5173/" }
}
```

开发地址覆盖值保存于开发注册记录，不修改源码。支持明确配置的局域网地址；只放行该 origin 及其 HMR WebSocket。远程服务器需要自行配置监听地址、防火墙和 HMR 主机。不要把 Vite 的 `0.0.0.0` 监听地址填成实际访问地址。

修改 preload 或主进程必须重启壳；普通插件页面的 HMR 不需要重启。后端源码修改后重新运行插件构建（prod 模式的「重新构建」即可），再关闭/重载插件实例；已有 utility process 不接受前端 HMR 更新。带后端的完整产物验收使用 prod 模式，见[本机后端](backend.md)。更换服务器地址后重新加载开发注册，旧视图会关闭并创建新的权限边界。

## 原生静态源码

dev 模式下无开发服务声明时，不连接服务器。公开映射固定为：

| 页面 URL | 源码文件 |
|---|---|
| `index.html` | 根 index.html |
| `src/**` | 根 src/** |
| `assets/**` | public/assets/** |

只支持浏览器能直接运行的 HTML、JS、CSS。TS、JSX、Vue 单文件组件和 npm 裸模块导入需要构建工具。`.git`、`.env`、package.json、node_modules 不由源码协议提供。

源码预览模式下壳监听目录变更并在保存后自动重载。开发插件默认不参加普通闲时休眠/LRU，避免中断 HMR；停止调试会释放实例，移除只删除注册记录，不删除源码。

## 发布前预览

切到 **prod（正式包）模式**：壳执行解析出的构建命令并以生产 CSP 和标准产物路径加载，不复制安装。最后应解包 `.enestplugin` 再验一次，确认资源、图标、README 和截图均不依赖源码树或外部 CDN。

dev 模式下服务器未启动时显示加载失败；启动服务器后重新加载（或依赖自动拉起）。不要通过关闭沙箱、放开任意 localhost 端口、加载 file:// 或增加宿主文件监听解决白屏。

日志与 DevTools 针对列表中的指定插件操作。自动测试使用独立 `ENEST_TEST_DATA_ROOT` 与 `ENEST_TEST_USER_DATA`，不污染用户数据。

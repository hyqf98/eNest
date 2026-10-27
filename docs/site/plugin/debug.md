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

字段 Schema 见[官方 package 扩展 Schema](https://github.com/hyqf98/eNest_plugin/blob/main/docs/enest-package.schema.json)。畸形或类型不符的 `enest` 字段会被静默忽略，不会阻断加载。

## 自动识别，无模式切换

开发者控制台只有开发模式：壳后台自动识别插件源码形态，列表标签显示识别结果——「开发服务 · Vite / Next.js / Nuxt / webpack / 自定义命令」「静态 HTML」「构建产物」，没有 dev/prod 切换，也没有「重新构建」按钮。

- **有开发服务声明**（`development.main` 或 `enest.dev.url`）：优先连接已在运行且身份匹配的服务；未运行时按解析出的启动命令自动拉起并等待就绪，走框架 HMR。调试快捷键（仅 dev 插件与壳窗口响应）：插件页内 **F12 / ⌘⌥I / Ctrl+Shift+I** 开关 DevTools，**⌘R / Ctrl+R** 重载插件（开发服务掉线时重载会自动重新拉起）。
- **服务离线但已有版本一致的构建产物**：按 `enest.output`（缺省 `dist`）产物目录预览，标签显示「构建产物」。产物版本与源码不一致时拒绝加载并提示构建命令；更新产物需在插件目录自行运行构建脚本（如 `npm run build`）。
- **无服务声明**：源码静态预览（保存后自动重载），标签显示「静态 HTML」。

框架识别只读 `package.json` 的依赖指纹与启动命令内容（如含 `vite` / `next` / `nuxt` / `webpack`），识别结果不落盘。旧的 dev.json 记录里多余的 `mode` / `preview` 字段会被忽略并丢弃，不影响加载。

## Vue、React 与 Vite

1. 在插件目录执行依赖安装（首次）。
2. 壳设置 → 开发者，选择含 `plugin.json` 的源码目录；开发服务未运行也没关系，壳会按解析出的命令自动拉起。
3. 默认读取 `development.main`（或 `enest.dev.url`），端口与启动脚本一致，避免与其它插件开发服务冲突；不要把某个仓库的端口范围当作宿主协议。
4. 加载后立即打开壳内插件页，HMR 由 Vite 处理；纯前端插件无需已有 `dist`。声明 Node 后端的插件必须先构建 `dist/backend`，后端入口不会由 Vite 开发服务器提供。

```json
{
  "development": { "main": "http://127.0.0.1:5173/" }
}
```

开发地址覆盖值保存于开发注册记录，不修改源码。支持明确配置的局域网地址；只放行该 origin 及其 HMR WebSocket。远程服务器需要自行配置监听地址、防火墙和 HMR 主机。不要把 Vite 的 `0.0.0.0` 监听地址填成实际访问地址。

修改 preload 或主进程必须重启壳；普通插件页面的 HMR 不需要重启。后端源码修改后在插件目录重新运行构建命令（如 `npm run build`），再关闭/重载插件实例；已有 utility process 不接受前端 HMR 更新。带后端的完整产物验收见[本机后端](backend.md)。更换服务器地址后重新加载开发注册，旧视图会关闭并创建新的权限边界。

## 原生静态源码

无开发服务声明时，不连接服务器。公开映射固定为：

| 页面 URL | 源码文件 |
|---|---|
| `index.html` | 根 index.html |
| `src/**` | 根 src/** |
| `assets/**` | public/assets/** |

只支持浏览器能直接运行的 HTML、JS、CSS。TS、JSX、Vue 单文件组件和 npm 裸模块导入需要构建工具。`.git`、`.env`、package.json、node_modules 不由源码协议提供。

源码预览模式下壳监听开发注册目录，保存后自动刷新；监听属于开发注册，不依赖普通插件 Tab 是否打开。关闭样式台不会停止当前主题首页的监听；移除开发注册才释放源码监听。移除时宿主按序释放该注册的全部资源：关闭视图 → 停止开发服务进程树 → 停止文件监听 → 停后台/后端进程与定时任务 → 注销热键与「打开方式」路由 → 移出注册表并清持久记录；插件数据保留，随时可重新加载同一目录。

### 主题工作区的开发刷新

普通插件页有开发服务时由框架 HMR 更新；主题的独立 Workspace 则走隔离的 `enest-home://` 源码协议，不直接连接第三方 Vite 服务。修改 `homes/**`、`src/**`、样式或 `plugin.json` 后，宿主防抖重读清单并等待主题贡献同步，再刷新权威外观快照和当前来源的 Workspace。新页面仍须在隐藏状态完成 ready 与当前路由 ACK，随后替换旧页面；保持当前路由和宿主可见性，加载失败保留上一个可用页面。源码资源不走发布缓存，不要求打包、重装或切换主题。

监听忽略 `.git`、`node_modules` 和构建产物目录，避免打包触发循环刷新。无效或写入中的清单不会先撤掉当前主题；修正保存后可继续重试。普通 dev 插件仍默认不参加闲时休眠/LRU。停止普通 Tab 仅释放实例，移除开发注册只删除记录、不删除源码。

以上自动更新适用于插件源码。修改 eNest 宿主主进程或 preload 本身仍须重启 `npm run dev` 一次，普通页面 HMR 不能替换正在执行的主进程模块。

## 发布前预览

发行前验证不再依赖模式开关：先在插件目录运行构建命令生成产物，开发服务离线时重新加载开发注册，壳按 `enest.output` 产物目录预览（标签「构建产物」）。最后应解包 `.enestplugin` 走正式安装路径再验一次，确认资源、图标、README 和截图均不依赖源码树或外部 CDN。

服务器未启动且无可用产物时显示加载失败；启动服务器后重新加载（或依赖自动拉起）。不要通过关闭沙箱、放开任意 localhost 端口、加载 file:// 或增加宿主文件监听解决白屏。

日志与 DevTools 针对列表中的指定插件操作。自动测试使用独立 `ENEST_TEST_DATA_ROOT` 与 `ENEST_TEST_USER_DATA`，不污染用户数据。

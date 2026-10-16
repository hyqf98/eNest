# 工程与发布格式

eNest 插件以浏览器前端为入口。HTML/JavaScript、Vue、React 使用同一份 manifest 和同一种发布包；从 0.2.0 起，可选的插件自有 Node 后端通过 `backend.node` 授权后运行于独立 utility process。框架与后端编译由插件工具链完成，详见[插件本机后端](backend.md)。

```text
plugins/com.example.notes/
├── plugin.json
├── package.json
├── index.html
├── src/                         # 前端源码、组件、样式
├── backend/index.ts             # 可选的 Node 后端源码
├── public/assets/
│   ├── market/icon.svg
│   ├── market/README.md
│   ├── market/screenshots/01-main.png
│   └── vendor/                  # 字体、WASM 等原样分发资源
├── tests/
└── dist/                        # 唯一发布根，不提交 Git
    ├── plugin.json
    ├── index.html
    ├── assets/
    └── backend/                # 可选；含编译入口和锁定的生产依赖
```

源码目录名必须等于 manifest.id。`main` 固定为 `index.html`，始终相对于运行根，不能写 `dist/index.html`。源码中的公开资源位于 `public/assets`；构建后位于 `dist/assets`，manifest 中都写 `assets/...`。

源码根必须包含 `package.json`，其 `name`、`version` 分别与 manifest 的 `id`、`version` 一致，且 `type` 为 `module`。宿主、源码校验器和打包器使用同一份 manifest schema；manifest 必须是普通文件，大小不超过 256 KiB。共享 schema 的修改随 SDK 生成同步到宿主，检查模式不写文件。

图标固定 `assets/market/icon.svg`，详情固定 `assets/market/README.md`，截图位于 `assets/market/screenshots/`。开发期截图数组可以为空，发布必须有 1–8 张 PNG/JPEG/WebP 实际界面截图。README 图片相对于自身位置，例如 `![主界面](./screenshots/01-main.png)`。

## 构建与打包

仓库的 `npm run build` 自动枚举所有插件；`npm run pack` 构建、校验并生成 `{id}@{version}.enestplugin`。ZIP 根就是 `dist` 的内容，没有 `dist/` 或插件 ID 外层目录。安装位置为 `~/.eNest/plugins/{id}/{version}/`。

将 `.zip` 或 `.enestplugin` 发布包拖入 eNest 即可安装。ZIP 拖入后显示加号蒙版，松开后右上角显示实际安装进度和结果；可一次拖入多个包，最多并行安装 3 个。两种扩展名使用相同的 manifest、路径和包内容校验，源码仓库 ZIP 不能直接作为发布包安装。插件编辑器的普通文件拖入保持原有行为。

发布 manifest 删除 `development`。无后端的包只含 `plugin.json`、`index.html` 和 `assets/**`；声明了 `backend.entry` 的包还可包含 `backend/**`，其中 `backend/node_modules` 仅容纳构建工具按锁文件收集的生产依赖。源码、测试、根目录 node_modules、环境配置、源码映射、符号链接、越界路径不进入包；第三方依赖所需的运行时源码与资源保留在后端依赖区。脚本使用外部模块文件，不使用内联 JavaScript 或内联事件属性。WASM 可使用，但不开放一般 eval。

共享 kit 是 `@enest/plugin-kit` workspace 包，由 Vite 打进产物；后端也可通过 workspace 包共享业务实现，例如 `@enest/ssh-backend`。不要向每个插件复制可漂移的共享源码。构建只能写 `dist`（可用 `enest.output` 声明其它目录），不能生成代码到 `src` 或原始资源目录。前端开发服务器可使用 HMR；带后端的插件必须先生成 `dist/backend`，后端代码修改后重新构建并重载实例。

DSH 已有 `runtime/` 继续作为专属宿主集成附件；通用插件的 Node 入口使用 `backend/`，两者都不受 Chromium 页面沙箱约束。`backend.node` 表示完整本机 Node 信任。市场下载包上限统一为 **256 MiB**，安装解压总量上限为 **2 GiB**；下载和安装都校验目标插件 ID、版本及摘要。

## 数据与源码分离

私有业务数据使用 `enest.storage`，附件使用 `enest.storage.blobs`，偏好使用声明式 settings。不要写入源码目录、安装目录或拼接用户 HOME。默认数据根为 `~/.eNest`；用户可在壳设置显式覆盖。

壳的设置主体和插件 KV 在 `data/enest.db` 中，默认根的 `settings.json` 只保存数据根引导信息。Cookie/localStorage 使用每插件独立的 session partition；需要跨重新加载、休眠可靠保存的业务数据应走宿主 storage API。

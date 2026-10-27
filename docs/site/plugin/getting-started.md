# 快速开始

插件是运行在 eNest 内的前端页面，通过 `window.enest` 调用宿主能力。使用 Node/Vite 开发不代表插件运行时拥有 Node 权限。

## 工程准备

使用插件仓库的 workspace 工程，或者遵循[标准目录](structure.md)创建 `notes/`，完整插件 ID 为 `com.example.notes`。Node 版本需满足仓库 package.json 和 Vite 的要求。React、Vue、vanilla 只影响前端编译，不改变包格式。

```json
{
  "id": "com.example.notes",
  "name": "便笺",
  "version": "0.1.0",
  "description": "保存一段个人便笺",
  "category": "效率",
  "main": "index.html",
  "icon": "assets/market/icon.svg",
  "permissions": [],
  "market": { "readme": "assets/market/README.md", "screenshots": [] },
  "development": { "main": "http://127.0.0.1:5173/" }
}
```

`development.main`（或 `package.json` 的 `enest.dev.url`）端口须与启动脚本一致且全仓唯一；未运行时壳会按插件 `package.json` 解析出的命令（锁文件检测包管理器，缺省 npm）自动拉起（端口被占自动换用空闲端口）。这个便笺只使用本插件私有存储，无需敏感权限。网络、剪贴板等敏感能力须声明对应权限；用户文件选择由宿主原生选择器授权，不因此要求通用文件权限框。详见[权限说明](permissions.md)。

原生 JS + Vite 示例的 `package.json`：

```json
{
  "name": "notes", "private": true, "version": "0.1.0", "type": "module",
  "scripts": { "dev": "vite --host 0.0.0.0", "build": "vite build --base ./" },
  "devDependencies": { "vite": "^8.3.4" }
}
```

在该插件目录执行 dev，插件仓库根不提供统一 dev 服务器。单独构建时还需把去掉 development 的 plugin.json 复制到 dist；官方仓库 `scripts/build-plugin.mjs` 会自动完成。源码 index.html、src、public/assets 均不由构建脚本回写。

创建实际 SVG 图标和 README 后，根 index.html 引用外部脚本：

```html
<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><main><label>便笺<textarea id="note"></textarea></label><button id="save">保存</button><output id="status"></output></main><script type="module" src="/src/main.js"></script></body>
</html>
```

`src/main.js`：

```js
const note = document.querySelector('#note')
const status = document.querySelector('#status')
note.value = await window.enest.storage.get('note') ?? ''
document.querySelector('#save').addEventListener('click', async () => {
  try {
    if (typeof window.enest.storage.commit !== 'function') {
      throw new Error('当前 eNest 不支持持久提交回执，请升级宿主后保存')
    }
    await window.enest.storage.commit([{ op: 'set', key: 'note', value: note.value }])
    status.textContent = '已保存'
  } catch (error) { status.textContent = error.message }
})
```

本例是 Vite 入口。完全静态预览时把脚本路径改成 `./src/main.js`。保存使用显式 `commit`，不能把 `storage.set` 的排队成功误写为已持久保存；失败或回执不确定按[存储标准](storage.md)处理。主页面不要用内联脚本，不要把未授予权限错误改成原生浏览器 API 回退。

## 开发与发布

执行 `npm run dev`（壳也会按 package.json 自动拉起），在壳开发者页选择源码目录，页面自动打开。Vite HMR 保留当前视图；开发者控制台只有开发模式，按 `package.json` 自动识别框架或静态 HTML。要验证构建产物，先 `npm run build`，让开发服务离线后重新加载，壳按产物目录预览。详情见[开发加载](debug.md)。构建需 `base: './'`、`outDir: 'dist'`，并将去掉 development 的 manifest 写入 dist。仓库构建器会完成这些步骤。

发布前补真实截图，执行 manifest、产物和包校验，在壳内验证 Quick 与主窗、浅深主题、授权拒绝及重新进入。运行截图放在 `public/assets/market/screenshots/` 并声明到 manifest；不要用设计稿替代实际功能截图。

TypeScript 工程通过插件仓库的 `@enest/plugin-sdk` 获取声明；SDK 与实际 preload 同源生成，未发布到 npm 前使用 workspace 或本地 file 依赖。见[API 类型](api-types.md)。

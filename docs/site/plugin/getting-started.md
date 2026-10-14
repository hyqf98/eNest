# 快速开始

插件是运行在 eNest 内的前端页面，通过 `window.enest` 调用宿主能力。使用 Node/Vite 开发不代表插件运行时拥有 Node 权限。

## 工程准备

使用插件仓库的 workspace 工程，或者遵循[标准目录](structure.md)创建 `com.example.notes/`。Node 版本需满足仓库 package.json 和 Vite 的要求。React、Vue、vanilla 只影响前端编译，不改变包格式。

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

这个便笺只使用本插件私有存储，无需敏感权限。插件可以自行组合页面和业务算法；只有使用文件、网络等敏感宿主能力时，才在 `permissions` 中声明对应项。

原生 JS + Vite 示例的 `package.json`：

```json
{
  "name": "com.example.notes", "private": true, "version": "0.1.0", "type": "module",
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
    await window.enest.storage.set('note', note.value)
    status.textContent = '已保存'
  } catch (error) { status.textContent = error.message }
})
```

本例是 Vite 入口。完全静态预览时把脚本路径改成 `./src/main.js`。主页面不要用内联脚本，不要把未授予权限错误改成原生浏览器 API 回退。

## 开发与发布

执行 `npm run dev`，在壳开发者页选择源码目录，页面自动打开。Vite HMR 保留当前视图；详情见[开发加载](debug.md)。构建需 `base: './'`、`outDir: 'dist'`，并将去掉 development 的 manifest 写入 dist。仓库构建器会完成这些步骤。

发布前补真实截图，执行 manifest、产物和包校验，在壳内验证 Quick 与主窗、浅深主题、授权拒绝及重新进入。运行截图放在 `public/assets/market/screenshots/` 并声明到 manifest；不要用设计稿替代实际功能截图。

TypeScript 工程通过插件仓库的 `@enest/plugin-sdk` 获取声明；SDK 与实际 preload 同源生成，未发布到 npm 前使用 workspace 或本地 file 依赖。见[API 类型](api-types.md)。

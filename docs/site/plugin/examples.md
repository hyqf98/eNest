# 可运行示例与框架接入

先按 [快速开始](getting-started.md) 创建完整的标准目录与 manifest。以下示例只替换前端入口，不改变 `main: "index.html"`、`public/assets/market` 和 `dist` 发布契约。生产环境不运行内联脚本。

## 原生 JavaScript

`index.html` 引用 `<script type="module" src="./src/main.js"></script>`，页面提供 `#note`、`#save` 和 `#status`。直接执行的 JS/CSS 可静态调试，保存后在壳手动重新加载。完整业务代码见 [快速开始](getting-started.md)。

## Vite + React

安装 React、ReactDOM、Vite 和 `@vitejs/plugin-react`；在 package.json 添加 `dev: vite --host 0.0.0.0` 与 `build: vite build`。配置：

```js
// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()], base: './', build: { outDir: 'dist' } })
```

index.html 提供 `<div id="root"></div>` 和外部 `<script type="module" src="/src/main.jsx"></script>`。

```jsx
// src/main.jsx
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
function App() {
  const [mode, setMode] = useState(window.enest.getLaunchMode())
  useEffect(() => window.enest.onModeChange(mode => setMode(mode)), [])
  return <main data-mode={mode}>当前启动模式：{mode}</main>
}
createRoot(document.querySelector('#root')).render(<App />)
```

## Vite + Vue

安装 Vue、Vite 和 `@vitejs/plugin-vue`，上面配置中的插件替换为 `vue()`。index.html 提供 `#app` 并引用 `/src/main.js`：

```js
import { createApp } from 'vue'
import App from './App.vue'
createApp(App).mount('#app')
```

```vue
<!-- src/App.vue -->
<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
const mode = ref(window.enest.getLaunchMode())
let off
onMounted(() => { off = window.enest.onModeChange(next => { mode.value = next }) })
onUnmounted(() => off?.())
</script>
<template><main :data-mode="mode">当前启动模式：{{ mode }}</main></template>
```

Vue/React 的卸载清理还不能替代插件生命周期：后台暂停动画和轮询，在 `onBeforeClose` 保存业务状态。全部网络和系统能力通过 SDK。

这两种项目在开发时声明 `development.main`，由开发者执行 dev；宿主只连接该 origin。独立工程 build 后还需把去掉 development 的 manifest 写入 dist，再用插件仓库的产物验证器校验。官方 workspace 构建脚本完成该步骤。更多细节见 [开发调试](debug.md)。

## 官方参考

插件仓库的 `plugins/` 是自动枚举的实际示例；按对应功能读取 `src` 与 README，而不是复制打包后 JS：

| 示例 | 学习内容 |
| --- | --- |
| `com.enest.todos` | 持久化、编辑与列表布局 |
| `com.enest.theme-demo` | 声明式主题、运行时注册、预览入口 |
| `com.enest.database` | 数据库句柄、局部表格滚动与会话清理 |
| `com.enest.ssh` | 私钥能力、终端与文件传输 |
| `com.enest.net-kit` | HTTP、宿主 WebSocket、订阅清理 |

系统集成示例按最小功能阅读；新插件不用默认携带它们全部权限。

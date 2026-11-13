/**
 * main — 渲染进程入口
 * 挂载 React 根节点，并按顺序引入设计 Token / 全局重置 / 组件样式 / 详情弹窗样式。
 * 无业务依赖；仅启动 App 与样式层。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '@renderer/App'
import { configureLocalePersistence } from '@renderer/i18n'
import { shellApi } from '@renderer/services/shellApi'
import { installScrollActivity } from '@renderer/services/scrollActivity'
import '@renderer/styles/tokens.css'
import '@renderer/styles/base.css'
import '@renderer/styles/app.css'
import '@renderer/themes/default/workspace/detail.css'
import '@renderer/themes/default/splash.css'
import '@renderer/themes/default/workspace/market.css'
import '@renderer/styles/appearance.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

// 页面滚动条只在滚动时出现；信号由 data-scrollbar="auto-hide" 的容器消费。
installScrollActivity()

configureLocalePersistence({
  read: async () => ((await shellApi.getSettings()).general as { locale?: unknown } | undefined)?.locale,
  write: async locale => { await shellApi.setSettings({ general: { locale } }) },
})

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

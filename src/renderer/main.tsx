/**
 * main — 渲染进程入口
 * 挂载 React 根节点，并按顺序引入设计 Token / 全局重置 / 组件样式 / 详情弹窗样式。
 * 无业务依赖；仅启动 App 与样式层。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import './styles/detail.css'
import './styles/splash.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

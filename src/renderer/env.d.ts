/// <reference types="vite/client" />

/**
 * env — 渲染进程全局类型声明
 * 将 preload 注入的 `window.enestShell` 声明为可选 ShellApi，
 * 供 shellApi 在 Electron / 浏览器 mock 两种环境下安全取用。
 */
interface Window {
  /** preload 桥接的 shell 能力；缺失时 shellApi 回退到 mock 实现 */
  enestShell?: import('./services/shellApi').ShellApi
}

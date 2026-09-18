/**
 * patch-electron-app — 开发模式 Electron.app 本地品牌化补丁
 * 问题：npm run dev 直接运行 node_modules/electron/dist/Electron.app，
 *      macOS Dock 启动瞬间显示原生 Electron 图标，悬停提示 "Electron"。
 * 方案：把 build/icon.icns 覆盖到 Electron.app/Resources/electron.icns，
 *      并把 Info.plist 的 CFBundleName / CFBundleDisplayName 改为 eNest。
 *      bundle 级替换 → 启动第一帧即是正确图标，无运行时闪烁窗口。
 * 执行时机：postinstall（electron 重装/升级后自动重新打补丁）；幂等可重复执行。
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const appDir = join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
const plistPath = join(appDir, 'Contents', 'Info.plist')
const icnsTarget = join(appDir, 'Contents', 'Resources', 'electron.icns')
const icnsSource = join(root, 'build', 'icon.icns')
const APP_NAME = 'eNest'

if (!existsSync(appDir)) {
  console.log('[patch-electron-app] Electron.app 不存在，跳过（可能尚未 install）')
  process.exit(0)
}
if (!existsSync(icnsSource)) {
  console.warn('[patch-electron-app] 缺少 build/icon.icns，跳过图标替换')
}

let changed = []

// 1) Dock 图标：覆盖 bundle 引用的 electron.icns（Info.plist CFBundleIconFile）
if (existsSync(icnsSource)) {
  const sameSize =
    existsSync(icnsTarget) &&
    statSync(icnsTarget).size === statSync(icnsSource).size
  if (!sameSize) {
    copyFileSync(icnsSource, icnsTarget)
    changed.push('icon.icns')
  }
}

// 2) Dock 悬停名称：CFBundleName（缺省键 CFBundleDisplayName 不存在则跳过）
if (existsSync(plistPath)) {
  let xml = readFileSync(plistPath, 'utf8')
  const before = xml
  xml = xml.replace(
    /(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${APP_NAME}$2`
  )
  xml = xml.replace(
    /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${APP_NAME}$2`
  )
  if (xml !== before) {
    writeFileSync(plistPath, xml, 'utf8')
    changed.push('Info.plist name')
  }
}

if (changed.length > 0) {
  console.log(`[patch-electron-app] 已更新: ${changed.join(', ')} → ${APP_NAME}`)
} else {
  console.log('[patch-electron-app] 已是最新，无需修改')
}

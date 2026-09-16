/**
 * windowState — 窗口几何计算工具
 * 职责：根据壳子窗口内容区尺寸，计算插件内容区可用边界（扣除标题栏+插件条+左侧 orb 通道）。
 * 被 PluginHost / createShellWindow 调用，用于 WebContentsView 布局。
 * 关键依赖：@shared/constants、createShellWindow.getPluginLeftInset。
 */
import type { BaseWindow, Rectangle } from 'electron'
import { TITLEBAR_HEIGHT, PLUGIN_BAR_HEIGHT, pluginChromeBarHeight } from '@shared/constants'
import { getPluginLeftInset } from '@main/window/createShellWindow'

/** 返回壳子窗口内容区完整边界 */
export function getContentBounds(win: BaseWindow): Rectangle {
  return win.getContentBounds()
}

/**
 * 返回插件内容区边界：扣除标题栏、插件条高度与左侧 orb 通道。
 * @param chromeBarHeight 插件条像素高，由 manifest.ui.chrome 决定
 */
export function getPluginContentBounds(
  win: BaseWindow,
  chromeBarHeight: number = PLUGIN_BAR_HEIGHT
): Rectangle {
  const b = win.getContentBounds()
  const top = TITLEBAR_HEIGHT + Math.max(0, chromeBarHeight)
  const left = getPluginLeftInset()
  return {
    x: left,
    y: top,
    width: Math.max(0, b.width - left),
    height: Math.max(0, b.height - top)
  }
}

/** 按 chrome 模式计算插件内容区边界 */
export function getPluginContentBoundsForChrome(
  win: BaseWindow,
  chrome: 'default' | 'minimal' | 'none' | undefined
): Rectangle {
  return getPluginContentBounds(win, pluginChromeBarHeight(chrome))
}

/**
 * windowState — 窗口几何计算工具
 * 职责：根据壳子窗口内容区尺寸，计算插件内容区可用边界（扣除标题栏+插件条高度）。
 * 被 PluginHost / createShellWindow 调用，用于 WebContentsView 布局。
 * 关键依赖：@shared/constants 中的 TITLEBAR_HEIGHT / PLUGIN_BAR_HEIGHT / pluginChromeBarHeight。
 */
import type { BaseWindow, Rectangle } from 'electron'
import { TITLEBAR_HEIGHT, PLUGIN_BAR_HEIGHT, pluginChromeBarHeight } from '@shared/constants'

/** 返回壳子窗口内容区完整边界 */
export function getContentBounds(win: BaseWindow): Rectangle {
  return win.getContentBounds()
}

/**
 * 返回插件内容区边界：扣除标题栏与插件条高度，高度不小于 0。
 * @param chromeBarHeight 插件条像素高，由 manifest.ui.chrome 决定
 */
export function getPluginContentBounds(
  win: BaseWindow,
  chromeBarHeight: number = PLUGIN_BAR_HEIGHT
): Rectangle {
  const b = win.getContentBounds()
  const top = TITLEBAR_HEIGHT + Math.max(0, chromeBarHeight)
  return {
    x: 0,
    y: top,
    width: b.width,
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

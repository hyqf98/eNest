/**
 * shared/platform — 三端可用的平台判定工具
 * main/preload 优先 process.platform；renderer 优先 userAgentData，回退 navigator.platform。
 */

function detectMac(): boolean {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform === 'darwin'
  }
  if (typeof navigator !== 'undefined') {
    const uaData = (
      navigator as Navigator & { userAgentData?: { platform?: string } }
    ).userAgentData
    if (uaData?.platform) return /mac/i.test(uaData.platform)
    return /Mac/i.test(navigator.platform || navigator.userAgent)
  }
  return false
}

/** 是否 macOS（模块加载时求值一次；测试/DOM 环境安全回退 false） */
export const IS_MAC = detectMac()

/** 是否 Windows */
export const IS_WINDOWS =
  typeof process !== 'undefined' && typeof process.platform === 'string'
    ? process.platform === 'win32'
    : typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent)

/** 是否 Linux 桌面 */
export const IS_LINUX =
  typeof process !== 'undefined' && typeof process.platform === 'string'
    ? process.platform === 'linux'
    : typeof navigator !== 'undefined' && /Linux/i.test(navigator.platform || navigator.userAgent) && !/Android/i.test(navigator.userAgent)

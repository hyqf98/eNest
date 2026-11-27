/**
 * 网页登录窗口：让用户在应用内登录一个外部站点，把登录会话交回发起的插件。
 *
 * 这里加载的是外部站点，页面脚本不可信，所以窗口没有任何桥接：
 * - 不挂 preload：没有 window.enest、没有 IPC、拿不到壳或别的插件的任何东西；
 * - 会话是这次登录专用的内存分区：不落宿主磁盘，不与壳、其它插件、其它登录共用；
 * - 只能访问 manifest 为 web.login 声明过的 origin（登录页与其后的每一次跳转都校验），
 *   防止插件把窗口导向仿冒站点骗取用户的账号密码；
 * - 宿主不往登录页里执行脚本，只读导航地址和 cookie；
 * - cookie 只在登录成功那一刻读一次，交给发起调用的插件页面后随会话一起销毁。
 */
import { randomUUID } from 'node:crypto'
import { BrowserWindow, screen, session, webContents } from 'electron'
import type { WebLoginCookie, WebLoginRequest, WebLoginResult } from '@shared/types/webLogin'
import type { PluginRuntimeScope } from '@main/plugin/PluginRuntimeScope'
import { resolveWindowIcon } from '@main/window/applicationIcon'

/** 同一插件同时最多打开的登录窗口数：登录是一次性的交互，不需要多个 */
const MAX_WINDOWS_PER_PLUGIN = 2
/** 一次登录的最长时长：扫码、账号密码加短信验证都够用；到点关窗并按取消处理 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
/**
 * 到达成功页后等 cookie 稳定的时间：天翼会先跳成功页，再由页面脚本下发 / 轮换会话 cookie。
 * 轮询间隔 250ms，连续两次快照一致就交；最多等 3s，不把登录成功拖成慢操作。
 */
const COOKIE_SETTLE_INTERVAL_MS = 250
const COOKIE_SETTLE_MAX_MS = 3000
const open = new Map<string, Set<BrowserWindow>>()

function windowsOf(pluginId: string): Set<BrowserWindow> {
  let set = open.get(pluginId)
  if (!set) { set = new Set(); open.set(pluginId, set) }
  return set
}

/** 插件关闭或重载时回收它的登录窗口 */
export function closeWebLoginWindows(pluginId: string): void {
  // 直接读而不是 windowsOf()：后者会为没开过窗口的插件凭空建一个空条目
  for (const win of open.get(pluginId) ?? []) if (!win.isDestroyed()) win.destroy()
  open.delete(pluginId)
}

/** 应用退出时回收全部登录窗口 */
export function closeAllWebLoginWindows(): void {
  for (const pluginId of [...open.keys()]) closeWebLoginWindows(pluginId)
}

/** 按 URL 解析后比较 protocol + host + port，不按字符串前缀：防 user@host、大小写、默认端口等伎俩 */
function originOf(url: string): string | null {
  try { return new URL(url).origin } catch { return null }
}

/** manifest 里为 web.login 声明的站点，解析成规范 origin；解析不了的不是合法 origin，直接忽略 */
export function webLoginOrigins(manifest: { net?: { loginOrigins?: string[] } }): string[] {
  return (manifest.net?.loginOrigins ?? []).map(originOf).filter((item): item is string => item !== null)
}

async function readCookies(isolated: Electron.Session): Promise<WebLoginCookie[]> {
  const cookies = await isolated.cookies.get({})
  return cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain ?? '', path: cookie.path ?? '/',
    ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
    secure: cookie.secure === true, httpOnly: cookie.httpOnly === true }))
}

const text = (value: unknown): string => typeof value === 'string' ? value : ''
const size = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback

/** 请求来自插件页面，不可信：逐字段取值并限长，不做类型断言 */
export function parseWebLoginRequest(input: unknown): WebLoginRequest {
  if (!input || typeof input !== 'object') throw new Error('web.login: expected an options object')
  const record = input as Record<string, unknown>
  return {
    url: text(record.url).slice(0, 2048),
    successUrlPrefix: text(record.successUrlPrefix).slice(0, 2048),
    ...(text(record.title) ? { title: text(record.title) } : {}),
    ...(size(record.width, 0) ? { width: size(record.width, 0) } : {}),
    ...(size(record.height, 0) ? { height: size(record.height, 0) } : {}),
    ...(size(record.contentWidth, 0) ? { contentWidth: size(record.contentWidth, 0) } : {})
  }
}

/**
 * 打开登录窗口并等待结果。
 * @param pluginId   发起调用的插件
 * @param ownerWcId  发起调用的插件页面；登录窗口是它的子窗口，cookie 只交回给它
 * @param scope      发起插件的运行代次；插件关闭、重载时窗口随之关闭
 * @param allowedOrigins  manifest 声明的站点（已解析为 origin）
 */
export async function openWebLoginWindow(pluginId: string, ownerWcId: number, scope: PluginRuntimeScope, request: WebLoginRequest, allowedOrigins: string[]): Promise<WebLoginResult> {
  const startUrl = String(request?.url ?? '')
  const successPrefix = String(request?.successUrlPrefix ?? '')
  // 逐项校验而不是合并判断：每种非法输入各有明确的错误文案，插件开发者一眼能看出改哪里
  const startOrigin = originOf(startUrl)
  if (!startOrigin || !startUrl.startsWith('https://')) throw new Error('web.login: url must be an https URL')
  if (!allowedOrigins.includes(startOrigin)) throw new Error(`web.login: url origin is not declared in net.loginOrigins (${startOrigin})`)
  const successOrigin = originOf(successPrefix)
  if (!successPrefix.startsWith('https://') || !successOrigin || successPrefix.length <= successOrigin.length + 1) {
    throw new Error('web.login: successUrlPrefix must be an https URL with a path')
  }
  if (!allowedOrigins.includes(successOrigin)) throw new Error('web.login: successUrlPrefix origin is not declared in net.loginOrigins')
  if (!scope.isCurrent() || scope.isClosing || scope.signal.aborted) throw new Error('plugin runtime is closing')
  const mine = windowsOf(pluginId)
  if (mine.size >= MAX_WINDOWS_PER_PLUGIN) throw new Error('web.login: too many login windows')
  const owner = webContents.fromId(ownerWcId)
  if (!owner || owner.isDestroyed()) throw new Error('web.login: caller page is gone')

  const parent = BrowserWindow.fromWebContents(owner) ?? undefined
  // 内存分区：不带 persist: 前缀的分区不写磁盘。结果交出后清空并关闭这个会话。
  const isolated = session.fromPartition(`enest-web-login-${randomUUID()}`, { cache: false })
  // 登录页用不到摄像头、麦克风、定位、通知等任何设备能力
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.setDevicePermissionHandler(() => false)
  isolated.setDisplayMediaRequestHandler((_request, callback) => callback(null))
  // 登录页用不到下载，一律拒绝
  isolated.on('will-download', event => event.preventDefault())
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^https:\/\//.test(details.url) })
  })

  // 尺寸：登录页（尤其天翼云盘）是按桌面宽度排版的完整网页，窄窗里只能横向溢出加滚动。
  // 默认给一个接近桌面浏览器的窗口，并按所在显示器的可用区域收敛，避免超出屏幕。
  const parentBounds = parent && !parent.isDestroyed() ? parent.getBounds() : null
  const area = parentBounds
    ? screen.getDisplayMatching(parentBounds).workArea
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(area.width, Math.max(360, Math.round(request.width ?? 1200)))
  const height = Math.min(area.height, Math.max(400, Math.round(request.height ?? 900)))
  /**
   * 页面按 contentWidth 排版但窗口更窄时等比缩小。
   * 天翼登录页主容器写死 width:1440px / min-width:1280px 且没有小屏断点，1:1 渲染在 1200px 窗口里
   * 会横向溢出、右侧露出空白背景。缩放比只按内容宽度算，留 5% 余量避免恰好卡在滚动条边缘。
   */
  const contentWidth = request.contentWidth && request.contentWidth > 0 ? request.contentWidth : 0
  const zoom = contentWidth > 0 && width < contentWidth
    ? Math.max(0.5, Math.min(1, (width / contentWidth) * 0.98))
    : 1
  const win = new BrowserWindow({
    width, height, minWidth: 360, minHeight: 400,
    // 居中所属显示器：登录窗口与插件页并排，用户不用来回找窗口
    ...(parentBounds ? { x: Math.round(parentBounds.x + (parentBounds.width - width) / 2), y: Math.round(parentBounds.y + (parentBounds.height - height) / 2) } : {}),
    title: String(request.title ?? '').slice(0, 120) || '登录',
    // 刻意不用 modal：macOS 上 modal 子窗口会变成无标题栏的 sheet，既没有关闭按钮也不能自由缩放，
    // 长登录页只能靠滚动。普通子窗口保留标题栏、关闭钮和拖拽缩放。
    parent, modal: false, show: false, resizable: true, fullscreenable: false, maximizable: true,
    autoHideMenuBar: true, icon: resolveWindowIcon(),
    webPreferences: {
      session: isolated,
      // 刻意不设 preload / nodeIntegration：外部站点拿不到任何宿主能力
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      spellcheck: false, navigateOnDragDrop: false,
      // 缩放属于显示设置，页面脚本不可改：登录页改写 zoom 会破坏上面的排版对齐。
      zoomFactor: zoom
    }
  })
  /** 结果交出（或创建失败）后销毁会话：清 cookie、缓存与连接，登录凭据不在宿主内存里久留 */
  const destroySession = (): void => {
    void Promise.allSettled([isolated.clearStorageData(), isolated.clearCache(), isolated.closeAllConnections()])
      .finally(() => { try { isolated.removeAllListeners() } catch { /* 会话可能已销毁 */ } })
  }

  try {
    mine.add(win)
    // addDisposer 返回取消函数；正常结束后要取消登记，否则 scope 关闭时会再销毁一次已销毁的窗口
    const unregister = scope.addDisposer(() => { if (!win.isDestroyed()) win.destroy() })
    const releaseActivity = scope.acquireActivity('web login window')

    let finished = false
    let settle: (result: WebLoginResult) => void = () => {}
    const done = new Promise<WebLoginResult>(resolve => { settle = resolve })
    // 兜底超时：扫码、短信验证等登录方式可能要几分钟，所以给得宽；但没有上限的话，
    // 一个既没成功也没被关掉的窗口会一直占着该插件的名额，之后再也打不开登录窗口。
    const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
      finish({ ok: false, reason: 'cancelled' })
    }, LOGIN_TIMEOUT_MS)
    timeout.unref?.()
    const finish = (result: WebLoginResult): void => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      unregister()
      releaseActivity()
      mine.delete(win)
      if (mine.size === 0) open.delete(pluginId)
      // 成功也要关窗：登录已拿到会话，留着这个窗口只会让用户以为没成功、反复点。
      // closed 事件里会再调一次 finish，靠 finished 标志挡住。
      if (!win.isDestroyed()) win.destroy()
      settle(result)
    }

    /** 主框架的每一次导航（含服务端跳转）都必须落在已声明的站点内 */
    const allowed = (url: string): boolean => { const origin = originOf(url); return origin !== null && allowedOrigins.includes(origin) }
    /**
     * 到了成功页还不能立刻交 cookie：登录站通常先跳成功页，再由页面脚本发 XHR 下发或轮换会话 cookie。
     * 导航提交那一刻读到的是不完整的一组，插件存下来的会话就会「刚登录就过期」。
     * 这里反复读，直到连续两次快照完全一致（或到上限）再交出一份稳定的会话。
     */
    let settling = false
    const checkSuccess = (url: string): void => {
      if (finished || settling || !url.startsWith(successPrefix)) return
      settling = true
      const deadline = Date.now() + COOKIE_SETTLE_MAX_MS
      let previous = ''
      const poll = (): void => {
        if (finished) return
        void readCookies(isolated).then(cookies => {
          if (finished) return
          const snapshot = cookies.map(cookie => `${cookie.domain}|${cookie.path}|${cookie.name}=${cookie.value}`).sort().join(';')
          if (snapshot === previous || Date.now() >= deadline) { finish({ ok: true, url, cookies }); return }
          previous = snapshot
          setTimeout(poll, COOKIE_SETTLE_INTERVAL_MS)
        }, () => finish({ ok: false, reason: 'cancelled' }))
      }
      poll()
    }

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-attach-webview', event => event.preventDefault())
    // Esc 关闭：普通子窗口没有 sheet 那样的系统取消手势，用户放弃登录时需要一个不靠找按钮的出口。
    // 只在窗口自身有焦点时响应，且不吞掉页面内的按键（before-input-event 只旁听）。
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      event.preventDefault()
      finish({ ok: false, reason: 'cancelled' })
    })
    // 要离开已声明的站点（含被跳到别的域）就停下并结束：用户不会在不该出现的站点里输入凭据
    win.webContents.on('will-navigate', (event, url) => { if (!allowed(url)) { event.preventDefault(); finish({ ok: false, reason: 'cancelled' }) } })
    win.webContents.on('will-redirect', (event, url) => { if (!allowed(url)) { event.preventDefault(); finish({ ok: false, reason: 'cancelled' }) } })
    win.webContents.on('did-navigate', (_event, url) => checkSuccess(url))
    win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) checkSuccess(url) })
    win.webContents.on('render-process-gone', () => finish({ ok: false, reason: 'cancelled' }))
    // 窗口可缩放：用户拖大后应恢复 1:1，不要一直压着缩小内容；拖小时再按新宽度重算。
    if (contentWidth > 0) {
      const applyZoom = (): void => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return
        const [currentWidth] = win.getContentSize()
        const next = currentWidth < contentWidth ? Math.max(0.5, Math.min(1, (currentWidth / contentWidth) * 0.98)) : 1
        if (Math.abs(win.webContents.getZoomFactor() - next) > 0.01) win.webContents.setZoomFactor(next)
      }
      win.on('resize', applyZoom)
    }
    win.once('closed', () => finish({ ok: false, reason: 'cancelled' }))

    void win.loadURL(startUrl).then(() => {
      if (finished) return
      win.show()
      win.focus()
    }).catch(() => finish({ ok: false, reason: 'cancelled' }))

    return await done.finally(destroySession)
  } catch (error) {
    // 创建过程中任何一步失败（例如插件运行时恰在此刻关闭）都要把已登记的东西撤干净：
    // 留下一个名额或一个无主窗口，插件之后就再也打不开登录窗口
    mine.delete(win)
    if (mine.size === 0) open.delete(pluginId)
    if (!win.isDestroyed()) win.destroy()
    destroySession()
    throw error
  }
}

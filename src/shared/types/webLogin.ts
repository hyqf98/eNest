/**
 * 网页登录窗口：插件让用户在一个独立会话的窗口里登录某个外部站点。
 *
 * 安全边界（宿主保证）：
 * - 窗口里加载的是外部站点，其页面脚本不可信：窗口不挂任何 preload，没有 enest 桥接、没有 IPC；
 * - 只接受 https，且主机必须是插件 manifest 里为 web.login 声明过的 origin；
 * - 会话是这次登录专用的（不落宿主磁盘、不与壳和其它插件共享），窗口关闭即销毁；
 * - 登录页面的 cookie 只交回发起调用的那个插件页面，宿主不留存。
 */
export interface WebLoginRequest {
  /** 登录页地址，必须是 https 且主机已声明 */
  url: string
  /** 登录成功后页面会跳到的地址前缀；主框架导航到它开头的地址即视为成功 */
  successUrlPrefix: string
  title?: string
  width?: number
  height?: number
  /**
   * 登录页按多少 CSS 像素排版（例如页面主容器写了 `min-width: 1280px`）。
   * 给出时宿主在窗口更窄的情况下等比缩小页面，避免内容溢出、右侧露出空白背景。
   * 只是布局提示，不影响窗口几何；不给则按窗口实际宽度 1:1 渲染。
   */
  contentWidth?: number
}

export interface WebLoginCookie {
  name: string
  value: string
  domain: string
  path: string
  /** 过期时间（Unix 秒）；会话 cookie 没有这个值 */
  expirationDate?: number
  secure: boolean
  httpOnly: boolean
}

export type WebLoginResult =
  /** 登录成功：带上这次会话里的全部 cookie */
  | { ok: true; url: string; cookies: WebLoginCookie[] }
  /** 用户在登录成功前关掉了窗口 */
  | { ok: false; reason: 'cancelled' }

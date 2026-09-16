/**
 * updateService — electron-updater 封装
 * 职责：检查 GitHub Release 更新、下载、安装并重启；向壳子推送进度事件。
 * 仅在打包环境启用；开发模式返回 unavailable，避免误连生产源。
 * 关键依赖：electron-updater、sendShellEvent、app.getVersion。
 */
import { app } from 'electron'
// electron-updater 为 CJS，ESM 下需默认导入再解构具名导出
import electronUpdater from 'electron-updater'
import type { UpdateInfo, ProgressInfo } from 'electron-updater'
import { logError, logInfo, logWarn } from '../logs/logService'
import { sendShellEvent } from '../window/createShellWindow'

const { autoUpdater } = electronUpdater

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  latestVersion?: string
  releaseName?: string
  releaseNotes?: string
  progress?: number
  downloaded?: boolean
  error?: string
  /** 是否运行在打包环境（非打包无法走 GitHub Release 更新） */
  packaged: boolean
}

let initialized = false
let state: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  packaged: app.isPackaged,
  downloaded: false
}

function setState(partial: Partial<UpdateState>): void {
  state = { ...state, ...partial }
  sendShellEvent({ type: 'update-status', state: { ...state } })
}

function formatNotes(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes
  if (notes == null) return undefined
  if (typeof notes === 'string') return notes
  const joined = notes
    .map((n) => n.note)
    .filter((n): n is string => Boolean(n))
    .join('\n')
  return joined || undefined
}

function releaseName(info: UpdateInfo): string | undefined {
  return info.releaseName ?? undefined
}

/** 初始化 electron-updater：仅打包环境生效 */
export function initUpdateService(): void {
  if (initialized) return
  initialized = true

  setState({ packaged: app.isPackaged, currentVersion: app.getVersion() })

  if (!app.isPackaged) {
    logInfo('update', 'skip init — not packaged')
    return
  }

  // 手动检查 + 确认后下载；退出时自动安装已下载的更新
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = {
    info: (m) => logInfo('update', String(m)),
    warn: (m) => logWarn('update', String(m)),
    error: (m) => logError('update', String(m)),
    debug: (m) => logInfo('update', String(m))
  }

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking', error: undefined })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logInfo('update', `available ${info.version}`)
    setState({
      status: 'available',
      latestVersion: info.version,
      releaseName: releaseName(info),
      releaseNotes: formatNotes(info),
      downloaded: false,
      progress: 0,
      error: undefined
    })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    logInfo('update', `up to date (${info.version})`)
    setState({
      status: 'not-available',
      latestVersion: info.version,
      downloaded: false,
      error: undefined
    })
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    setState({
      status: 'downloading',
      progress: Math.round(p.percent)
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    logInfo('update', `downloaded ${info.version}`)
    setState({
      status: 'downloaded',
      latestVersion: info.version,
      releaseName: releaseName(info),
      releaseNotes: formatNotes(info),
      progress: 100,
      downloaded: true,
      error: undefined
    })
  })

  autoUpdater.on('error', (err: Error) => {
    logError('update', err.stack || err.message)
    setState({ status: 'error', error: err.message })
  })

  logInfo('update', `updater ready version=${app.getVersion()}`)
}

/** 主动检查更新；返回当前状态快照 */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState({
      status: 'not-available',
      currentVersion: app.getVersion(),
      error: undefined,
      packaged: false
    })
    return { ...state }
  }

  try {
    setState({ status: 'checking', error: undefined })
    const result = await autoUpdater.checkForUpdates()
    if (!result?.updateInfo) {
      setState({ status: 'not-available' })
    }
  } catch (err) {
    const message = (err as Error).message || String(err)
    setState({ status: 'error', error: message })
  }
  return { ...state }
}

/** 开始下载（若已有下载完成则直接返回） */
export async function downloadUpdate(): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState({ status: 'error', error: 'download requires packaged build' })
    return { ...state }
  }
  if (state.status === 'downloaded') return { ...state }

  try {
    setState({ status: 'downloading', progress: 0, error: undefined })
    await autoUpdater.downloadUpdate()
  } catch (err) {
    const message = (err as Error).message || String(err)
    setState({ status: 'error', error: message })
  }
  return { ...state }
}

/** 安装已下载的更新并重启；未下载完成时返回错误状态 */
export function quitAndInstallUpdate(): UpdateState {
  if (state.status !== 'downloaded' && !state.downloaded) {
    setState({ status: 'error', error: 'update not downloaded yet' })
    return { ...state }
  }
  logInfo('update', 'quitAndInstall')
  // isSilent=false → 用户可见安装流程；isForceRunAfter=true → 安装后自动启动
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true)
  })
  return { ...state }
}

export function getUpdateState(): UpdateState {
  return { ...state }
}

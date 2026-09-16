/**
 * logService — 主进程持久化日志
 * 职责：将主进程启动、安装队列、插件生命周期等关键步骤写入
 *       {dataRoot}/logs/YYYY-MM-DD.log（默认 ~/eNest/logs）。
 * 为什么落盘：安装失败与运行时错误往往发生在用户侧，控制台日志会随进程退出丢失；
 *       按日切分便于用户直接打包反馈，也避免单文件无限膨胀。
 * 被 index.ts 在 ensureAppDirs 后 initLogService；PluginInstaller / installQueue / IPC handler 调用。
 * 关键依赖：pathsService（日志目录挂在数据根下）、node:fs。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAppPaths } from '../paths/pathsService'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 惰性缓存的日志目录；initLogService / 首次 log 时解析 */
let logsDir: string | null = null

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function todayStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function timeStamp(): string {
  const d = new Date()
  return `${todayStamp()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3
  )}`
}

/** 日志目录：{dataRoot}/logs；数据根来自 pathsService（可被 settings.general.dataRoot 覆盖） */
export function getLogsDir(): string {
  if (!logsDir) {
    logsDir = join(getAppPaths().root, 'logs')
  }
  return logsDir
}

/** 初始化日志目录；index.ts 在 ensureAppDirs 之后调用 */
export function initLogService(): void {
  const dir = getLogsDir()
  mkdirSync(dir, { recursive: true })
}

/**
 * 写一条日志。格式：`YYYY-MM-DD HH:mm:ss.SSS [LEVEL] [source] message`
 * 日志写入失败绝不抛出——日志不能拖垮业务。
 */
export function log(level: LogLevel, source: string, message: string): void {
  const line = `${timeStamp()} [${level.toUpperCase()}] [${source}] ${message}\n`
  try {
    const dir = logsDir ?? getLogsDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${todayStamp()}.log`), line, 'utf-8')
  } catch {
    /* swallow: logging must never crash the app */
  }
  if (level === 'error') console.error(line.trimEnd())
  else if (level === 'warn') console.warn(line.trimEnd())
  else console.log(line.trimEnd())
}

export const logDebug = (source: string, message: string): void => log('debug', source, message)
export const logInfo = (source: string, message: string): void => log('info', source, message)
export const logWarn = (source: string, message: string): void => log('warn', source, message)
export const logError = (source: string, message: string): void => log('error', source, message)

/**
 * 记录插件生命周期状态转移。统一 source=lifecycle，便于用户按关键字打包反馈。
 * 调用方：PluginHost.applyTransition / openPlugin / closePlugin；PluginUninstaller 各步骤。
 */
export function logLifecycle(
  pluginId: string,
  from: string,
  to: string,
  action?: string,
  detail?: string
): void {
  const actionPart = action ? ` (${action}${detail ? `: ${detail}` : ''})` : ''
  logInfo('lifecycle', `${pluginId}: ${from} → ${to}${actionPart}`)
}

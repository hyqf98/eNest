/**
 * logService — 主进程持久化日志（electron-log 5 封装）
 * 职责：将主进程启动、安装队列、插件生命周期等关键步骤写入
 *       {dataRoot}/logs/main.log（默认 ~/eNest/logs）。
 * 为什么 electron-log：原先 appendFileSync 逐条同步手写，缺轮转易膨胀；
 *       electron-log 的 file transport 自带 maxSize 轮转与错误兜底，写入失败只经
 *       内部 error 事件打 console，绝不会拖垮业务。
 * 配置说明：
 * - resolvePathFn 重定向到 getLogsDir()（{dataRoot}/logs，可被 settings.general.dataRoot 覆盖）；
 * - maxSize = 1MB：超限轮转归档为 main.<YYYY-MM-DD_HHmmss>.old.log（自定义 archiveLogFn，
 *   原生只保留一份 main.old.log），按时间戳排序最多保留 5 份归档；
 * - 关闭 electron-log 自带 console transport，console 镜像由本模块输出，
 *   保持既有格式 `YYYY-MM-DD HH:mm:ss.SSS [LEVEL] [source] message` 不变；
 * - initialize({ preload:false }) 且 transports.ipc 关闭：不向任何渲染进程/插件会话
 *   注入 electron-log preload，也不做 __ELECTRON_LOG__ 广播（壳子渲染层与插件层均不消费）。
 * 对外 API（log/logDebug/.../getLogsDir/initLogService）签名与语义保持不变。
 * 被 index.ts 在 ensureAppDirs 后 initLogService；PluginHost / quickHandlers / DevConsole 等调用。
 * 关键依赖：electron-log/main、pathsService、node:fs（仅轮转归档用同步 rename/unlink）。
 */
import { mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { default as elog } from 'electron-log/main'
import { getAppPaths } from '@main/paths/pathsService'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 单个日志文件上限（超出触发轮转归档） */
const MAX_FILE_BYTES = 1024 * 1024
/** 归档保留份数（main.<stamp>.old.log） */
const MAX_ARCHIVES = 5
/** 活跃日志文件名（electron-log file transport 默认） */
const LOG_FILE_NAME = 'main.log'

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

// ---------------------------------------------------------------------------
// electron-log transport 配置（模块加载时一次性完成，幂等）
// ---------------------------------------------------------------------------

// 不向渲染进程注入 preload / 不做日志 IPC 广播（渲染层与插件层均不消费）
elog.initialize({ preload: false })
elog.transports.ipc.level = false
// console 镜像由本模块自行输出以保持既有格式，关闭内置 console transport 避免重复
elog.transports.console.level = false

elog.transports.file.resolvePathFn = () => join(getLogsDir(), LOG_FILE_NAME)
elog.transports.file.maxSize = MAX_FILE_BYTES
elog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
elog.transports.file.archiveLogFn = (oldLogFile) => archiveLog(oldLogFile.path)

/** 归档名时间戳：到秒，避免同日多次轮转同名冲突 */
function archiveStamp(): string {
  const d = new Date()
  return `${todayStamp()}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/**
 * 轮转归档：main.log → main.<stamp>.old.log，随后只保留最近 MAX_ARCHIVES 份。
 * 失败静默（electron-log 约定 archiveLogFn 不抛出；失败时原生会回退裁剪当前文件）。
 */
function archiveLog(oldPath: string): void {
  try {
    const dir = dirname(oldPath)
    const dest = join(dir, `main.${archiveStamp()}.old.log`)
    try {
      renameSync(oldPath, dest)
    } catch {
      return // 重命名失败：保留原文件，下次轮转再试
    }
    pruneArchives(dir)
  } catch {
    /* swallow: rotation must never crash the app */
  }
}

/** 删除超出保留份数的旧归档（文件名字典序 === 时间戳序） */
function pruneArchives(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const archives = names
    .filter((n) => n.startsWith('main.') && n.endsWith('.old.log'))
    .sort()
  const excess = archives.length - MAX_ARCHIVES
  for (let i = 0; i < excess; i++) {
    try {
      unlinkSync(join(dir, archives[i]))
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 对外 API（签名与语义与旧实现保持一致）
// ---------------------------------------------------------------------------

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

/** electron-log 各级别写函数（file transport 已配置为 silly 全量落盘） */
const levelWriters: Record<LogLevel, (text: string) => void> = {
  debug: (t) => elog.debug(t),
  info: (t) => elog.info(t),
  warn: (t) => elog.warn(t),
  error: (t) => elog.error(t)
}

/**
 * 写一条日志。文件行格式（electron-log format）：
 *   `YYYY-MM-DD HH:mm:ss.SSS [LEVEL] [source] message`
 * console 镜像保持旧格式逐条输出。
 * 日志写入失败绝不抛出——日志不能拖垮业务（electron-log 内部经 error 事件兜底）。
 */
export function log(level: LogLevel, source: string, message: string): void {
  const line = `${timeStamp()} [${level.toUpperCase()}] [${source}] ${message}`
  try {
    levelWriters[level]?.(`[${source}] ${message}`)
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

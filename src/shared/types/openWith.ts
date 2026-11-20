/**
 * openWith — 「设为默认打开方式」跨端契约（壳统一能力）
 *
 * 背景：插件是壳内 WebContentsView，不是 OS 应用；任何平台的系统关联写入目标
 * 只能是 eNest 本体。插件可声明或运行时登记可处理的类型/scheme；用户决定路由和系统默认。
 *
 * 键约定：文件类型一律 `ext:<小写无点扩展名>`；scheme 一律 `scheme:<小写名>`。
 * 路由表存设置段 `openWith`（仅主进程写，renderer 写入在 shell:set-settings 剥离）。
 */

import { CONTRIB_SCHEMA_VERSION, type OpenWithContribution } from './plugin'

/** 壳保留 / 非法 scheme：插件不得声明占用 */
export const RESERVED_OPEN_WITH_SCHEMES = ['enest', 'http', 'https', 'file', 'mailto', 'tel', 'data', 'javascript', 'about', 'blob', 'shell'] as const

/** scheme 形状：RFC 3986 scheme 子集，小写字母开头 */
export const OPEN_WITH_SCHEME_RE = /^[a-z][a-z0-9+.-]{1,63}$/
/** 扩展名形状：小写字母数字，1-10 位，无点 */
export const OPEN_WITH_EXT_RE = /^[a-z0-9]{1,10}$/
/** MIME 形状：type/subtype 粗校验 */
export const OPEN_WITH_MIME_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/

export type OpenWithKey = `ext:${string}` | `scheme:${string}`

export function validOpenWithValue(kind: 'ext' | 'scheme', value: string): boolean {
  return kind === 'ext' ? OPEN_WITH_EXT_RE.test(value) : OPEN_WITH_SCHEME_RE.test(value)
    && !(RESERVED_OPEN_WITH_SCHEMES as readonly string[]).includes(value) && !/^(?:ms-|x-apple\.)/.test(value)
}

export function extKey(ext: string): OpenWithKey {
  return `ext:${ext}`
}
export function schemeKey(scheme: string): OpenWithKey {
  return `scheme:${scheme}`
}

/** 「打开方式」路由表：键 → pluginId。仅主进程读写。 */
export interface OpenWithRoutes {
  /** `ext:md` → 'com.github.eNest.markdown' */
  ext: Record<string, string>
  /** `scheme:enest-md` → pluginId */
  scheme: Record<string, string>
}

export function emptyOpenWithRoutes(): OpenWithRoutes {
  return { ext: {}, scheme: {} }
}

/** 系统默认状态（按平台检测得出的结论，三值如实呈现） */
export type OpenWithStatus = 'default' | 'candidate' | 'unregistered'

/** 设置页列表行：贡献 + 路由 + 状态合并后的展示形状 */
export interface OpenWithRow {
  key: OpenWithKey
  /** 'ext' | 'scheme' */
  kind: 'ext' | 'scheme'
  /** 原始值：'md' 或 'enest-md' */
  value: string
  /** 声明该类型的插件（可能多个候选） */
  providers: Array<{
    pluginId: string
    /** 插件显示名（壳注入） */
    pluginName: string
    /** 插件 icon（runtime-relative，壳解析后给渲染层） */
    icon?: string
    /** 图标回退：单字符 glyph 与插件色 */
    glyph?: string
    color?: string
    /** 是否被插件启用（disabled 的插件不进候选） */
    enabled: boolean
    /** 该 provider 是否就是当前路由指向的插件 */
    routed: boolean
  }>
  /** 当前路由指向的 pluginId；未设置路由为 undefined */
  routedPluginId?: string
  /** 系统层状态；检测不可用时 undefined（dev 态 macOS 等） */
  status?: OpenWithStatus
  /** 平台能力提示：该键在本平台能否程序化设为默认 */
  caps: {
    /** 一键程序化设为系统默认可用 */
    canSetDefault: boolean
    /** 只能引导到系统设置完成（Windows UserChoice / macOS） */
    needsSystemSettings: boolean
  }
}

/** IPC list() 响应：所有候选可选；只有 inspectedKey 对应行包含本次查询的系统能力与状态。 */
export interface OpenWithListResult {
  platform: NodeJS.Platform
  /** dev 态下 scheme 注册不可靠（macOS）：true 时状态列显示"仅打包可用" */
  packaged: boolean
  rows: OpenWithRow[]
  inspectedKey?: OpenWithKey
}

/** IPC set/unset 请求与响应 */
export interface OpenWithSetRequest {
  key: OpenWithKey
  pluginId: string
}
export interface OpenWithActionResult {
  ok: boolean
  error?: string
  /** 操作成功但系统层只完成候选注册时的引导文案 */
  hint?: string
  /** 执行后的最新状态（供 UI 就地刷新，免二次 list） */
  status?: OpenWithStatus
}

/**
 * 进入载荷（壳 → 插件）：双击文件 / 点击链接命中路由后，壳以
 * enter.code='open-file'|'open-url'、payload=OpenWithEnterPayload 唤起插件。
 */
export interface OpenWithEnterPayload {
  /** 绝对路径列表（展示用）；同类型多文件合并为一次进入 */
  paths?: string[]
  /** 宿主签发的只读文件句柄（插件经 localFiles.read 读取，不能拿裸路径绕开授权） */
  handles?: import('./local-files').LocalFileHandle[]
  /** open-url 时的完整 URL */
  url?: string
}

/** Validate the manifest/IPC declaration before it can become a routing candidate. */
export function readOpenWithContribution(value: unknown): OpenWithContribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid openWith declaration')
  const entry = value as Record<string, unknown>
  if (Object.keys(entry).some(key => !['id', 'extensions', 'schemes', 'mimeTypes', 'role', 'schemaVersion'].includes(key))) throw new Error('Unknown openWith field')
  if (typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 64 || /[\x00-\x1f\x7f]/.test(entry.id)) throw new Error('Invalid openWith id')
  if (entry.schemaVersion !== undefined && entry.schemaVersion !== CONTRIB_SCHEMA_VERSION) throw new Error('Unsupported openWith schema version')
  const result: OpenWithContribution = { id: entry.id }
  if (entry.role !== undefined) {
    if (entry.role !== 'Editor' && entry.role !== 'Viewer' && entry.role !== 'Browser') throw new Error('Invalid openWith role')
    result.role = entry.role
  }
  for (const field of ['extensions', 'schemes', 'mimeTypes'] as const) {
    const list = entry[field]
    if (list === undefined) continue
    if (!Array.isArray(list) || list.length > (field === 'schemes' ? 8 : 64) || new Set(list).size !== list.length
      || !Array.from(list).every(item => typeof item === 'string' && item.length <= 127 && (field === 'mimeTypes'
        ? OPEN_WITH_MIME_RE.test(item) : validOpenWithValue(field === 'schemes' ? 'scheme' : 'ext', item)))) throw new Error(`Invalid openWith.${field}`)
    result[field] = [...list]
  }
  if (!result.extensions?.length && !result.schemes?.length) throw new Error('openWith needs an extension or URL scheme')
  return result
}

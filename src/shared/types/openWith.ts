/**
 * openWith — 「设为默认打开方式」跨端契约（壳统一能力）
 *
 * 背景：插件是壳内 WebContentsView，不是 OS 应用；任何平台的系统关联写入目标
 * 只能是 eNest 本体。因此插件仅经 manifest.contributes.openWith 声明可处理的
 * 类型/scheme，注册（macOS/Windows/Linux）与「类型→插件」路由全由壳负责。
 *
 * 键约定：文件类型一律 `ext:<小写无点扩展名>`；scheme 一律 `scheme:<小写名>`。
 * 路由表存设置段 `openWith`（仅主进程写，renderer 写入在 shell:set-settings 剥离）。
 */

import type { OpenWithContribution } from './plugin'

/** 壳保留 / 非法 scheme：插件不得声明占用 */
export const RESERVED_OPEN_WITH_SCHEMES = ['enest', 'http', 'https', 'file', 'mailto'] as const

/** scheme 形状：RFC 3986 scheme 子集，小写字母开头 */
export const OPEN_WITH_SCHEME_RE = /^[a-z][a-z0-9+.-]*$/
/** 扩展名形状：小写字母数字，1-10 位，无点 */
export const OPEN_WITH_EXT_RE = /^[a-z0-9]{1,10}$/
/** MIME 形状：type/subtype 粗校验 */
export const OPEN_WITH_MIME_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/

export type OpenWithKey = `ext:${string}` | `scheme:${string}`

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

/** IPC list() 响应 */
export interface OpenWithListResult {
  platform: NodeJS.Platform
  /** dev 态下 scheme 注册不可靠（macOS）：true 时状态列显示"仅打包可用" */
  packaged: boolean
  rows: OpenWithRow[]
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

/** 校验单条 openWith 贡献的形状与保留字；返回错误列表（空=合法） */
export function validateOpenWithContribution(
  c: OpenWithContribution,
  takenSchemes?: ReadonlySet<string>
): string[] {
  const errors: string[] = []
  const lists: Array<['extensions' | 'mimeTypes' | 'schemes', string[], RegExp]> = [
    ['extensions', c.extensions ?? [], OPEN_WITH_EXT_RE],
    ['mimeTypes', c.mimeTypes ?? [], OPEN_WITH_MIME_RE],
    ['schemes', c.schemes ?? [], OPEN_WITH_SCHEME_RE]
  ]
  for (const [field, list, re] of lists) {
    if (!Array.isArray(list)) {
      errors.push(`openWith.${field} must be an array`)
      continue
    }
    for (const v of list) {
      if (typeof v !== 'string' || !re.test(v)) {
        errors.push(`openWith.${field}: invalid value ${JSON.stringify(String(v))}`)
      } else if (field === 'schemes' && (RESERVED_OPEN_WITH_SCHEMES as readonly string[]).includes(v)) {
        errors.push(`openWith.schemes: ${v} is reserved by the shell`)
      } else if (field === 'schemes' && takenSchemes?.has(v)) {
        errors.push(`openWith.schemes: ${v} already claimed by another plugin`)
      }
    }
    if (list.length > 64) errors.push(`openWith.${field}: too many entries (max 64)`)
  }
  if (!c.extensions?.length && !c.mimeTypes?.length && !c.schemes?.length) {
    errors.push('openWith entry declares nothing (extensions/mimeTypes/schemes all empty)')
  }
  return errors
}

/**
 * themePacks — 主题包注册表
 * 持久化注册记录到数据根目录 themes/registry.json；内置定义始终以编译产物为准。
 * appearanceService 读取注册表并产生权威外观快照，登记本身不会切换主题。
 * 被 pluginHandlers（theme.register）与 shellHandlers 调用。
 * 加固：token 值白名单校验（剔除危险 CSS 片段）、每插件 pack 数量上限、
 * 只允许覆盖自己来源的 pack。
 * 关键依赖：pathsService、logService、@shared/types/plugin。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { BackgroundConfig, ThemePack } from '@shared/types/plugin'
import type { ThemePackV2 } from '@shared/types/appearance'
import { isPluginAssetPath } from '@shared/pluginContract'
import { validateBackgroundEffects } from '@shared/backgroundEffects'
import { validateThemePackV2 } from '@shared/theme/appearance'
import { BUILTIN_THEME_PACKS } from '@shared/theme/builtinThemes'
import { getAppPaths } from '@main/paths/pathsService'
import { logWarn } from '@main/logs/logService'

/** 单个来源（插件）最多可注册的主题包数量 */
const MAX_PACKS_PER_SOURCE = 8

function registryFile(): string {
  return join(getAppPaths().themes, 'registry.json')
}

function isThemePack(value: unknown): value is ThemePack {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return (
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    typeof p.name === 'string' &&
    p.tokens !== null &&
    typeof p.tokens === 'object' &&
    !Array.isArray(p.tokens)
  )
}

/** token 值长度上限（覆盖 font-family 长栈场景） */
const MAX_TOKEN_VALUE_LEN = 200
/** Tokens are custom properties, never CSS selectors or normal root style properties. */
const TOKEN_NAME_RE = /^--[A-Za-z0-9_-]{1,126}$/

/** 危险片段：注入 CSS / 脚本 / 外链资源 */
const FORBIDDEN_TOKEN_FRAGMENTS = ['url(', 'expression(', 'javascript:', '<', '>', '\\']

/** 数值（可带单位）：整数/小数 + 可选 px/s/%/ms/em/rem/vh/vw */
const NUMERIC_TOKEN_RE = /^-?\d+(\.\d+)?(px|s|ms|%|em|rem|vh|vw)?$/

/** hex 颜色：#rgb / #rgba / #rrggbb / #rrggbbaa */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** rgb()/rgba() 函数：数字或百分比分量，容许空格 */
const RGB_FUNC_RE = /^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\)$/

/**
 * 主题 Token 值白名单校验。
 * 允许：hex 颜色、rgb()/rgba() 函数、纯数字/带单位数值（px/s/%/ms/em 等）、
 * 常见 font-family 字符串（≤200 字符）。禁止 url( / expression( / javascript:
 * 等危险片段，防止经 CSS 变量注入脚本或外链资源。
 */
export function isValidThemeTokenValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!v || v.length > MAX_TOKEN_VALUE_LEN) return false
  const lower = v.toLowerCase()
  for (const frag of FORBIDDEN_TOKEN_FRAGMENTS) {
    if (lower.includes(frag)) return false
  }
  if (HEX_COLOR_RE.test(v)) return true
  if (RGB_FUNC_RE.test(v)) return true
  if (NUMERIC_TOKEN_RE.test(v)) return true
  // 剩余按 font-family 字符串放行：字母/数字/常用标点（引号、逗号、连字符、空格）
  return /^[\w '"(),.\-]+$/.test(v)
}

/** 过滤 tokens：非法键值对剔除并告警；返回 null 表示整体非法 */
function sanitizeTokens(source: string, tokens: unknown): Record<string, string> | null {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(tokens as Record<string, unknown>)) {
    if (!TOKEN_NAME_RE.test(key)) {
      logWarn('theme', `${source}: 非法主题 Token 名已剔除`)
      continue
    }
    if (!isValidThemeTokenValue(value)) {
      logWarn('theme', `${source}: token "${key}" 值非法已剔除 (${String(value).slice(0, 40)})`)
      continue
    }
    cleaned[key] = value as string
  }
  return cleaned
}

/** Shell-rendered backgrounds cannot grant a plugin network or arbitrary local-file access. */
function sanitizeBackground(source: string, value: unknown): BackgroundConfig | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const opacity = typeof candidate.opacity === 'number' && Number.isFinite(candidate.opacity)
    ? Math.max(0, Math.min(1, candidate.opacity)) : 0.85
  const fit = candidate.fit === 'contain' ? 'contain' : 'cover'
  if (candidate.type === 'none') return { type: 'none', value: '', opacity, fit }
  if (typeof candidate.value !== 'string' || candidate.value.length > 2048) return undefined
  const text = candidate.value.trim()
  if (candidate.type === 'color') {
    if (HEX_COLOR_RE.test(text) || RGB_FUNC_RE.test(text) || text === 'transparent') {
      return { type: 'color', value: text, opacity, fit }
    }
    return undefined
  }
  if (candidate.type !== 'image' && candidate.type !== 'video') return undefined
  try {
    const url = new URL(text)
    if (url.protocol !== 'enest:' || url.hostname !== 'plugin' || url.port || url.username || url.password || url.search || url.hash) return undefined
    const path = decodeURIComponent(url.pathname)
    const prefix = `/${source}/`
    if (!path.startsWith(prefix)) return undefined
    const asset = path.slice(prefix.length)
    if (!asset.startsWith('assets/') || !isPluginAssetPath(asset)) return undefined
    if (!(candidate.type === 'image' ? /\.(png|jpe?g|gif|webp|svg|ico)$/i : /\.(mp4|webm|mov)$/i).test(asset)) return undefined
    // pluginProtocol resolves this canonical asset against the registered package
    // root and rejects missing files, symlinks and escapes at request time.
    return { type: candidate.type, value: url.href, opacity, fit }
  } catch { return undefined }
}

function cleanBackground(pack: ThemePack): void {
  const background = sanitizeBackground(pack.source, pack.background)
  if (pack.background !== undefined && !background) logWarn('theme', `${pack.source}: 非法主题背景已剔除`)
  if (background) pack.background = background
  else delete pack.background
}

function cleanBackgroundEffects(pack: ThemePack, fromDisk = false): void {
  if (pack.backgroundEffects === undefined) return
  try {
    pack.backgroundEffects = validateBackgroundEffects(pack.backgroundEffects, pack.source)
  } catch (error) {
    if (!fromDisk) throw error
    delete pack.backgroundEffects
    logWarn('theme', `${pack.source}: 非法背景动效声明已剔除`)
  }
}

function preparePack(input: unknown, source?: string, fromDisk = false): ThemePack | ThemePackV2 {
  if (!isThemePack(input)) throw new Error('invalid theme pack: require id, name and tokens')
  const owner = source || input.source || 'enest.builtin'
  if (typeof owner !== 'string') throw new Error('invalid theme source')
  if (owner === 'enest.builtin') throw new Error('reserved theme source')
  const schemaVersion = (input as { schemaVersion?: unknown }).schemaVersion
  if (schemaVersion === 2) {
    const saved = validateThemePackV2(input, owner)
    // V2 updates are atomic: invalid compatibility effects reject the whole pack.
    cleanBackgroundEffects(saved)
    return saved
  }
  if (schemaVersion !== undefined && schemaVersion !== 1 && schemaVersion !== '1') {
    throw new Error('unsupported theme pack schemaVersion')
  }
  const saved = { ...structuredClone(input), source: owner }
  const tokens = sanitizeTokens(owner, saved.tokens)
  if (!tokens) throw new Error('invalid theme pack: tokens must be an object')
  saved.tokens = tokens
  cleanBackground(saved)
  cleanBackgroundEffects(saved, fromDisk)
  return saved
}

export class ThemePackRegistry {
  private packs = new Map<string, ThemePack>()
  private persistTail: Promise<void> = Promise.resolve()

  async load(): Promise<void> {
    this.packs.clear()
    for (const pack of BUILTIN_THEME_PACKS) this.packs.set(pack.id, structuredClone(pack))
    const file = registryFile()
    if (!existsSync(file)) return
    try {
      const raw = JSON.parse(await readFile(file, 'utf-8')) as unknown
      const list = Array.isArray(raw) ? raw : []
      for (const item of list) {
        if (!isThemePack(item)) continue
        const source = item.source || 'enest.builtin'
        // Host built-ins are always restored from the compiled bundle, never disk.
        if (source === 'enest.builtin') continue
        if (typeof source !== 'string') continue
        const existing = this.packs.get(item.id)
        if (existing && existing.source !== source) continue
        if (!existing && this.countBySource(source) >= MAX_PACKS_PER_SOURCE) continue
        try {
          const saved = preparePack(item, source, true)
          this.packs.set(saved.id, saved)
        } catch (error) {
          logWarn('theme', `${source}: invalid theme pack skipped (${(error as Error).message})`)
        }
      }
    } catch {
      // 损坏文件忽略，从空表开始
    }
  }

  list(): ThemePack[] {
    return [...this.packs.values()].map((p) => structuredClone(p))
  }

  get(id: string): ThemePack | null {
    const pack = this.packs.get(id)
    return pack ? structuredClone(pack) : null
  }

  /** 当前某来源（插件）已注册的 pack 数量 */
  countBySource(source: string): number {
    let n = 0
    for (const pack of this.packs.values()) {
      if (pack.source === source) n++
    }
    return n
  }

  /** Plugin entry points bind identity here; enest.builtin belongs only to the host. */
  async registerPlugin(pack: unknown, pluginId: string): Promise<ThemePack | ThemePackV2> {
    if (!pluginId || pluginId === 'enest.builtin') throw new Error('reserved theme source')
    if (!isThemePack(pack)) throw new Error('invalid theme pack: require id, name and tokens')
    return this.register({ ...pack, source: pluginId })
  }

  /** Host-only: trusted definitions come from the compiled bundle, never a caller payload. */
  async registerBuiltin(id: string): Promise<ThemePackV2> {
    const pack = BUILTIN_THEME_PACKS.find((candidate) => candidate.id === id)
    if (!pack) throw new Error('unknown built-in theme')
    this.packs.set(pack.id, structuredClone(pack))
    return structuredClone(pack)
  }

  /**
   * 注册/覆盖主题包（同 id 覆盖）并落盘。
   * 加固规则（source 非内置时）：
   * - 目标 id 已存在且 source 不同 → 拒绝（只允许覆盖自己的 pack）
   * - 同来源 pack 数超上限 → 拒绝（覆盖自身已存在的 id 不占新名额）
   * - token 值经白名单过滤，非法键值对剔除
   */
  async register(pack: ThemePackV2): Promise<ThemePackV2>
  async register(pack: ThemePack): Promise<ThemePack>
  async register(pack: unknown): Promise<ThemePack | ThemePackV2>
  async register(pack: unknown): Promise<ThemePack | ThemePackV2> {
    return this.savePack(preparePack(pack))
  }

  private async savePack<T extends ThemePack>(saved: T): Promise<T> {
    const existing = this.packs.get(saved.id)
    if (existing && existing.source !== saved.source) {
      throw new Error(
        `theme pack id already registered by ${existing.source}: ${saved.id}`
      )
    }
    if (
      saved.source !== 'enest.builtin' &&
      !existing &&
      this.countBySource(saved.source) >= MAX_PACKS_PER_SOURCE
    ) {
      throw new Error(`theme pack limit reached for ${saved.source} (max ${MAX_PACKS_PER_SOURCE})`)
    }

    this.packs.set(saved.id, saved)
    await this.persist()
    return structuredClone(saved)
  }

  async remove(id: string): Promise<boolean> {
    if (this.packs.get(id)?.source === 'enest.builtin') return false
    const removed = this.packs.delete(id)
    if (removed) await this.persist()
    return removed
  }

  /**
   * 按来源插件移除其注册的全部主题包（插件卸载时 GC）。
   * 返回被删除的 pack id 列表；无匹配时不落盘。
   */
  async removeBySource(source: string): Promise<string[]> {
    if (!source || source === 'enest.builtin') return []
    const removedIds: string[] = []
    for (const [id, pack] of this.packs) {
      if (pack.source === source) {
        this.packs.delete(id)
        removedIds.push(id)
      }
    }
    if (removedIds.length > 0) await this.persist()
    return removedIds
  }

  private persist(): Promise<void> {
    const operation = this.persistTail.catch(() => {}).then(async () => {
      const file = registryFile(), temporary = `${file}.${randomUUID()}.tmp`
      await mkdir(dirname(file), { recursive: true })
      try {
        const extensions = this.list().filter(pack => pack.source !== 'enest.builtin')
        await writeFile(temporary, JSON.stringify(extensions, null, 2), { encoding: 'utf8', flag: 'wx' })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
    })
    this.persistTail = operation
    return operation
  }
}

export const themePackRegistry = new ThemePackRegistry()

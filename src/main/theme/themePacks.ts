/**
 * themePacks — 主题包注册表
 * 职责：持久化插件/内置注册的 ThemePack 到 ~/eNest/themes/registry.json，
 * 供 shell:get-theme 一并返回 packs 列表。
 * 被 pluginHandlers（theme.register）与 shellHandlers 调用。
 * 加固：token 值白名单校验（剔除危险 CSS 片段）、每插件 pack 数量上限、
 * 只允许覆盖自己来源的 pack。
 * 关键依赖：pathsService、logService、@shared/types/plugin。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ThemePack } from '@shared/types/plugin'
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
    if (!isValidThemeTokenValue(value)) {
      logWarn('theme', `${source}: token "${key}" 值非法已剔除 (${String(value).slice(0, 40)})`)
      continue
    }
    cleaned[key] = value as string
  }
  return cleaned
}

export class ThemePackRegistry {
  private packs = new Map<string, ThemePack>()

  async load(): Promise<void> {
    this.packs.clear()
    const file = registryFile()
    if (!existsSync(file)) return
    try {
      const raw = JSON.parse(await readFile(file, 'utf-8')) as unknown
      const list = Array.isArray(raw) ? raw : []
      for (const item of list) {
        if (isThemePack(item)) this.packs.set(item.id, item)
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

  /**
   * 注册/覆盖主题包（同 id 覆盖）并落盘。
   * 加固规则（source 非内置时）：
   * - 目标 id 已存在且 source 不同 → 拒绝（只允许覆盖自己的 pack）
   * - 同来源 pack 数超上限 → 拒绝（覆盖自身已存在的 id 不占新名额）
   * - token 值经白名单过滤，非法键值对剔除
   */
  async register(pack: ThemePack): Promise<ThemePack> {
    if (!isThemePack(pack)) {
      throw new Error('invalid theme pack: require id and name')
    }
    const saved: ThemePack = structuredClone(pack)
    if (!saved.source) saved.source = 'enest.builtin'

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

    const tokens = sanitizeTokens(saved.source, saved.tokens)
    if (!tokens) {
      throw new Error('invalid theme pack: tokens must be an object')
    }
    saved.tokens = tokens

    this.packs.set(saved.id, saved)
    await this.persist()
    return structuredClone(saved)
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.packs.delete(id)
    if (removed) await this.persist()
    return removed
  }

  /**
   * 按来源插件移除其注册的全部主题包（插件卸载时 GC）。
   * 返回被删除的 pack id 列表；无匹配时不落盘。
   */
  async removeBySource(source: string): Promise<string[]> {
    if (!source) return []
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

  private async persist(): Promise<void> {
    const file = registryFile()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(this.list(), null, 2), 'utf-8')
  }
}

export const themePackRegistry = new ThemePackRegistry()

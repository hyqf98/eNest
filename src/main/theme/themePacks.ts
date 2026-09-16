/**
 * themePacks — 主题包注册表
 * 职责：持久化插件/内置注册的 ThemePack 到 ~/eNest/themes/registry.json，
 * 供 shell:get-theme 一并返回 packs 列表。
 * 被 pluginHandlers（theme.register）与 shellHandlers 调用。
 * 关键依赖：pathsService、@shared/types/plugin。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ThemePack } from '@shared/types/plugin'
import { getAppPaths } from '../paths/pathsService'

function registryFile(): string {
  return join(getAppPaths().themes, 'registry.json')
}

function isThemePack(value: unknown): value is ThemePack {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return typeof p.id === 'string' && p.id.length > 0 && typeof p.name === 'string'
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

  /** 注册/覆盖主题包（同 id 覆盖）并落盘 */
  async register(pack: ThemePack): Promise<ThemePack> {
    if (!isThemePack(pack)) {
      throw new Error('invalid theme pack: require id and name')
    }
    const saved: ThemePack = structuredClone(pack)
    if (!saved.source) saved.source = 'enest.builtin'
    this.packs.set(saved.id, saved)
    await this.persist()
    return structuredClone(saved)
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.packs.delete(id)
    if (removed) await this.persist()
    return removed
  }

  private async persist(): Promise<void> {
    const file = registryFile()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(this.list(), null, 2), 'utf-8')
  }
}

export const themePackRegistry = new ThemePackRegistry()

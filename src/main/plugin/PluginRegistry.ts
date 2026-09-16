/**
 * PluginRegistry — 插件注册表
 * 职责：扫描 ~/eNest/plugins（pathsService）下已安装插件，维护安装/开发态插件列表与 manifest，
 * 支持从示例目录安装、开发态加载。
 * 被 index.ts 扫描初始化，被 PluginHost / shellHandlers / pluginHandlers 查询。
 * 关键依赖：pathsService、mockMarket（市场元数据）、PluginInstaller（manifest 解析）。
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { PluginManifest, PluginSummary } from '@shared/types/plugin'
import { resolvePluginForm, resolvePluginUi } from '@shared/types/plugin'
import { getAppPaths } from '@main/paths/pathsService'
import { MOCK_MARKET_PLUGINS, mockToSummary, shortNameOf } from '@main/plugin/mockMarket'
import { installFromDirectory } from '@main/plugin/PluginInstaller'
import { fetchRemoteMarket, type MarketPluginSummary } from '@main/plugin/marketClient'
import { logInfo, logWarn } from '@main/logs/logService'

export interface InstalledPlugin {
  manifest: PluginManifest
  rootPath: string
  version: string
}

function pluginsRoot(): string {
  return getAppPaths().plugins
}

function samplesRoot(): string {
  return join(app.getAppPath(), 'plugins-samples')
}

function manifestToSummary(
  manifest: PluginManifest,
  rootPath: string,
  extras?: Partial<PluginSummary>
): PluginSummary {
  const market = MOCK_MARKET_PLUGINS.find((m) => m.id === manifest.id)
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? market?.description ?? '',
    author: manifest.author ?? market?.author ?? '',
    category: market?.category ?? '效率',
    installs: market?.installs ?? 'local',
    color: market?.color ?? '#5b8cff',
    glyph: market?.glyph ?? manifest.name.slice(0, 1),
    permissions: manifest.permissions ?? [],
    installed: true,
    rootPath,
    // UI 段归一：缺省 chrome=default / themeAware=true / background=opaque / preferredColorScheme=auto
    ui: resolvePluginUi(manifest.ui),
    form: resolvePluginForm(manifest.form),
    ...extras
  }
}

export class PluginRegistry {
  private installed = new Map<string, InstalledPlugin>()
  private dev = new Map<string, PluginSummary>()
  private devManifests = new Map<string, PluginManifest>()
  /** 远程 eNest_plugin 市场缓存；断网时沿用上次成功结果 */
  private remoteMarket: MarketPluginSummary[] = []
  private remoteFetchedAt = 0

/** 扫描 userData/plugins 下所有已安装插件，解析 manifest 并缓存到内存 */
  async scan(): Promise<void> {
    this.installed.clear()
    const root = pluginsRoot()
    if (!existsSync(root)) return
    let ids: string[]
    try {
      ids = await readdir(root)
    } catch {
      return
    }
    for (const id of ids) {
      const idDir = join(root, id)
      try {
        if (!(await stat(idDir)).isDirectory()) continue
        const versions = await readdir(idDir)
        if (versions.length === 0) continue
        const version = versions.sort().at(-1)!
        const pluginDir = join(idDir, version)
        const manifest = await installFromDirectory(pluginDir)
        this.installed.set(manifest.id, {
          manifest,
          rootPath: pluginDir,
          version: manifest.version
        })
      } catch {
        // skip invalid plugin dirs
      }
    }
    // 启动后异步拉取远程市场，不阻塞 scan
    void this.refreshRemoteMarket()
  }

  /** 拉取 eNest_plugin registry；成功则覆盖 remoteMarket */
  async refreshRemoteMarket(force = false): Promise<void> {
    const ttl = 5 * 60 * 1000
    if (!force && Date.now() - this.remoteFetchedAt < ttl) return
    const list = await fetchRemoteMarket()
    this.remoteFetchedAt = Date.now()
    if (list.length) {
      this.remoteMarket = list
      logInfo('registry', `remote market ok: ${list.length} plugins`)
    } else {
      logWarn('registry', 'remote market empty or unreachable, keep local/mock')
    }
  }

  getRemoteMarket(): MarketPluginSummary[] {
    return this.remoteMarket
  }

/** 返回合并后的插件列表：远程市场 → mock → 已安装 → 开发态（后者覆盖前者） */
  list(): PluginSummary[] {
    const byId = new Map<string, PluginSummary>()
    for (const remote of this.remoteMarket) {
      byId.set(remote.id, {
        id: remote.id,
        name: remote.name,
        version: remote.version,
        description: remote.description,
        author: remote.author,
        category: remote.category,
        installs: remote.installs,
        color: remote.color,
        glyph: remote.glyph,
        permissions: remote.permissions,
        installed: this.installed.has(remote.id) || this.dev.has(remote.id),
        ui: remote.ui
      })
    }
    for (const mock of mockToSummary(false)) {
      if (!byId.has(mock.id)) byId.set(mock.id, mock)
    }
    for (const item of this.installed.values()) {
      byId.set(item.manifest.id, manifestToSummary(item.manifest, item.rootPath))
    }
    for (const summary of this.dev.values()) {
      byId.set(summary.id, { ...summary, installed: true })
    }
    return [...byId.values()]
  }

  get(id: string): PluginSummary | null {
    const dev = this.dev.get(id)
    if (dev) return { ...dev, installed: true }
    const inst = this.installed.get(id)
    if (inst) return manifestToSummary(inst.manifest, inst.rootPath)
    const remote = this.remoteMarket.find((s) => s.id === id)
    if (remote) {
      return {
        id: remote.id,
        name: remote.name,
        version: remote.version,
        description: remote.description,
        author: remote.author,
        category: remote.category,
        installs: remote.installs,
        color: remote.color,
        glyph: remote.glyph,
        permissions: remote.permissions,
        installed: false,
        ui: remote.ui
      }
    }
    return mockToSummary(false).find((s) => s.id === id) ?? null
  }

  getManifest(id: string): PluginManifest | null {
    const devM = this.devManifests.get(id)
    if (devM) return devM
    return this.installed.get(id)?.manifest ?? null
  }

  getRootPath(id: string): string | null {
    return this.dev.get(id)?.rootPath ?? this.installed.get(id)?.rootPath ?? null
  }

/** 从内置示例目录安装插件到 userData/plugins，已安装则直接返回 */
  async installFromSample(id: string): Promise<PluginSummary> {
    if (this.installed.has(id)) {
      return this.get(id)!
    }
    const short = shortNameOf(id)
    const src = join(samplesRoot(), short)
    if (!existsSync(src)) {
      throw new Error(`sample not found: ${src}`)
    }
    const manifest = await installFromDirectory(src)
    const version = manifest.version || '0.0.0'
    const dest = join(pluginsRoot(), manifest.id, version)
    await mkdir(dest, { recursive: true })
    await cp(src, dest, { recursive: true })
    this.installed.set(manifest.id, { manifest, rootPath: dest, version })
    return this.get(manifest.id)!
  }

/** 注册开发态插件（不落盘，仅内存） */
  addDevPlugin(summary: PluginSummary, manifest?: PluginManifest): void {
    this.dev.set(summary.id, summary)
    if (manifest) this.devManifests.set(summary.id, manifest)
  }

  removeDevPlugin(id: string): void {
    this.dev.delete(id)
    this.devManifests.delete(id)
  }

/** 确保插件已安装，未安装则从示例目录自动安装 */
  async ensureInstalled(id: string): Promise<PluginSummary> {
    const existing = this.get(id)
    if (existing?.installed && existing.rootPath) return existing
    return this.installFromSample(id)
  }
}

export const pluginRegistry = new PluginRegistry()

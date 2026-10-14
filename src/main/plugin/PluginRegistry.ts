/**
 * PluginRegistry — 插件注册表
 * 职责：扫描 ~/.eNest/plugins（pathsService）下已安装插件，维护安装/开发态插件列表与 manifest，
 * 支持从示例目录安装、远程市场下载安装、开发态加载；合并启用/禁用状态。
 * 被 index.ts 扫描初始化，被 PluginHost / shellHandlers / pluginHandlers 查询。
 * 关键依赖：pathsService、mockMarket（市场元数据）、PluginInstaller（manifest 解析）、
 * marketClient（远程列表与资产下载）、pluginEnabledStore（启用状态）。
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  PluginContributes,
  PluginManifest,
  PluginSummary,
  PluginUiConfig,
  ThemePack
} from '@shared/types/plugin'
import { resolvePluginUi } from '@shared/types/plugin'
import { pluginProtocolUrl } from '@shared/constants'
import { getAppPaths } from '@main/paths/pathsService'
import { MOCK_MARKET_PLUGINS, mockToSummary } from '@main/plugin/mockMarket'
import { installFromDirectory, installFromFolder, installFromZip, withInstallLock, beginPluginInstall, type InstallResult } from '@main/plugin/PluginInstaller'
import {
  downloadPluginPackage,
  fetchRemoteMarket,
  type MarketPluginSummary
} from '@main/plugin/marketClient'
import {
  isEnabledSync,
  loadDisabledIds,
  persistPluginEnabled
} from '@main/plugin/pluginEnabledStore'
import { permissionService } from '@main/plugin/PermissionService'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { themePackRegistry } from '@main/theme/themePacks'
import { sendShellEvent } from '@main/window/createShellWindow'
import { logInfo, logWarn } from '@main/logs/logService'
import { readPluginBuildRevision } from './pluginInstallTasks'
import {
  manifestCategory,
  manifestScreenshots,
  mergeMarketMetadata,
  remoteToSummary
} from '@main/plugin/marketMetadata'

export interface InstalledPlugin {
  manifest: PluginManifest
  rootPath: string
  version: string
  buildRevision?: string
}

export interface InstalledPluginDescriptor {
  readonly id: string
  readonly manifest: PluginManifest
  readonly ui: PluginUiConfig
  rootPath: string
  buildRevision: string
  enabled: boolean
  dev: boolean
}

function freezeDescriptor<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDescriptor(child)
    Object.freeze(value)
  }
  return value
}

function pluginsRoot(): string {
  return getAppPaths().plugins
}

/** Local installation consumes the same built output as a release archive. */
function resolveSampleDir(id: string): string | null {
  const path = join(app.getAppPath(), 'eNest_plugin', 'plugins', id, 'dist')
  return existsSync(join(path, 'plugin.json')) ? path : null
}

/**
 * 简易语义版本比较：点分数字段，缺段视为 0。
 * 返回 <0 / 0 / >0；预发布后缀忽略（市场包以稳定版为主）。
 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || '0').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '0').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}

/** manifest icon 按磁盘原名编码，不受 devUrl 影响。 */
function manifestIconUrl(manifest: PluginManifest): string | undefined {
  if (typeof manifest.icon !== 'string' || !manifest.icon) return undefined
  const path = manifest.icon.split('/').map(encodeURIComponent).join('/')
  return pluginProtocolUrl(manifest.id, path)
}

function manifestToSummary(
  manifest: PluginManifest,
  rootPath: string
): PluginSummary {
  const market = MOCK_MARKET_PLUGINS.find((m) => m.id === manifest.id)
  const enabled = isEnabledSync(manifest.id)
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? market?.description ?? '',
    author: manifest.author ?? market?.author ?? '',
    category: manifestCategory(manifest) ?? market?.category ?? '其它',
    installs: market?.installs ?? 'local',
    color: market?.color ?? '#5b8cff',
    glyph: market?.glyph ?? manifest.name.slice(0, 1),
    icon: manifestIconUrl(manifest),
    screenshots: manifestScreenshots(manifest),
    readmeUrl: manifest.market?.readme ? pluginProtocolUrl(manifest.id, manifest.market.readme) : undefined,
    featured: typeof manifest.market?.featured === 'boolean' ? manifest.market.featured : undefined,
    permissions: manifest.permissions ?? [],
    installed: true,
    // 禁用时省略 rootPath：commandIndex 过滤 (installed && rootPath) 自动排除禁用项
    rootPath: enabled ? rootPath : undefined,
    enabled,
    // UI 段归一：缺省 chrome=none / themeAware=true / background=opaque / preferredColorScheme=auto
    ui: resolvePluginUi(manifest.ui),
    // 贡献点声明透传（渲染层消费 homeCards 等；ManifestContributes 归一见 normalizeContributes）
    contributes: normalizeContributes(manifest.contributes)
  }
}

/**
 * manifest.contributes 归一：剔掉运行时才注册的 quickProviders（manifest 不声明）
 * 与 themePacks 里的 source 字段干扰，只透传可声明式消费的形状；异常输入返回 undefined。
 */
function normalizeContributes(
  raw?: PluginManifest['contributes']
): PluginContributes | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: PluginContributes = {}
  if (Array.isArray(raw.settings) && raw.settings.length > 0) out.settings = raw.settings
  if (Array.isArray(raw.homeCards) && raw.homeCards.length > 0) out.homeCards = raw.homeCards
  if (Array.isArray(raw.railEntries) && raw.railEntries.length > 0) {
    out.railEntries = raw.railEntries
  }
  const hasAny =
    out.settings !== undefined || out.homeCards !== undefined || out.railEntries !== undefined
  return hasAny ? out : undefined
}

/** 若远程存在更高版本，补 latestVersion（供市场 UI 显示「更新」） */
function withUpdateHint(summary: PluginSummary, remote: MarketPluginSummary | undefined): PluginSummary {
  if (!summary.installed || !remote?.version) return summary
  if (compareVersions(remote.version, summary.version) > 0) {
    return { ...summary, latestVersion: remote.version }
  }
  return summary
}

export class PluginRegistry {
  private installed = new Map<string, InstalledPlugin>()
  private localPreviews = new Map<string, InstalledPlugin>()
  private dev = new Map<string, PluginSummary>()
  private devManifests = new Map<string, PluginManifest>()
  /** 远程 eNest_plugin 市场缓存；断网时沿用上次成功结果 */
  private remoteMarket: MarketPluginSummary[] = []
  private remoteFetchedAt = 0
  /** 拉取失败后的冷却截止时间，避免 GitHub 不可达时反复 SSL 失败刷屏 */
  private remoteFailUntil = 0
  /** 进行中的远程市场请求，去重并发 scan 触发的多次 fetch */
  private remoteFetchInFlight: Promise<void> | null = null
  /** ensureInstalled 进行中的远程下载，避免并发重复拉同一插件 */
  private installing = new Map<string, Promise<PluginSummary>>()
  private scanInFlight: Promise<void> | null = null
  private scanRequested = 0
  private installedRevision = 0
  private mutationRevision = 0
  private installedEnabledSignature = ''
  private buildEpochs = new Map<string, number>()
  private descriptors: readonly InstalledPluginDescriptor[] | null = null
  private descriptorCacheHits = 0
  private descriptorCacheMisses = 0
  private descriptorCacheBuilds = 0
  /** Preserve source order across manifest updates, disable and asynchronous disk writes. */
  private themeTasks = new Map<string, Promise<void>>()
  private themeEpochs = new Map<string, number>()

  private changed(): void {
    this.installedRevision++
    this.mutationRevision++
    this.descriptors = null
  }

  getInstalledRevision(): number { return this.installedRevision }

  /** Sampling never builds descriptors and includes no manifests or filesystem paths. */
  getDescriptorCacheMetrics() {
    return {
      hits: this.descriptorCacheHits, misses: this.descriptorCacheMisses,
      builds: this.descriptorCacheBuilds, entries: this.descriptors?.length ?? 0,
      snapshots: this.descriptors ? 1 : 0, snapshotCapacity: 1,
      installedRevision: this.installedRevision
    }
  }

  getBuildRevision(id: string): string {
    const plugin = this.installed.get(id) ?? this.localPreviews.get(id)
    const base = this.dev.has(id)
      ? `dev:${this.dev.get(id)?.rootPath ?? ''}`
      : plugin?.buildRevision ?? `${plugin?.version ?? ''}:${plugin?.rootPath ?? ''}`
    return `${base}:${this.buildEpochs.get(id) ?? 0}`
  }

  /** Explicit dev reload/update invalidates generations observed by pending opens and asset reads. */
  invalidateBuildRevision(id: string): string {
    this.buildEpochs.set(id, (this.buildEpochs.get(id) ?? 0) + 1)
    this.changed()
    return this.getBuildRevision(id)
  }

  /** Installed data only: no remote-market merge or full settings clone in the keystroke path. */
  getInstalledDescriptors(): readonly InstalledPluginDescriptor[] {
    if (this.descriptors) { this.descriptorCacheHits++; return this.descriptors }
    this.descriptorCacheMisses++
    this.descriptors = Object.freeze([...new Set([...this.installed.keys(), ...this.dev.keys()])].flatMap((id) => {
      const manifest = this.getManifest(id)
      const rootPath = this.getRootPath(id)
      return manifest && rootPath ? [freezeDescriptor({ id, manifest: structuredClone(manifest), ui: resolvePluginUi(manifest.ui), rootPath, buildRevision: this.getBuildRevision(id), enabled: isEnabledSync(id), dev: this.dev.has(id) })] : []
    }))
    this.descriptorCacheBuilds++
    return this.descriptors
  }


/**
 * manifest.contributes 声明入库（禁用插件除外；启用/安装路径同样调用）。
 * theme-packs 插槽在入库后消费：逐 pack 注册进 themePackRegistry（声明式断链修复）。
 */
private syncContributes(manifest: PluginManifest, enabled: boolean): void {
  try {
    if (enabled) {
      const previousThemeIds = contributionRegistry.listSlot<ThemePack>('theme-packs')
        .filter(entry => entry.source === manifest.id).map(entry => entry.id)
      contributionRegistry.registerManifestContributes(manifest.id, manifest.contributes)
      this.applyThemePackContributions(manifest.id, previousThemeIds)
    } else {
      // 禁用插件的声明式贡献不显示
      contributionRegistry.unregisterBySource(manifest.id)
      this.removeThemePackContributions(manifest.id)
      // 禁用即取消该插件挂起/排队中的权限请求（按拒绝 settle，不持久化）
      permissionService.cancelFor(manifest.id)
    }
  } catch (err) {
    logWarn('registry', `contributes sync failed for ${manifest.id}: ${(err as Error).message}`)
  }
}

/**
 * 消费 theme-packs 插槽：listSlot 中该插件的条目逐个注册进
 * themePackRegistry（source 强制绑定插件 id），完成后推 theme-packs-changed。
 * 异步 fire-and-forget：syncContributes 为同步调用点（scan/启用/安装），
 * 注册失败仅记日志，不阻塞注册表主路径。
 */
  private enqueueThemeMutation(pluginId: string, mutation: (isLatest: () => boolean) => Promise<void>): void {
    const epoch = (this.themeEpochs.get(pluginId) ?? 0) + 1
    this.themeEpochs.set(pluginId, epoch)
    const task = (this.themeTasks.get(pluginId) ?? Promise.resolve()).catch(() => {}).then(() =>
      mutation(() => this.themeEpochs.get(pluginId) === epoch)
    ).catch((error) => logWarn('registry', `theme sync failed for ${pluginId}: ${(error as Error).message}`))
    this.themeTasks.set(pluginId, task)
    void task.finally(() => {
      if (this.themeTasks.get(pluginId) === task) {
        this.themeTasks.delete(pluginId)
        this.themeEpochs.delete(pluginId)
      }
    })
  }

  private applyThemePackContributions(pluginId: string, previousIds: string[]): void {
    // Snapshot the contribution rows now; a later manifest update may replace the DB rows.
    const entries = contributionRegistry.listSlot<ThemePack>('theme-packs').filter(entry => entry.source === pluginId)
    this.enqueueThemeMutation(pluginId, async (isLatest) => {
      const desired = new Set(entries.map(entry => entry.id))
      // Retirement must run even for superseded operations, so a skipped intermediate
      // update cannot strand a pack from an earlier manifest. Runtime-only packs survive.
      let changed = false
      for (const id of previousIds) {
        if (!desired.has(id) && themePackRegistry.get(id)?.source === pluginId) {
          changed = await themePackRegistry.remove(id) || changed
        }
      }
      let registered = 0
      for (const entry of entries) {
        if (!isLatest()) break
        try {
          await themePackRegistry.registerPlugin(entry.data, pluginId)
          registered++
        } catch (err) {
          logWarn('registry', `theme pack "${entry.id}" from ${pluginId} rejected: ${(err as Error).message}`)
        }
      }
      if (isLatest() && (registered > 0 || changed)) {
        logInfo('registry', `theme packs registered from manifest: ${pluginId} (${registered})`)
        sendShellEvent({ type: 'theme-packs-changed' })
      }
    })
  }

/** 禁用插件：移除其声明式注册的主题包并广播（卸载路径已有 removeBySource，此处补禁用） */
private removeThemePackContributions(pluginId: string): void {
  this.enqueueThemeMutation(pluginId, async (isLatest) => {
    try {
      const removed = await themePackRegistry.removeBySource(pluginId)
      if (removed.length > 0 && isLatest()) {
        logInfo('registry', `theme packs removed on disable: ${pluginId} (${removed.length})`)
        sendShellEvent({ type: 'theme-packs-changed' })
      }
    } catch (err) {
      logWarn('registry', `remove theme packs failed for ${pluginId}: ${(err as Error).message}`)
    }
  })
}

/** 扫描 userData/plugins 下所有已安装插件，解析 manifest 并缓存到内存 */
  scan(): Promise<void> {
    this.scanRequested++
    if (this.scanInFlight) return this.scanInFlight
    const task = (async () => {
      let request: number
      do {
        request = this.scanRequested
        const mutation = this.mutationRevision
        await loadDisabledIds()
        const next = new Map<string, InstalledPlugin>()
        const root = pluginsRoot()
        let ids: string[]
        try { ids = await readdir(root) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          ids = []
        }
        for (const id of ids) {
          if (id.startsWith('.')) continue // unpublished staging/rollback directories
          const idDir = join(root, id)
          try {
            if (!(await stat(idDir)).isDirectory()) continue
            const versions = (await readdir(idDir)).filter((name) => !name.startsWith('.')).sort(compareVersions).reverse()
            for (const version of versions) {
              const pluginDir = join(idDir, version)
              try {
                const manifest = await installFromDirectory(pluginDir, { metadataOnly: true })
                if (manifest.id !== id || manifest.version !== version) throw new Error('安装目录必须为 plugins/<id>/<version>')
                const buildRevision = await readPluginBuildRevision(pluginDir)
                next.set(manifest.id, { manifest, rootPath: pluginDir, version: manifest.version, buildRevision })
                break
              } catch (error) {
                logWarn('registry', `scan skip ${id}/${version}: ${(error as Error).message}`)
              }
            }
          } catch (error) {
            logWarn('registry', `scan skip ${id}: ${(error as Error).message}`)
          }
        }
        // An installation/dev mutation won the race. Never publish the stale disk snapshot.
        if (mutation !== this.mutationRevision) {
          this.scanRequested++
          continue
        }
        const previous = this.installed
        this.installed = next // one atomic publication: readers never see an empty/partial catalog
        const fingerprint = (items: Map<string, InstalledPlugin>) => JSON.stringify([...items].map(([id, item]) => [id, item.rootPath, item.buildRevision, item.version]).sort())
        const enabledSignature = JSON.stringify([...next.keys()].sort().map((id) => [id, isEnabledSync(id)]))
        if (fingerprint(previous) !== fingerprint(next) || enabledSignature !== this.installedEnabledSignature) this.changed()
        else this.descriptors = null // enabled state may have been reloaded
        this.installedEnabledSignature = enabledSignature
        for (const id of previous.keys()) {
          if (!next.has(id) && !this.dev.has(id)) {
            contributionRegistry.unregisterBySource(id)
            this.removeThemePackContributions(id)
          }
        }
        for (const [id, item] of next) {
          if (this.dev.has(id)) continue
          if (previous.get(id)?.buildRevision !== item.buildRevision || !previous.has(id)) {
            this.syncContributes(item.manifest, isEnabledSync(id))
          }
        }
      } while (request !== this.scanRequested)
      await this.scanLocalPreviews()
      void this.refreshRemoteMarket()
    })()
    this.scanInFlight = task
    void task.finally(() => { if (this.scanInFlight === task) this.scanInFlight = null }).catch(() => {})
    return task
  }

  /** Development checkout previews are built packages, never runnable registry entries. */
  private async scanLocalPreviews(): Promise<void> {
    if (app.isPackaged) return
    const root = join(app.getAppPath(), 'eNest_plugin', 'plugins')
    const next = new Map<string, InstalledPlugin>()
    let ids: string[]
    try { ids = await readdir(root) } catch { return }
    for (const id of ids) {
      const path = join(root, id, 'dist')
      if (!existsSync(join(path, 'plugin.json'))) continue
      try {
        const manifest = await installFromDirectory(path, { metadataOnly: true })
        if (manifest.id !== id) continue
        next.set(id, { manifest, rootPath: path, version: manifest.version, buildRevision: String((await stat(join(path, 'plugin.json'))).mtimeMs) })
      } catch (error) { logWarn('market', `invalid local package ${id}: ${(error as Error).message}`) }
    }
    this.localPreviews = next
  }

  getAssetRootPath(id: string): string | null { return this.getRootPath(id) ?? this.localPreviews.get(id)?.rootPath ?? null }
  getAssetManifest(id: string): PluginManifest | null { return this.getManifest(id) ?? this.localPreviews.get(id)?.manifest ?? null }

  /** 拉取 eNest_plugin registry；成功则覆盖 remoteMarket */
  async refreshRemoteMarket(force = false): Promise<void> {
    const ttl = 5 * 60 * 1000
    const failCooldownMs = 45 * 1000
    if (!force && Date.now() - this.remoteFetchedAt < ttl) return
    // GitHub/代理不可达时进入冷却，避免每次 scan 都打 SSL 握手失败
    if (!force && Date.now() < this.remoteFailUntil) return
    if (this.remoteFetchInFlight) return this.remoteFetchInFlight
    this.remoteFetchInFlight = (async () => {
      try {
        const list = await fetchRemoteMarket()
        this.remoteFetchedAt = Date.now()
        if (list.length) {
          this.remoteMarket = list
          this.remoteFailUntil = 0
          logInfo('registry', `remote market ok: ${list.length} plugins`)
        } else {
          this.remoteFailUntil = Date.now() + failCooldownMs
          logWarn('registry', 'remote market empty or unreachable, keep local/mock')
        }
      } catch (err) {
        this.remoteFetchedAt = Date.now()
        this.remoteFailUntil = Date.now() + failCooldownMs
        logWarn('registry', `remote market failed: ${(err as Error).message}`)
      } finally {
        this.remoteFetchInFlight = null
      }
    })()
    return this.remoteFetchInFlight
  }

  getRemoteMarket(): MarketPluginSummary[] {
    return this.remoteMarket
  }

  getRemoteEntry(id: string): MarketPluginSummary | undefined {
    return this.remoteMarket.find((s) => s.id === id)
  }

  /** 统一 list/get 的合并顺序，安装与开发态不会丢失市场展示元数据。 */
  list(): PluginSummary[] {
    const ids = new Set([
      ...this.remoteMarket.map((entry) => entry.id),
      ...MOCK_MARKET_PLUGINS.map((entry) => entry.id),
      ...this.installed.keys(),
      ...this.localPreviews.keys(),
      ...this.dev.keys()
    ])
    return [...ids].flatMap((id) => {
      const summary = this.get(id)
      return summary ? [summary] : []
    })
  }

  get(id: string): PluginSummary | null {
    const remote = this.getRemoteEntry(id)
    const dev = this.dev.get(id)
    if (dev) {
      const manifest = this.devManifests.get(id)
      const enabled = isEnabledSync(id)
      const summary: PluginSummary = {
        ...dev,
        installed: true,
        dev: true,
        enabled,
        rootPath: enabled ? dev.rootPath : undefined,
        ...(manifest ? {
          category: manifestCategory(manifest) ?? dev.category,
          icon: manifestIconUrl(manifest) ?? dev.icon,
          screenshots: manifestScreenshots(manifest),
          readmeUrl: manifest.market?.readme ? pluginProtocolUrl(id, manifest.market.readme) : undefined,
          featured: typeof manifest.market?.featured === 'boolean' ? manifest.market.featured : undefined,
          contributes: normalizeContributes(manifest.contributes)
        } : {})
      }
      return withUpdateHint(mergeMarketMetadata(summary, remote), remote)
    }
    const installed = this.installed.get(id)
    if (installed) {
      const summary = manifestToSummary(installed.manifest, installed.rootPath)
      return withUpdateHint(mergeMarketMetadata(summary, remote), remote)
    }
    const preview = this.localPreviews.get(id)
    if (preview) return { ...manifestToSummary(preview.manifest, preview.rootPath), installed: false, rootPath: undefined }
    if (remote) return remoteToSummary(remote, isEnabledSync(id))
    return mockToSummary(false).find((summary) => summary.id === id) ?? null
  }

  getManifest(id: string): PluginManifest | null {
    const devM = this.devManifests.get(id)
    if (devM) return devM
    return this.installed.get(id)?.manifest ?? null
  }

  getRootPath(id: string): string | null {
    return this.dev.get(id)?.rootPath ?? this.installed.get(id)?.rootPath ?? null
  }

  /** 插件是否启用（同步缓存；未加载视为 true） */
  isEnabled(id: string): boolean {
    return isEnabledSync(id)
  }

  /**
   * 设置启用状态并持久化到 disabled.json。
   * 禁用时不强制关已打开 Tab（用户可自行关）；openPlugin 会拒绝新的打开。
   */
  async setPluginEnabled(id: string, enabled: boolean): Promise<PluginSummary> {
    await persistPluginEnabled(id, enabled)
    // 禁用集合变更后 list/get 需立刻反映
    await loadDisabledIds()
    this.changed()
    // 贡献点：禁用即撤下声明式贡献，启用即按当前 manifest 重放
    const manifest = this.getManifest(id)
    if (manifest) this.syncContributes(manifest, enabled)
    logInfo('registry', `${id} ${enabled ? 'enabled' : 'disabled'}`)
    sendShellEvent({ type: 'plugins-changed' })
    const summary = this.get(id)
    if (!summary) throw new Error(`plugin not found: ${id}`)
    return summary
  }

  /** Installer calls this before releasing the same-id package lock. */
  publishInstalledBuild(result: InstallResult): void {
    this.installed.set(result.manifest.id, {
      manifest: result.manifest, rootPath: result.dest,
      version: result.manifest.version || '0.0.0', buildRevision: result.buildRevision
    })
    this.changed()
    this.syncContributes(result.manifest, isEnabledSync(result.manifest.id))
  }

/** 从内置示例目录安装插件到 userData/plugins，已安装则直接返回 */
  async installFromSample(id: string): Promise<PluginSummary> {
    if (this.installed.has(id)) {
      return this.get(id)!
    }
    const src = resolveSampleDir(id)
    if (!src) {
      throw new Error(`sample not found for plugin: ${id}`)
    }
    const { manifest } = await installFromFolder(src, pluginsRoot(), undefined, undefined, (result) => this.publishInstalledBuild(result))
    return this.get(manifest.id)!
  }

  /**
   * 从远程市场资产安装：下载 .enestplugin → sha256 校验（有则校）→ zip 安装。
   * 进度经 onProgress 回调（0–100：下载占 0–70，解压安装 70–100）。
   */
  async installFromRemote(
    id: string,
    onProgress?: (percent: number, step: string) => void
  ): Promise<PluginSummary> {
    const remote = this.getRemoteEntry(id)
    if (!remote?.assetUrl) {
      throw new Error(`no remote asset for plugin: ${id}`)
    }
    const operation = beginPluginInstall()
    onProgress?.(2, '下载安装包')
    const pkg = await downloadPluginPackage(remote.assetUrl, {
      pluginId: id,
      expectedSha256: remote.assetSha256,
      fileName: `${id}@${remote.version}.enestplugin`,
      onProgress: (p) => {
        // 下载映射到 0–70
        const pct = Math.round(p.percent * 0.7)
        onProgress?.(
          Math.max(2, pct),
          p.total
            ? `下载中 ${pct}%（${Math.round(p.received / 1024)}KB / ${Math.round(p.total / 1024)}KB）`
            : '下载中…'
        )
      }
    })
    try {
      onProgress?.(72, '解压安装')
      const result = await installFromZip(pkg.path, pluginsRoot(), (p, step) => {
        onProgress?.(72 + Math.round(p * 0.28), step)
      }, operation, (published) => this.publishInstalledBuild(published), { id, version: remote.version })
      // 安装成功后清理同 id 下更旧的版本目录（保留刚写入的）
      await withInstallLock(result.manifest.id, async () => {
        if (this.installed.get(result.manifest.id)?.rootPath === result.dest) await this.cleanupOldVersions(result.manifest.id, result.dest)
      })
      onProgress?.(100, '安装完成')
      return this.get(result.manifest.id)!
    } finally {
      await pkg.cleanup()
    }
  }

  /** 删除同插件下除 keepDir 外的旧版本目录 */
  private async cleanupOldVersions(id: string, keepDir: string): Promise<void> {
    try {
      const idDir = join(pluginsRoot(), id)
      if (!existsSync(idDir)) return
      const versions = await readdir(idDir)
      for (const v of versions) {
        const dir = join(idDir, v)
        if (dir === keepDir) continue
        await rm(dir, { recursive: true, force: true })
        logInfo('registry', `removed old version dir ${dir}`)
      }
    } catch (err) {
      logWarn('registry', `cleanup old versions failed: ${(err as Error).message}`)
    }
  }

/** 注册开发态插件（不落盘，仅内存） */
  addDevPlugin(summary: PluginSummary, manifest?: PluginManifest): PluginSummary {
    this.dev.set(summary.id, summary)
    this.invalidateBuildRevision(summary.id)
    if (manifest) {
      this.devManifests.set(summary.id, manifest)
      this.syncContributes(manifest, true)
    }
    return this.get(summary.id)!
  }

  removeDevPlugin(id: string): void {
    this.dev.delete(id)
    this.devManifests.delete(id)
    this.changed()
    // 开发态卸载：撤下其声明式贡献（含声明式主题包）
    contributionRegistry.unregisterBySource(id)
    this.removeThemePackContributions(id)
  }

/**
 * 确保插件已安装：
 * 1. 已安装/开发态 → 直接返回（用 installed/dev map，避免禁用时 summary 缺 rootPath 误判）
 * 2. 本地 sample 存在 → 同步安装
 * 3. 远程市场有资产 → 下载安装（并发去重）
 * 4. 否则抛出明确错误
 */
  async ensureInstalled(id: string): Promise<PluginSummary> {
    // 已在磁盘/开发态：直接返回。禁用插件 openPlugin 已在外层拒绝，此处仍保证 rootPath 语义正确
    if (this.installed.has(id) || this.dev.has(id)) {
      return this.get(id)!
    }

    // 并发去重：同一 id 的远程安装共享同一 Promise
    const inflight = this.installing.get(id)
    if (inflight) return inflight

    const task = (async (): Promise<PluginSummary> => {
      // sample 优先（离线可用、速度快）
      if (resolveSampleDir(id)) {
        return this.installFromSample(id)
      }
      // 远程下载
      if (this.getRemoteEntry(id)?.assetUrl) {
        logInfo('registry', `ensureInstalled → remote download ${id}`)
        return this.installFromRemote(id, (percent, step) => {
          sendShellEvent({
            type: 'install-progress',
            jobId: `ensure-${id}`,
            name: this.getRemoteEntry(id)?.name ?? id,
            progress: percent,
            step
          })
        })
      }
      throw new Error(
        `plugin not installable: ${id}（无本地 sample 且远程市场无可用资产）`
      )
    })()

    this.installing.set(id, task)
    try {
      return await task
    } finally {
      this.installing.delete(id)
    }
  }
}

export const pluginRegistry = new PluginRegistry()

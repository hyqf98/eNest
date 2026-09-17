/**
 * PluginRegistry — 插件注册表
 * 职责：扫描 ~/eNest/plugins（pathsService）下已安装插件，维护安装/开发态插件列表与 manifest，
 * 支持从示例目录安装、远程市场下载安装、开发态加载；合并启用/禁用状态。
 * 被 index.ts 扫描初始化，被 PluginHost / shellHandlers / pluginHandlers 查询。
 * 关键依赖：pathsService、mockMarket（市场元数据）、PluginInstaller（manifest 解析）、
 * marketClient（远程列表与资产下载）、pluginEnabledStore（启用状态）。
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { PluginManifest, PluginSummary } from '@shared/types/plugin'
import { resolvePluginForm, resolvePluginUi } from '@shared/types/plugin'
import { getAppPaths } from '@main/paths/pathsService'
import { MOCK_MARKET_PLUGINS, mockToSummary, shortNameOf } from '@main/plugin/mockMarket'
import { installFromDirectory, installFromZip } from '@main/plugin/PluginInstaller'
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
import { logInfo, logWarn } from '@main/logs/logService'
import { sendShellEvent } from '@main/window/createShellWindow'

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

function manifestToSummary(
  manifest: PluginManifest,
  rootPath: string,
  extras?: Partial<PluginSummary>
): PluginSummary {
  const market = MOCK_MARKET_PLUGINS.find((m) => m.id === manifest.id)
  const enabled = isEnabledSync(manifest.id)
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
    // 禁用时省略 rootPath：commandIndex 过滤 (installed && rootPath) 自动排除禁用项
    rootPath: enabled ? rootPath : undefined,
    enabled,
    // UI 段归一：缺省 chrome=default / themeAware=true / background=opaque / preferredColorScheme=auto
    ui: resolvePluginUi(manifest.ui),
    form: resolvePluginForm(manifest.form),
    ...extras
  }
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
  private dev = new Map<string, PluginSummary>()
  private devManifests = new Map<string, PluginManifest>()
  /** 远程 eNest_plugin 市场缓存；断网时沿用上次成功结果 */
  private remoteMarket: MarketPluginSummary[] = []
  private remoteFetchedAt = 0
  /** ensureInstalled 进行中的远程下载，避免并发重复拉同一插件 */
  private installing = new Map<string, Promise<PluginSummary>>()

/** 扫描 userData/plugins 下所有已安装插件，解析 manifest 并缓存到内存 */
  async scan(): Promise<void> {
    this.installed.clear()
    // 先加载禁用集合，保证 list/get 能立刻带上 enabled
    await loadDisabledIds()
    const root = pluginsRoot()
    if (!existsSync(root)) {
      void this.refreshRemoteMarket()
      return
    }
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

  getRemoteEntry(id: string): MarketPluginSummary | undefined {
    return this.remoteMarket.find((s) => s.id === id)
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
        enabled: isEnabledSync(remote.id),
        ui: remote.ui
      })
    }
    for (const mock of mockToSummary(false)) {
      if (!byId.has(mock.id)) byId.set(mock.id, mock)
    }
    for (const item of this.installed.values()) {
      const summary = manifestToSummary(item.manifest, item.rootPath)
      byId.set(item.manifest.id, withUpdateHint(summary, this.getRemoteEntry(item.manifest.id)))
    }
    for (const summary of this.dev.values()) {
      byId.set(summary.id, {
        ...summary,
        installed: true,
        enabled: isEnabledSync(summary.id)
      })
    }
    return [...byId.values()]
  }

  get(id: string): PluginSummary | null {
    const remote = this.getRemoteEntry(id)
    const dev = this.dev.get(id)
    if (dev) {
      return withUpdateHint({ ...dev, installed: true, enabled: isEnabledSync(id) }, remote)
    }
    const inst = this.installed.get(id)
    if (inst) {
      return withUpdateHint(manifestToSummary(inst.manifest, inst.rootPath), remote)
    }
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
        enabled: isEnabledSync(remote.id),
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
    logInfo('registry', `${id} ${enabled ? 'enabled' : 'disabled'}`)
    sendShellEvent({ type: 'plugins-changed' })
    const summary = this.get(id)
    if (!summary) throw new Error(`plugin not found: ${id}`)
    return summary
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
    onProgress?.(2, '下载安装包')
    const pkg = await downloadPluginPackage(remote.assetUrl, {
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
      })
      this.installed.set(result.manifest.id, {
        manifest: result.manifest,
        rootPath: result.dest,
        version: result.manifest.version || '0.0.0'
      })
      // 安装成功后清理同 id 下更旧的版本目录（保留刚写入的）
      await this.cleanupOldVersions(result.manifest.id, result.dest)
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
  addDevPlugin(summary: PluginSummary, manifest?: PluginManifest): void {
    this.dev.set(summary.id, summary)
    if (manifest) this.devManifests.set(summary.id, manifest)
  }

  removeDevPlugin(id: string): void {
    this.dev.delete(id)
    this.devManifests.delete(id)
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
      const short = shortNameOf(id)
      const sampleDir = join(samplesRoot(), short)
      if (existsSync(sampleDir)) {
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

/**
 * ContributionRegistry — 插件贡献点注册中心（插槽化架构核心）
 * 职责：统一管理插件的声明式贡献（settings/home-cards/rail-entries/theme-packs）
 *       与运行时贡献（Quick 搜索 provider），声明式贡献持久化到 enest.db
 *       contributions 表，重启后无需插件运行即可回显。
 * 存储：
 *  - contributions 表（node:sqlite，与 plugin_storage 同库）：
 *      contributions(source TEXT, slot TEXT, id TEXT, json TEXT,
 *                    PRIMARY KEY(source, slot, id))
 *  - Quick provider 运行时注册表（内存 Map；provider 是插件 webContents 内的
 *    异步入口，不可序列化，插件关闭即失效）。
 * 被 PluginRegistry.scan（manifest 声明入库）、pluginHandlers（contribute.* RPC）、
 *     PluginSettingsBridge（settings 插槽读）调用。
 * 【交接】卸载/禁用插件需主线程调用 unregisterBySource(pluginId)：
 *   - PluginUninstaller 卸载路径补一行 unregisterBySource(id)
 *   - shellHandlers.ShellSetPluginEnabled(false) 补一行 unregisterBySource(id)（禁用）
 *   - enable 时主线程应重放 registerManifestContributes(id, manifest.contributes)
 */
import type { DatabaseSync } from 'node:sqlite'
import type {
  ContributionSlot,
  HomeCardContribution,
  PluginContributes,
  QuickProviderContribution,
  RailEntryContribution,
  SettingsSectionContribution
} from '@shared/types/plugin'
import { CONTRIB_SCHEMA_VERSION } from '@shared/types/plugin'
import { kvStore, runInTransaction } from '@main/db/sqliteService'
import { logInfo, logWarn } from '@main/logs/logService'
import { sendShellEvent } from '@main/window/createShellWindow'
// 轨道贡献变更后即时刷新圆轨状态；与 orbRailViews→listRailEntries 构成运行时互调环
// （双方均仅在函数体内调用，无模块求值期依赖，ESM 下安全）
import { refreshOrbRailContribEntries } from '@main/window/orbRailViews'

/** 插槽 → manifest.contributes 字段映射（声明式贡献的唯一事实来源） */
const DECLARABLE_SLOTS: Record<ContributionSlot, keyof PluginContributes> = {
  settings: 'settings',
  'home-cards': 'homeCards',
  'rail-entries': 'railEntries',
  'theme-packs': 'themePacks'
}

interface ContribStatements {
  upsert: import('node:sqlite').StatementSync
  removeSource: import('node:sqlite').StatementSync
  selectSlot: import('node:sqlite').StatementSync
  selectSource: import('node:sqlite').StatementSync
}

let cachedStatements: { db: DatabaseSync; stmts: ContribStatements } | null = null
let initialized = false

function statementsFor(db: DatabaseSync): ContribStatements | null {
  if (cachedStatements && cachedStatements.db === db) return cachedStatements.stmts
  const stmts: ContribStatements = {
    upsert: db.prepare(
      'INSERT INTO contributions (source, slot, id, json) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(source, slot, id) DO UPDATE SET json = excluded.json'
    ),
    removeSource: db.prepare('DELETE FROM contributions WHERE source = ?'),
    selectSlot: db.prepare(
      'SELECT source, id, json FROM contributions WHERE slot = ? ORDER BY source, id'
    ),
    selectSource: db.prepare(
      'SELECT slot, id, json FROM contributions WHERE source = ? ORDER BY slot, id'
    )
  }
  cachedStatements = { db, stmts }
  return stmts
}

/** 建表（幂等）；由各注册入口惰性调用，库不可用时降级为仅内存 provider 表 */
function ensureInit(): boolean {
  if (initialized) return kvStore.getDatabase() !== null
  initialized = true
  const db = kvStore.getDatabase()
  if (!db) return false
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS contributions (' +
        'source TEXT NOT NULL, slot TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, ' +
        'PRIMARY KEY (source, slot, id))'
    )
    return true
  } catch (err) {
    logWarn('contrib', `init failed: ${(err as Error).message}`)
    return false
  }
}

interface ContribRow {
  source: string
  id: string
  json: string
}

/** 行 → SourcedContribution；json 损坏时跳过并告警 */
function rowToSourced<T>(row: { source: string; id: string; json: string }): {
  source: string
  id: string
  data: T
} | null {
  try {
    return { source: row.source, id: row.id, data: JSON.parse(row.json) as T }
  } catch {
    logWarn('contrib', `corrupt json skipped: ${row.source}/${row.id}`)
    return null
  }
}

/** 贡献声明版本检查：不匹配（且非缺省）拒绝注册 */
function versionOk(entry: { schemaVersion?: string } | undefined): boolean {
  if (entry?.schemaVersion === undefined) return true
  return entry.schemaVersion === CONTRIB_SCHEMA_VERSION
}

export class ContributionRegistry {
  /** 运行时 Quick provider 注册表：`${pluginId}:${providerId}` → meta */
  private quickProviders = new Map<string, QuickProviderContribution & { pluginId: string }>()

  /**
   * manifest.contributes 声明入库（Registry.scan 后调用）。
   * 每次调用先清掉该插件在全部声明式插槽的旧行（版本升级撤掉某插槽 / 同版本重扫幂等），
   * 再逐条 upsert；同 (slot,id) 后注册覆盖前者 + logWarn（多插件撞 id 时以最新为准）。
   */
  registerManifestContributes(pluginId: string, contributes?: PluginContributes): void {
    const db = kvStore.getDatabase()
    if (!ensureInit() || !db) {
      logWarn('contrib', `sqlite unavailable, skip manifest contributes for ${pluginId}`)
      return
    }
    const stmts = statementsFor(db)!
    const touched = new Set<ContributionSlot>()
    try {
      runInTransaction(db, () => {
        // 先全量清除该插件的声明式贡献（含此前存在、本次 manifest 已移除的插槽）
        const prev = stmts.selectSource.all(pluginId) as unknown as Array<{ slot: string }>
        for (const row of prev) touched.add(row.slot as ContributionSlot)
        stmts.removeSource.run(pluginId)
        if (!contributes || typeof contributes !== 'object') return
        for (const [slot, field] of Object.entries(DECLARABLE_SLOTS) as Array<
          [ContributionSlot, keyof PluginContributes]
        >) {
          const list = contributes[field]
          if (!Array.isArray(list) || list.length === 0) continue
          for (const raw of list) {
            const entry = raw as { id?: unknown; schemaVersion?: string }
            if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
              logWarn('contrib', `skip invalid ${slot} entry (missing id) from ${pluginId}`)
              continue
            }
            if (!versionOk(raw as { schemaVersion?: string })) {
              logWarn(
                'contrib',
                `skip ${slot}/${String(entry.id)} from ${pluginId}: schemaVersion mismatch ` +
                  `(want ${CONTRIB_SCHEMA_VERSION}, got ${String(entry.schemaVersion)})`
              )
              continue
            }
            // 同 (slot,id) 后注册覆盖前者：主键 upsert 天然覆盖（跨插件撞 id 以最新为准）
            stmts.upsert.run(pluginId, slot, entry.id, JSON.stringify(raw))
            touched.add(slot)
          }
        }
      })
    } catch (err) {
      logWarn('contrib', `registerManifestContributes failed for ${pluginId}: ${(err as Error).message}`)
      return
    }
    if (touched.size > 0) {
      logInfo('contrib', `manifest contributes registered: ${pluginId} → ${[...touched].join(', ')}`)
      for (const slot of touched) {
        sendShellEvent({ type: 'contributions-changed', slot, source: pluginId })
      }
      if (touched.has('rail-entries')) refreshOrbRailContribEntries()
    }
  }

  /** 卸载/禁用插件：清掉其全部声明式贡献 + 运行时 quick provider */
  unregisterBySource(pluginId: string): void {
    const db = kvStore.getDatabase()
    const slots = new Set<string>()
    if (db && ensureInit()) {
      const stmts = statementsFor(db)!
      try {
        const rows = stmts.selectSource.all(pluginId) as unknown as Array<{ slot: string }>
        for (const r of rows) slots.add(r.slot)
        stmts.removeSource.run(pluginId)
      } catch (err) {
        logWarn('contrib', `unregisterBySource failed for ${pluginId}: ${(err as Error).message}`)
      }
    }
    // 运行时 provider：清掉该插件全部
    for (const key of [...this.quickProviders.keys()]) {
      if (key.startsWith(`${pluginId}:`)) this.quickProviders.delete(key)
    }
    for (const slot of slots) {
      sendShellEvent({ type: 'contributions-changed', slot, source: pluginId })
    }
    if (slots.has('rail-entries')) refreshOrbRailContribEntries()
  }

  /** 读取某插槽全部贡献（含来源）；库不可用返回空 */
  listSlot<T = unknown>(slot: ContributionSlot): Array<{ source: string; id: string; data: T }> {
    const db = kvStore.getDatabase()
    if (!db || !ensureInit()) return []
    try {
      const rows = statementsFor(db)!.selectSlot.all(slot) as unknown as ContribRow[]
      return rows
        .map(rowToSourced<T>)
        .filter((x): x is { source: string; id: string; data: T } => x !== null)
    } catch (err) {
      logWarn('contrib', `listSlot(${slot}) failed: ${(err as Error).message}`)
      return []
    }
  }

  /** 读取某插件全部贡献（按插槽分组）；库不可用返回空对象 */
  listByPlugin(pluginId: string): Partial<Record<ContributionSlot, Array<{ id: string; data: unknown }>>> {
    const db = kvStore.getDatabase()
    if (!db || !ensureInit()) return {}
    const out: Partial<Record<ContributionSlot, Array<{ id: string; data: unknown }>>> = {}
    try {
      const rows = statementsFor(db)!.selectSource.all(pluginId) as unknown as Array<{
        slot: string
        id: string
        json: string
      }>
      for (const row of rows) {
        let parsed: unknown
        try {
          parsed = JSON.parse(row.json)
        } catch {
          logWarn('contrib', `corrupt json skipped: ${pluginId}/${row.id}`)
          continue
        }
        const slot = row.slot as ContributionSlot
        const list = out[slot] ?? []
        list.push({ id: row.id, data: parsed })
        out[slot] = list
      }
    } catch (err) {
      logWarn('contrib', `listByPlugin(${pluginId}) failed: ${(err as Error).message}`)
    }
    return out
  }

  // —— 运行时 Quick provider（内存，插件 webContents 关闭即失效）——

  /** 注册 Quick 搜索 provider（pluginHandlers contribute.registerQuickProvider 调用） */
  registerQuickProvider(
    pluginId: string,
    meta: QuickProviderContribution
  ): { ok: true } | { ok: false; error: string } {
    const id = String(meta?.id ?? '').trim()
    if (!id) return { ok: false, error: 'provider id required' }
    if (!versionOk(meta)) {
      return {
        ok: false,
        error: `schemaVersion mismatch (want ${CONTRIB_SCHEMA_VERSION})`
      }
    }
    const key = `${pluginId}:${id}`
    if (this.quickProviders.has(key)) {
      logWarn('contrib', `quick provider overwritten: ${key}`)
    }
    this.quickProviders.set(key, { ...meta, id, pluginId })
    return { ok: true }
  }

  /** 注销单个 provider（插件主动 unregister / 关闭清理） */
  unregisterQuickProvider(pluginId: string, providerId: string): boolean {
    return this.quickProviders.delete(`${pluginId}:${providerId}`)
  }

  /** 全部运行时 provider（搜索管线消费；pluginId 供 quick-query 路由） */
  getQuickProviders(): Array<QuickProviderContribution & { pluginId: string }> {
    return [...this.quickProviders.values()]
  }
}

export const contributionRegistry = new ContributionRegistry()

// —— 便捷读取（渲染层消费经 IPC，主进程内部直接调用）——

/** 读取 home-cards 插槽（MarketPage 首页「插件扩展」区块） */
export function listHomeCards(): Array<{
  source: string
  id: string
  data: HomeCardContribution
}> {
  return contributionRegistry.listSlot<HomeCardContribution>('home-cards')
}

/** 读取 rail-entries 插槽（orb 模式左侧轨道；渲染消费见交接说明） */
export function listRailEntries(): Array<{
  source: string
  id: string
  data: RailEntryContribution
}> {
  return contributionRegistry.listSlot<RailEntryContribution>('rail-entries')
}

/** 读取 settings 插槽（PluginSettingsBridge.listAll 合并持久化声明） */
export function listSettingsContributions(): Array<{
  source: string
  id: string
  data: SettingsSectionContribution
}> {
  return contributionRegistry.listSlot<SettingsSectionContribution>('settings')
}

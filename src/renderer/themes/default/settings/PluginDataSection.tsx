import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@renderer/hooks/useI18n'
import { Button } from '@renderer/components/ui/Button'
import { confirmAction } from '@renderer/services/confirmAction'
import { notify } from '@renderer/services/notifyService'
import { isMockShell, shellApi } from '@renderer/services/shellApi'
import { useShellStore } from '@renderer/stores/shellStore'
import { formatBytes } from '@shared/formatBytes'
import type { PluginDataUsage, PluginDataUsageItem } from '@shared/types/plugin'
import { SettingsPluginRow } from './SettingsPluginRow'
import './pluginData.css'

/** 四类的固定顺序与配色键；data/images/files/other 与主进程 DTO 一一对应 */
const CATEGORIES = ['data', 'images', 'files', 'other'] as const

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 设置 → 插件数据。占用统计与清理都在主进程完成，这里只负责展示与确认。
 * 不做轮询：进入页面、插件装/卸载、清理完成后各拉一次。
 */
export function PluginDataSection() {
  const { t, locale } = useI18n()
  const plugins = useShellStore((s) => s.plugins)
  const [usage, setUsage] = useState<PluginDataUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const request = useRef(0)

  const size = useCallback((bytes: number) => formatBytes(bytes, locale), [locale])
  const nameOf = useCallback((pluginId: string) => plugins.find(p => p.id === pluginId)?.name ?? pluginId, [plugins])

  const refresh = useCallback(async () => {
    const version = ++request.current
    if (!shellApi.getPluginDataUsage) { setLoading(false); return }
    try {
      const next = await shellApi.getPluginDataUsage()
      if (version !== request.current) return
      setUsage(next)
      setError(null)
    } catch (err) {
      if (version !== request.current) return
      setError(errorMessage(err))
    } finally {
      if (version === request.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void refresh()
    // 装/卸载、清理完成都会发 plugins-changed；换数据根后整页重扫。不轮询。
    const off = shellApi.onEvent?.(event => {
      if (event.type === 'plugins-changed' || event.type === 'settings-changed' && event.generalKeys.includes('dataRoot')) void refresh()
    })
    return off
  }, [refresh])

  const summary = useMemo(() => {
    const items = usage?.plugins ?? []
    const data = items.reduce((sum, item) => sum + item.data.bytes, 0)
    const images = items.reduce((sum, item) => sum + item.images.bytes, 0)
    const files = items.reduce((sum, item) => sum + item.files.bytes, 0)
    const other = items.reduce((sum, item) => sum + item.other.bytes, 0)
    const orphanBytes = (usage?.orphans ?? []).reduce((sum, item) => sum + item.bytes, 0)
    return { data, images, files, other, orphanBytes, total: data + images + files + other + orphanBytes }
  }, [usage])

  const ranked = useMemo(() => [...(usage?.plugins ?? [])].sort((a, b) => b.total - a.total), [usage])
  // 堆叠条只画有占用的插件；占比太小的段合并成「其他」，避免几十个 1px 碎段
  const bars = useMemo(() => {
    const nonzero = ranked.filter(item => item.total > 0)
    if (!nonzero.length) return []
    const keep = nonzero.filter(item => item.total / summary.total >= 0.02)
    const rest = nonzero.filter(item => item.total / summary.total < 0.02)
    return [...keep.map(item => ({ key: item.pluginId, name: nameOf(item.pluginId), bytes: item.total, color: 'plugin' })),
      ...(rest.length ? [{ key: '__rest', name: t('settings.pluginData.categoryOther'), bytes: rest.reduce((s, i) => s + i.total, 0), color: 'rest' as const }] : [])]
  }, [ranked, summary.total, nameOf, t])

  const clearOne = async (item: PluginDataUsageItem) => {
    if (!shellApi.clearPluginData || busyId) return
    const name = nameOf(item.pluginId)
    const releasable = item.total - item.packageBytes
    const ok = await confirmAction({
      title: t('settings.pluginData.clearOneConfirm'),
      message: t('settings.pluginData.clearOneConfirmMessage', { name, size: size(releasable) }),
      confirmLabel: t('settings.pluginData.clearOne'),
      danger: true,
    })
    if (!ok) return
    setBusyId(item.pluginId)
    try {
      const result = await shellApi.clearPluginData(item.pluginId)
      if (result.ok) notify.success(t('settings.pluginData.clearDoneOne', { name, size: size(result.releasedBytes) }))
      else notify.error(t('settings.pluginData.clearFailed', { error: result.failed[item.pluginId] ?? '' }))
      await refresh()
    } catch (err) {
      notify.error(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  const clearAll = async () => {
    if (!shellApi.clearPluginData || busyId) return
    const withData = (usage?.plugins ?? []).filter(item => item.total - item.packageBytes > 0)
    const ok = await confirmAction({
      title: t('settings.pluginData.clearAllConfirm'),
      message: t('settings.pluginData.clearAllConfirmMessage', { count: withData.length }),
      confirmLabel: t('settings.pluginData.clearAll'),
      danger: true,
    })
    if (!ok) return
    setBusyId('*')
    try {
      const result = await shellApi.clearPluginData()
      const failed = Object.keys(result.failed).length
      if (result.cleared > 0) notify.success(t('settings.pluginData.clearDone', { count: result.cleared, size: size(result.releasedBytes) }))
      if (failed > 0) notify.warn(t('settings.pluginData.clearPartial', { failed }))
      if (result.cleared === 0 && failed > 0) notify.error(t('settings.pluginData.clearFailed', { error: Object.values(result.failed)[0] ?? '' }))
      await refresh()
    } catch (err) {
      notify.error(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  const clearOrphans = async () => {
    if (!shellApi.clearOrphanData || busyId) return
    const orphans = usage?.orphans ?? []
    const ok = await confirmAction({
      title: t('settings.pluginData.clearOrphansConfirm'),
      message: t('settings.pluginData.clearOrphansConfirmMessage', { count: orphans.length, size: size(summary.orphanBytes) }),
      confirmLabel: t('settings.pluginData.clearOrphans'),
      danger: true,
    })
    if (!ok) return
    setBusyId('orphans')
    try {
      const result = await shellApi.clearOrphanData()
      if (result.ok) notify.success(t('settings.pluginData.clearDone', { count: result.removed, size: size(summary.orphanBytes) }))
      else notify.error(t('settings.pluginData.clearFailed', { error: result.failed[0] ?? '' }))
      await refresh()
    } catch (err) {
      notify.error(errorMessage(err))
    } finally {
      setBusyId(null)
    }
  }

  const orphans = usage?.orphans ?? []
  const hasAnyData = summary.total > 0
  const disabled = loading || busyId !== null

  return (
    <section className="s-card plugin-data-section" aria-labelledby="plugin-data-title">
      <h2 id="plugin-data-title">{t('settings.pluginData.title')}</h2>
      <p className="hint">{t('settings.pluginData.hint')}</p>

      {isMockShell ? (
        <p className="plugin-data-message" role="status">{t('settings.pluginData.browserPreview')}</p>
      ) : error && !usage ? (
        <div className="plugin-data-error" role="alert">
          <span>{t('settings.pluginData.clearFailed', { error })}</span>
          <Button variant="ghost" size="sm" onClick={() => { setLoading(true); void refresh() }}>{t('settings.pluginData.retry')}</Button>
        </div>
      ) : (
        <>
          <dl className="plugin-data-summary">
            <div>
              <dt>{t('settings.pluginData.total')}</dt>
              <dd>{loading && !usage ? t('settings.pluginData.loading') : size(summary.total)}</dd>
            </div>
            {([
              ['data', 'categoryData'], ['images', 'categoryImages'], ['files', 'categoryFiles'], ['other', 'categoryOther'],
            ] as const).map(([key, label]) => (
              <div key={key}>
                <dt><i className={`plugin-data-swatch is-${key}`} aria-hidden="true" />{t(`settings.pluginData.${label}`)}</dt>
                <dd>{size(summary[key])}</dd>
              </div>
            ))}
          </dl>

          {hasAnyData && (
            <div className={`plugin-data-bar${loading ? ' is-refreshing' : ''}`} aria-hidden="true">
              {bars.map(bar => (
                <span key={bar.key} className={`plugin-data-bar-seg is-${bar.color}`} style={{ flexGrow: bar.bytes }} title={`${bar.name} · ${size(bar.bytes)}`} />
              ))}
              {summary.orphanBytes > 0 && <span className="plugin-data-bar-seg is-orphan" style={{ flexGrow: summary.orphanBytes }} title={`${t('settings.pluginData.orphans')} · ${size(summary.orphanBytes)}`} />}
            </div>
          )}

          <div className="plugin-data-toolbar">
            <span className="desc">
              {usage?.unreadable.length ? t('settings.pluginData.readFailed')
                : usage ? t('settings.pluginData.scannedAt', { time: new Date(usage.scannedAt).toLocaleTimeString(locale) }) : ''}
            </span>
            <div className="plugin-data-toolbar-actions">
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { setLoading(true); void refresh() }}>{t('settings.pluginData.refresh')}</Button>
              <Button variant="danger" size="sm" disabled={disabled || !hasAnyData} onClick={() => void clearAll()}>{t('settings.pluginData.clearAll')}</Button>
            </div>
          </div>

          {!loading && ranked.length === 0 ? (
            <p className="plugin-data-message" role="status">{t('settings.pluginData.noPlugins')}</p>
          ) : !loading && !hasAnyData ? (
            <p className="plugin-data-message" role="status">{t('settings.pluginData.empty')}</p>
          ) : (
            <ul className="dev-plugin-list plugin-data-list" data-scrollbar="auto-hide" aria-busy={loading}>
              {ranked.map(item => {
                const summaryOf = plugins.find(p => p.id === item.pluginId)
                const releasable = item.total - item.packageBytes
                return (
                  <SettingsPluginRow key={item.pluginId} as="li" plugin={summaryOf ?? { id: item.pluginId, name: item.pluginId }} detail={item.pluginId}
                    running={item.running} badges={item.running && <span className="tag">{t('settings.pluginData.clearRunning')}</span>}>
                    <span className="plugin-data-row-total">{size(item.total)}</span>
                    <Button variant="danger" size="sm" disabled={disabled || releasable <= 0} aria-busy={busyId === item.pluginId} onClick={() => void clearOne(item)}>
                      {busyId === item.pluginId ? t('common.loading') : t('settings.pluginData.clearOne')}
                    </Button>
                    <div className="plugin-data-row-details">
                      <div className="plugin-data-row-bar" aria-hidden="true">
                        {CATEGORIES.map(key => item[key].bytes > 0 && (
                          <span key={key} className={`plugin-data-bar-seg is-${key}`} style={{ flexGrow: item[key].bytes }} />
                        ))}
                      </div>
                      <div className="plugin-data-row-breakdown">
                        {CATEGORIES.map(key => (
                          <span key={key} className="plugin-data-cell" data-empty={item[key].bytes === 0 || undefined}>
                            <i className={`plugin-data-swatch is-${key}`} aria-hidden="true" />
                            {t(`settings.pluginData.category${key[0].toUpperCase()}${key.slice(1)}`)}
                            <b>{size(item[key].bytes)}</b>
                            {item[key].count > 0 && key !== 'other' && <em>{item[key].count}</em>}
                          </span>
                        ))}
                      </div>
                      {item.packageBytes > 0 && (
                        <p className="plugin-data-row-note">{t('settings.pluginData.packageNote', { size: size(item.packageBytes) })}</p>
                      )}
                    </div>
                  </SettingsPluginRow>
                )
              })}
            </ul>
          )}

          {orphans.length > 0 && (
            <div className="plugin-data-orphans">
              <div className="plugin-data-orphans-head">
                <div>
                  <h3>{t('settings.pluginData.orphans')} <span className="plugin-data-badge">{size(summary.orphanBytes)}</span></h3>
                  <p className="desc">{t('settings.pluginData.orphansHint')}</p>
                </div>
                <Button variant="danger" size="sm" disabled={disabled} onClick={() => void clearOrphans()}>
                  {t('settings.pluginData.clearOrphans')}
                </Button>
              </div>
              <ul className="plugin-data-orphan-list" data-scrollbar="auto-hide">
                {orphans.map(orphan => (
                  <li key={orphan.relativePath}><code>{orphan.relativePath}</code><span>{size(orphan.bytes)}</span></li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}

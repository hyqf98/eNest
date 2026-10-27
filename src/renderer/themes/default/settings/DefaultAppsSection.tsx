/**
 * DefaultAppsSection — 设置 → 通用里的「打开方式」管理
 * 职责：聚合所有插件 openWith 声明，统一展示「类型 → 插件 → 系统状态」，
 * 提供设为默认 / 移除 / 打开系统设置；状态与平台能力如实呈现（受限平台引导）。
 * 模块隔离：只经 shellApi.openWith 通道，不触碰主进程内部状态。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { OpenWithListResult, OpenWithRow } from '@shared/types/openWith'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { Button } from '@renderer/components/ui/Button'

const statusLabel = (row: OpenWithRow, packaged: boolean): string => {
  if (!packaged) return '仅安装版可验证'
  switch (row.status) {
    case 'default': return '系统默认'
    case 'candidate': return '已注册候选'
    case 'unregistered': return '未注册'
    default: return '状态未知'
  }
}

const statusTone = (row: OpenWithRow): 'ok' | 'warn' | 'muted' => {
  if (row.status === 'default') return 'ok'
  if (row.status === 'unregistered') return 'muted'
  return 'warn'
}

export function DefaultAppsSection() {
  const [data, setData] = useState<OpenWithListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!shellApi.getOpenWithList) return
    try {
      const list = await shellApi.getOpenWithList()
      setData(list)
    } catch {
      /* 读取失败保持当前值 */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = shellApi.onEvent?.(payload => {
      if (payload.type === 'contributions-changed' && payload.slot === 'open-with') void refresh()
      if (payload.type === 'plugins-changed') void refresh()
    })
    return () => off?.()
  }, [refresh])

  const extRows = useMemo(() => data?.rows.filter(r => r.kind === 'ext') ?? [], [data])
  const schemeRows = useMemo(() => data?.rows.filter(r => r.kind === 'scheme') ?? [], [data])

  const setDefault = useCallback(async (key: string, pluginId: string) => {
    if (busyKey || !shellApi.setOpenWithDefault) return
    setBusyKey(key)
    try {
      const result = await shellApi.setOpenWithDefault(key, pluginId)
      if (result.ok && result.hint) notify.info(result.hint)
      else if (result.ok) notify.success('已设为默认打开方式')
      else notify.error(result.error ?? '设置失败')
      await refresh()
    } catch (error) {
      notify.error(error instanceof Error ? error.message : '设置失败')
    } finally {
      setBusyKey(null)
    }
  }, [busyKey, refresh])

  const clearRoute = useCallback(async (key: string) => {
    if (busyKey || !shellApi.clearOpenWithDefault) return
    setBusyKey(key)
    try {
      const result = await shellApi.clearOpenWithDefault(key)
      if (!result.ok) notify.error(result.error ?? '移除失败')
      await refresh()
    } finally {
      setBusyKey(null)
    }
  }, [busyKey, refresh])

  const openSystemSettings = useCallback(async () => {
    try { await shellApi.openOpenWithSystemSettings?.() } catch { /* 引导失败不打断 */ }
  }, [])

  const renderRow = (row: OpenWithRow): ReactNode => {
    const enabledProviders = row.providers.filter(p => p.enabled)
    const current = enabledProviders.find(p => p.routed)
    return (
      <div className="field" key={row.key}>
        <div>
          <div className="label">
            {row.kind === 'ext' ? `.${row.value}` : `${row.value}://`}
            <span className={`open-with-chip open-with-chip--${statusTone(row)}`}>
              {statusLabel(row, !!data?.packaged)}
            </span>
          </div>
          <p className="desc">
            {current ? `当前用 ${current.pluginName} 打开` : `${enabledProviders.length} 个插件声明可处理`}
            {row.caps.needsSystemSettings && row.kind === 'ext' && '（本平台需在系统设置完成最后一步）'}
          </p>
        </div>
        <div className="open-with-actions">
          {!current && enabledProviders.map(provider => (
            <Button
              key={provider.pluginId}
              size="sm"
              variant={enabledProviders.length === 1 ? 'primary' : 'ghost'}
              disabled={!!busyKey}
              onClick={() => void setDefault(row.key, provider.pluginId)}
            >
              用 {provider.pluginName}
            </Button>
          ))}
          {current && (
            <Button size="sm" variant="ghost" disabled={!!busyKey} onClick={() => void clearRoute(row.key)}>
              移除
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <section className="s-card" aria-label="打开方式">
      <h2>
        打开方式
        <Button size="sm" variant="ghost" className="open-with-system-btn" onClick={() => void openSystemSettings()}>
          系统默认应用设置
        </Button>
      </h2>
      {loading ? (
        <p className="desc" role="status">正在读取…</p>
      ) : !data?.rows.length ? (
        <p className="desc">暂无插件声明可打开的文件类型或协议。安装并启用 markdown / database 等插件后，这里会出现对应条目。</p>
      ) : (
        <>
          {extRows.map(renderRow)}
          {schemeRows.map(renderRow)}
        </>
      )}
    </section>
  )
}

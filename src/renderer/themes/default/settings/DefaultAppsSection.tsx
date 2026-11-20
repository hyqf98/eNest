import { useCallback, useEffect, useRef, useState } from 'react'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { Button } from '@renderer/components/ui/Button'
import { Select } from '@renderer/components/ui/Select'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'
import type { OpenWithActionResult, OpenWithKey, OpenWithListResult, OpenWithRow } from '@shared/types/openWith'
import { Card, Field } from './SettingsFields'

const copy = 'settings.openWith.'
const unassigned = 'unassigned'
const pluginValue = (id: string) => `plugin:${id}`
const typeLabel = (row: OpenWithRow) => row.kind === 'ext' ? `.${row.value}` : `${row.value}://`
const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : ''
const resultDetail = (result?: OpenWithActionResult) => [result?.error, result?.hint].filter(Boolean).join(' ')

type SystemAction = 'requestDefault' | 'windowsSettings' | 'registerWindows'
type Operation = 'route' | 'system'
interface Notice { message: string; detail?: string; error?: boolean }

function systemStep(data: OpenWithListResult, row: OpenWithRow): { guide: string; action?: SystemAction } {
  if (!data.packaged) return { guide: 'development' }
  if (row.status === 'default') return { guide: 'alreadyDefault' }
  const { canSetDefault, needsSystemSettings } = row.caps
  if (!canSetDefault && !needsSystemSettings) return { guide: 'unsupported' }
  const request = canSetDefault ? 'requestDefault' : undefined
  switch (data.platform) {
    case 'win32':
      if (!needsSystemSettings) return { guide: 'windowsGuide', action: request }
      return row.status === 'candidate'
        ? { guide: 'windowsGuide', action: 'windowsSettings' }
        : { guide: 'windowsRegisterGuide', action: 'registerWindows' }
    case 'darwin':
      return { guide: row.kind === 'ext' ? 'finderGuide' : canSetDefault ? 'macLinkGuide' : 'macLinkManual', action: request }
    case 'linux':
      return { guide: !canSetDefault ? 'linuxManual' : row.kind === 'ext' ? 'linuxFileGuide' : 'linuxLinkGuide', action: request }
    default:
      return { guide: 'unsupported' }
  }
}

export function DefaultAppsSection() {
  const { t } = useI18n()
  const [data, setData] = useState<OpenWithListResult | null>(null)
  const [selectedKey, setSelectedKey] = useState<OpenWithKey>()
  const [reading, setReading] = useState(true)
  const [readError, setReadError] = useState<string | null>(null)
  const [pending, setPending] = useState<Operation | null>(null)
  const [notice, setNotice] = useState<(Notice & { key: OpenWithKey; operation: Operation }) | null>(null)
  const selectedKeyRef = useRef<OpenWithKey | undefined>(undefined)
  const revision = useRef(0)
  const mounted = useRef(false)
  const locked = useRef(false)

  const refresh = useCallback(async (key = selectedKeyRef.current) => {
    const current = ++revision.current
    setReading(true)
    setReadError(null)
    try {
      const list = await shellApi.getOpenWithList?.(key)
      if (revision.current !== current) return
      if (!list) { setReadError(''); return }
      const nextKey = list.rows.find(row => row.key === key)?.key
        ?? list.rows.find(row => row.key === list.inspectedKey)?.key ?? list.rows[0]?.key
      selectedKeyRef.current = nextKey
      setSelectedKey(nextKey)
      setData(list)
    } catch (error) {
      if (revision.current === current) setReadError(errorText(error))
    } finally {
      if (revision.current === current) setReading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    const off = shellApi.onEvent?.(event => {
      if (event.type === 'plugins-changed' || (event.type === 'contributions-changed' && event.slot === 'open-with')) void refresh()
    })
    return () => {
      mounted.current = false
      revision.current++
      window.removeEventListener('focus', onFocus)
      off?.()
    }
  }, [refresh])

  const row = data?.rows.find(item => item.key === selectedKey)
  const enabled = row?.providers.filter(provider => provider.enabled) ?? []
  const saved = row?.providers.find(provider => provider.pluginId === row.routedPluginId)
  const step = data && row && !reading && readError === null && row.key === data.inspectedKey ? systemStep(data, row) : undefined
  const systemAction = step?.action
  const needsRoute = !!systemAction && systemAction !== 'windowsSettings' && !saved?.enabled
  const options = [
    { value: unassigned, label: t(copy + 'unassigned') },
    ...enabled.map(provider => ({ value: pluginValue(provider.pluginId), label: provider.pluginName }))
  ]
  const pluginOptions = row?.routedPluginId && !saved?.enabled
    ? [...options, { value: pluginValue(row.routedPluginId), label: t(copy + 'unavailablePlugin', { name: saved?.pluginName ?? row.routedPluginId }), disabled: true }]
    : options

  function chooseType(key: OpenWithKey) {
    selectedKeyRef.current = key
    setSelectedKey(key)
    setNotice(null)
    void refresh(key)
  }

  async function perform(key: OpenWithKey, operation: Operation, work: () => Promise<Notice>) {
    if (locked.current) return
    locked.current = true
    setPending(operation)
    setNotice(null)
    try {
      const result = await work()
      if (mounted.current) setNotice({ ...result, key, operation })
    } catch (error) {
      if (mounted.current) setNotice({ key, operation, message: operation === 'route' ? 'routeFailed' : 'systemUnconfirmed', detail: errorText(error), error: true })
    } finally {
      if (mounted.current) await refresh()
      locked.current = false
      if (mounted.current) setPending(null)
    }
  }

  function choosePlugin(value: string) {
    if (!row) return
    const target = enabled.find(provider => pluginValue(provider.pluginId) === value)
    if ((!target && value !== unassigned) || target?.pluginId === row.routedPluginId) return
    void perform(row.key, 'route', async () => {
      const result = target ? await shellApi.routeOpenWith?.(row.key, target.pluginId) : await shellApi.clearOpenWithDefault?.(row.key)
      return result?.ok ? { message: target ? 'routeSaved' : 'routeCleared' }
        : { message: 'routeFailed', detail: resultDetail(result), error: true }
    })
  }

  function changeSystem() {
    if (!row || !systemAction || !enabled.length || needsRoute) return
    void perform(row.key, 'system', async () => {
      let result: OpenWithActionResult | undefined
      if (systemAction !== 'windowsSettings') {
        if (!saved?.enabled) return { message: 'chooseFirst' }
        result = await shellApi.setOpenWithDefault?.(row.key, saved.pluginId)
        if (!result?.ok) return { message: 'systemUnconfirmed', detail: resultDetail(result) }
        if (systemAction === 'requestDefault' || result.status === 'default') return { message: 'submitted', detail: result.hint }
      }
      try {
        if (!mounted.current || !shellApi.openOpenWithSystemSettings) return { message: 'settingsFailed', detail: result?.hint, error: true }
        await shellApi.openOpenWithSystemSettings()
        return { message: 'windowsPending', detail: result?.hint }
      } catch (error) {
        return { message: 'settingsFailed', detail: [result?.hint, errorText(error)].filter(Boolean).join(' '), error: true }
      }
    })
  }

  return (
    <Card className="open-with-section" title={t(copy + 'title')} hint={t(copy + 'intro')}>
      {!data ? (reading && <p className="desc" role="status">{t('common.loading')}</p>)
        : !row ? (readError === null && <p className="desc" role="status">{t(copy + 'empty')}</p>) : (
          <>
            <Field label={t(copy + 'type')}>
              {data.rows.length === 1 ? <code className="open-with-type">{typeLabel(row)}</code> : (
                <Select value={row.key} options={data.rows.map(item => ({ value: item.key, label: typeLabel(item) }))}
                  ariaLabel={t(copy + 'type')} disabled={!!pending} onChange={chooseType} />
              )}
            </Field>
            <Field label={t(copy + 'plugin')} desc={t(copy + (enabled.length ? 'pluginHint' : 'noPluginsHint'))}>
              {enabled.length || row.routedPluginId ? (
                <div className="open-with-plugin">
                  {saved?.enabled && <PluginIcon slot="tab" size={24} src={saved.icon} glyph={saved.glyph || Array.from(saved.pluginName)[0] || '?'} style={saved.color ? { background: saved.color } : undefined} />}
                  <Select value={row.routedPluginId ? pluginValue(row.routedPluginId) : unassigned} options={pluginOptions}
                    ariaLabel={t(copy + 'pluginFor', { type: typeLabel(row) })} disabled={!!pending} onChange={choosePlugin} />
                </div>
              ) : <span className="desc">{t(copy + 'noPlugins')}</span>}
            </Field>
            <div className="open-with-system">
              <div>
                <div className="open-with-system-title">
                  <h3>{t(copy + 'system')}</h3>
                  {step && data.packaged && <span className="open-with-status" data-status={row.status}>{t(copy + 'status.' + (row.status ?? 'unknown'))}</span>}
                </div>
                {step ? <p className="desc">{t(copy + step.guide)} {needsRoute && enabled.length > 0 && t(copy + 'chooseFirst')}</p>
                  : readError === null && <p className="desc" role="status">{t(copy + (reading ? 'inspecting' : 'notInspected'))}</p>}
              </div>
              {systemAction && !needsRoute && enabled.length > 0 && (
                <Button variant="ghost" size="sm" disabled={!!pending} onClick={changeSystem}>{t(copy + systemAction)}</Button>
              )}
            </div>
          </>
        )}
      {readError !== null && (
        <div className="open-with-read-error">
          <p className="desc open-with-error" role="alert">{t(copy + (row ? 'inspectFailed' : 'readFailed'))} {readError}</p>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>{t(copy + 'retry')}</Button>
        </div>
      )}
      {pending ? <p className="desc open-with-feedback" role="status">{t(copy + (pending === 'route' ? 'saving' : 'requesting'))}</p>
        : notice && notice.key === selectedKey && (notice.operation !== 'system' || (data?.inspectedKey === notice.key && row?.status !== 'default')) && (
          <p className={'desc open-with-feedback' + (notice.error ? ' open-with-error' : '')} role={notice.error ? 'alert' : 'status'}>
            {t(copy + notice.message)} {notice.detail}
          </p>
        )}
    </Card>
  )
}

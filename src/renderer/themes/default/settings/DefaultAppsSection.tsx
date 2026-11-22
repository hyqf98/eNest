/**
 * DefaultAppsSection — 设置里的「默认打开方式」管理
 *
 * 呈现：一张映射列表，每行是「类型（.ext / scheme://）→ 关联插件」。
 *  - 关联插件就是声明了该类型的插件（manifest.contributes.openWith），同一类型可关联多个；
 *  - 标「默认」的那个负责实际打开，落库为设置段 openWith 的路由（routeOpenWith）；
 *  - 行尾 × 移除整条映射；标题右侧 + 新增草稿行，齿轮图标进系统默认应用设置。
 *  - 每行点开「系统默认」可对该类型做检测/一键申请（getOpenWithList(key) 单类型探测）。
 *
 * 新增：草稿行里选插件已声明的类型（或自定义输入扩展名 / 协议名）→ 勾选要关联的插件 →
 * 指定默认 → 保存。没有插件声明的类型无法保存，避免产生悬空路由。
 * 模块隔离：只经 shellApi 的 open-with 通道，不触碰主进程内部状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  OPEN_WITH_EXT_RE,
  OPEN_WITH_SCHEME_RE,
  RESERVED_OPEN_WITH_SCHEMES,
  type OpenWithActionResult,
  type OpenWithKey,
  type OpenWithListResult,
  type OpenWithRow
} from '@shared/types/openWith'
import { shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { Button } from '@renderer/components/ui/Button'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { Input } from '@renderer/components/ui/Input'
import { Select } from '@renderer/components/ui/Select'
import { PluginIcon } from '@renderer/components/PluginIcon'
import { Card } from './SettingsFields'
import { SettingsIcon, XIcon } from '@renderer/components/icons'
import { useI18n } from '@renderer/hooks/useI18n'

type OpenWithProvider = OpenWithRow['providers'][number]
type OpenWithKind = 'ext' | 'scheme'

const copy = 'settings.openWith.'

/** 保存结果：失败原因留在草稿行内展示，不走全局通知 */
interface SaveOutcome {
  ok: boolean
  error?: string
}

const statusLabel = (row: OpenWithRow, packaged: boolean, t: (k: string) => string): string => {
  if (!packaged) return t(copy + 'devOnly')
  switch (row.status) {
    case 'default': return t(copy + 'status.default')
    case 'candidate': return t(copy + 'status.candidate')
    case 'unregistered': return t(copy + 'status.unregistered')
    default: return t(copy + 'status.unknown')
  }
}

const statusTone = (row: OpenWithRow): 'ok' | 'warn' | 'muted' => {
  if (row.status === 'default') return 'ok'
  if (row.status === 'unregistered') return 'muted'
  return 'warn'
}

const formatType = (kind: OpenWithKind, value: string): string =>
  kind === 'ext' ? `.${value}` : `${value}://`

const pluginGlyph = (provider: OpenWithProvider): string =>
  provider.glyph ?? Array.from(provider.pluginName)[0] ?? '?'

/** 归一化用户输入：扩展名去点、协议名去 `://`，统一小写 */
function normalizeTypeValue(kind: OpenWithKind, raw: string): string {
  const value = raw.trim().toLowerCase()
  return kind === 'ext' ? value.replace(/^\.+/, '') : value.replace(/:\/\/$/, '')
}

function shapeErrorOf(kind: OpenWithKind, value: string, t: (k: string, v?: Record<string, string>) => string): string | null {
  if (!value) return null
  if (kind === 'ext') {
    return OPEN_WITH_EXT_RE.test(value) ? null : t(copy + 'shapeExt')
  }
  if ((RESERVED_OPEN_WITH_SCHEMES as readonly string[]).includes(value)) {
    return t(copy + 'shapeReserved', { value })
  }
  return OPEN_WITH_SCHEME_RE.test(value) ? null : t(copy + 'shapeScheme')
}

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

/**
 * 关联插件列表：声明了该类型的插件全部列出（同一类型可关联多个）。
 * selectable 时显示勾选框（草稿行用于挑出要保留的关联）；否则只展示并可切换默认。
 * 默认项标「默认」且不可取消勾选，避免出现没有默认的关联集合。
 */
function ProviderList({ providers, defaultId, selected, disabled, selectable = false, onToggle, onSetDefault, labels }: {
  providers: OpenWithProvider[]
  defaultId?: string
  selected?: string[]
  disabled: boolean
  selectable?: boolean
  onToggle?: (pluginId: string) => void
  onSetDefault: (pluginId: string) => void
  labels: { setDefault: string; isDefault: string; off: string; toggleFirst: string; associate: string; list: string }
}) {
  return (
    <ul className="open-with-providers" aria-label={labels.list}>
      {providers.map(provider => {
        const isDefault = provider.pluginId === defaultId
        const checked = !selectable || (selected ?? []).includes(provider.pluginId)
        return (
          <li
            key={provider.pluginId}
            className={`open-with-provider${isDefault ? ' is-default' : ''}${provider.enabled ? '' : ' is-off'}`}
          >
            {selectable && (
              <Checkbox
                checked={checked}
                disabled={disabled || !provider.enabled || isDefault}
                title={isDefault ? labels.toggleFirst : undefined}
                aria-label={`${labels.associate} ${provider.pluginName}`}
                onCheckedChange={() => onToggle?.(provider.pluginId)}
              />
            )}
            <PluginIcon
              slot="tab"
              size={18}
              src={provider.icon}
              glyph={pluginGlyph(provider)}
              style={provider.color ? { background: provider.color } : undefined}
            />
            <span className="open-with-provider-name" title={provider.pluginName}>{provider.pluginName}</span>
            {isDefault ? (
              <span className="open-with-primary">{labels.isDefault}</span>
            ) : !provider.enabled ? (
              <span className="open-with-provider-note">{labels.off}</span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="open-with-default-btn"
                disabled={disabled}
                aria-label={`${labels.setDefault} ${provider.pluginName}`}
                onClick={() => onSetDefault(provider.pluginId)}
              >
                {labels.setDefault}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** 已保存的映射行：展示全部声明插件 + 行内系统默认状态/操作 */
function MappedRow({ row, list, busy, selected, onToggle, onSetDefault, onRemove, onInspect }: {
  row: OpenWithRow
  list: OpenWithListResult
  busy: boolean
  selected: string[]
  onToggle: (pluginId: string) => void
  onSetDefault: (pluginId: string) => void
  onRemove: () => void
  onInspect: () => void
}) {
  const { t } = useI18n()
  const current = row.providers.find(provider => provider.routed)
  const enabledCount = row.providers.filter(provider => provider.enabled).length
  const label = formatType(row.kind, row.value)
  const inspected = list.inspectedKey === row.key
  const desc = [
    current ? t(copy + 'currentOpens', { name: current.pluginName }) : t(copy + 'noDefaultYet'),
    t(copy + 'pluginsCanHandle', { count: String(enabledCount) }),
  ].join(' · ')

  return (
    <li className="open-with-row">
      <div className="open-with-row-body open-with-row-body--oneline" role="group" aria-label={`${label} ${t(copy + 'title')}`}>
        <div className="open-with-type-cell">
          <div className="open-with-type-line">
            <span className="open-with-type">{label}</span>
            <button type="button" className={`open-with-chip open-with-chip--${statusTone(row)}`} onClick={onInspect} title={t(copy + 'inspect')}>
              {inspected || !list.packaged ? statusLabel(row, list.packaged, t) : t(copy + 'inspect')}
            </button>
          </div>
          <p className="open-with-row-desc">{desc}</p>
        </div>
        <div className="open-with-provider-cell">
          <ProviderList
            providers={row.providers}
            defaultId={current?.pluginId}
            selected={selected}
            disabled={busy}
            selectable
            onToggle={onToggle}
            onSetDefault={onSetDefault}
            labels={{
              setDefault: t(copy + 'setDefault'),
              isDefault: t(copy + 'isDefault'),
              off: t(copy + 'disabledPlugin'),
              toggleFirst: t(copy + 'toggleFirst'),
              associate: t(copy + 'associate'),
              list: t(copy + 'plugin'),
            }}
          />
        </div>
        <Button
          variant="ghost"
          className="open-with-icon-btn open-with-remove"
          aria-label={`${t(copy + 'removeFor')} ${label}`}
          title={t(copy + 'remove')}
          disabled={busy}
          onClick={onRemove}
        >
          <XIcon size={14} />
        </Button>
      </div>
    </li>
  )
}

/**
 * 草稿行（紧凑单行布局）：
 * 类型 = 可输入 Combobox（下拉选已声明类型，或手动输入自定义后缀/协议，ext 模式支持
 * 空格/逗号分隔批量录入多个后缀）→ 默认插件下拉（候选=声明该类型且已启用的插件）→ 保存。
 * 关联集合（多选插件）保留在类型命中后的第二行，仅在多插件可选时展示。
 */
function DraftRow({ rows, routedKeys, busy, onCancel, onSave }: {
  rows: OpenWithRow[]
  routedKeys: Set<string>
  busy: boolean
  onCancel: () => void
  onSave: (key: OpenWithKey, pluginId: string) => Promise<SaveOutcome>
}) {
  const { t } = useI18n()
  const availableRows = useMemo(() => rows.filter(row => !routedKeys.has(row.key)), [routedKeys, rows])
  const [kind, setKind] = useState<OpenWithKind>(() => availableRows[0]?.kind ?? 'ext')
  /** 输入框文本：选择已声明类型时为其 value；自定义时为用户原始输入（ext 可含分隔符） */
  const [value, setValue] = useState(() => availableRows[0]?.value ?? '')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const rowRef = useRef<HTMLLIElement>(null)

  const normalizedParts = useMemo(
    () => normalizeTypeValue(kind, value).split(/[\s,]+/).filter(Boolean),
    [kind, value]
  )
  /** ext 支持批量：全部形状合法才算命中；scheme 只取单值 */
  const parts = kind === 'ext' ? normalizedParts : normalizedParts.slice(0, 1)
  const shapeError = useMemo(() => {
    for (const part of parts) {
      const error = shapeErrorOf(kind, part, t)
      if (error) return error
    }
    return null
  }, [kind, parts, t])
  const matched = useMemo(() => {
    if (!parts.length) return undefined
    const first = rows.find(row => row.kind === kind && row.value === parts[0])
    if (kind === 'ext' && parts.length > 1) {
      // 批量模式：每个后缀都必须有插件声明，且声明集合一致才允许一次性多选
      const all = parts.map(part => rows.find(row => row.kind === 'ext' && row.value === part))
      if (all.some(row => !row)) return undefined
      return all[0]
    }
    return first
  }, [kind, parts, rows])
  const batchKeys = useMemo(() => {
    if (kind !== 'ext' || parts.length < 2 || !matched) return []
    return parts.map(part => `ext:${part}` as OpenWithKey)
  }, [kind, parts, matched])
  const batchMissing = useMemo(() => {
    if (kind !== 'ext' || parts.length < 2) return []
    return parts.filter(part => !rows.some(row => row.kind === 'ext' && row.value === part))
  }, [kind, parts, rows])

  // 新草稿行在列表底部：滚到可见处，避免长列表里看不到
  useEffect(() => {
    rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  // 命中类型变化后重置：默认全选已启用的声明者，默认项沿用已有路由或第一个
  useEffect(() => {
    const ids = matched ? matched.providers.filter(provider => provider.enabled).map(p => p.pluginId) : []
    setSelected(ids)
    setDefaultId(
      matched?.routedPluginId && ids.includes(matched.routedPluginId) ? matched.routedPluginId : ids[0] ?? null
    )
    setSubmitError(null)
  }, [matched])

  const validationError = ((): string | null => {
    if (!parts.length) return null
    if (shapeError) return shapeError
    if (batchMissing.length) return t(copy + 'batchMissing', { exts: batchMissing.map(part => `.${part}`).join(' ') })
    if (!matched) return t(copy + 'noDeclaration')
    if (!matched.providers.some(provider => provider.enabled)) return t(copy + 'allDisabled')
    if (kind !== 'ext' || parts.length === 1) {
      if (routedKeys.has(matched.key)) return t(copy + 'alreadyRouted')
    } else if (batchKeys.some(key => routedKeys.has(key))) {
      return t(copy + 'someRouted')
    }
    return null
  })()
  const canSave = !!matched && !validationError && !!defaultId && !saving && !busy
  const message = submitError ?? validationError

  /** 下拉建议：已声明未映射的类型，按当前输入前缀过滤 */
  const suggestions = useMemo(() => {
    const prefix = normalizedParts[0] ?? ''
    return availableRows
      .filter(row => row.kind === kind && (!prefix || row.value.startsWith(prefix)))
      .slice(0, 8)
  }, [availableRows, kind, normalizedParts])

  const chooseSuggestion = (row: OpenWithRow): void => {
    setKind(row.kind)
    setValue(row.value)
    setOpen(false)
    setSubmitError(null)
  }

  const save = async (): Promise<void> => {
    if (!canSave || !matched || !defaultId) return
    const targets = batchKeys.length ? batchKeys : [matched.key]
    setSaving(true)
    setSubmitError(null)
    try {
      for (const key of targets) {
        const outcome = await onSave(key, defaultId)
        if (!outcome.ok) {
          setSubmitError(outcome.error ?? t(copy + 'saveFailed'))
          return
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const defaultOptions = useMemo(
    () => (matched?.providers ?? []).filter(provider => provider.enabled)
      .map(provider => ({ value: provider.pluginId, label: provider.pluginName })),
    [matched]
  )
  const defaultChoice = defaultId && defaultOptions.some(option => option.value === defaultId) ? defaultId : ''

  return (
    <li className="open-with-row is-draft" ref={rowRef}>
      <div className="open-with-row-body" role="group" aria-label={t(copy + 'addNew')}>
        <div className="open-with-draft-line">
          <span className="open-with-draft-kind" title={kind === 'ext' ? t(copy + 'fileType') : t(copy + 'schemeType')}>
            {kind === 'ext' ? <span className="open-with-type-affix" aria-hidden="true">.</span> : null}
            <button
              type="button"
              className="open-with-kind-toggle"
              disabled={!!suggestions.length}
              title={suggestions.length ? t(copy + 'followDeclared') : t(copy + 'kindToggle')}
              onClick={() => { setKind(kind === 'ext' ? 'scheme' : 'ext'); setValue(''); setSubmitError(null) }}
            >
              {kind === 'ext' ? t(copy + 'fileKind') : t(copy + 'schemeKind')}
            </button>
          </span>
          <span className="open-with-type-field">
            <Input
              className="open-with-type-input"
              value={value}
              placeholder={kind === 'ext' ? t(copy + 'extPlaceholder') : t(copy + 'schemePlaceholder')}
              aria-label={kind === 'ext' ? t(copy + 'extAria') : t(copy + 'schemeAria')}
              aria-invalid={!!message}
              role="combobox"
              aria-expanded={open}
              aria-autocomplete="list"
              aria-controls="open-with-suggestions"
              onChange={event => {
                setValue(event.target.value)
                setOpen(true)
                setSubmitError(null)
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  const hit = suggestions[0]
                  if (open && hit && hit.value !== normalizedParts[0]) {
                    event.preventDefault()
                    chooseSuggestion(hit)
                  } else if (canSave) {
                    event.preventDefault()
                    void save()
                  }
                } else if (event.key === 'Escape' && open) {
                  event.stopPropagation()
                  setOpen(false)
                }
              }}
            />
            {kind === 'scheme' && <span className="open-with-type-affix" aria-hidden="true">://</span>}
            {open && suggestions.length > 0 && (
              <span className="open-with-suggestions" id="open-with-suggestions" role="listbox" aria-label={t(copy + 'pickType')}>
                {suggestions.map(row => (
                  <button
                    type="button"
                    key={row.key}
                    role="option"
                    aria-selected={row.value === normalizedParts[0]}
                    onMouseDown={event => { event.preventDefault(); chooseSuggestion(row) }}
                  >
                    <span className="mono">{formatType(row.kind, row.value)}</span>
                    <span className="open-with-suggestion-note">{t(copy + 'pluginCount', { count: String(row.providers.length) })}</span>
                  </button>
                ))}
              </span>
            )}
          </span>
          <Select
            value={defaultChoice}
            ariaLabel={t(copy + 'defaultPlugin')}
            className="open-with-default-select"
            placeholder={defaultOptions.length ? t(copy + 'pickDefault') : t(copy + 'noPlugins')}
            options={defaultOptions}
            disabled={!defaultOptions.length || saving}
            onChange={next => { setDefaultId(next); setSubmitError(null) }}
          />
          <Button
            size="sm"
            variant="primary"
            className="open-with-save-btn"
            onClick={() => void save()}
            disabled={!canSave}
          >
            {saving ? t(copy + 'savingShort') : batchKeys.length > 1 ? t(copy + 'saveN', { count: String(batchKeys.length) }) : t(copy + 'save')}
          </Button>
          <Button
            variant="ghost"
            className="open-with-icon-btn open-with-remove"
            aria-label={t(copy + 'cancelNew')}
            title={t(copy + 'cancelNew')}
            onClick={onCancel}
          >
            <XIcon size={14} />
          </Button>
        </div>

        {matched && matched.providers.length > 1 && (
          <div className="open-with-draft-extra">
            <span className="open-with-draft-extra-label">{t(copy + 'alsoAssociate')}</span>
            <ProviderList
              providers={matched.providers}
              selected={selected}
              defaultId={defaultId ?? undefined}
              disabled={saving}
              selectable
              onToggle={pluginId => {
                setSubmitError(null)
                setSelected(prev => {
                  const next = prev.includes(pluginId) ? prev.filter(id => id !== pluginId) : [...prev, pluginId]
                  if (!next.length) return prev
                  if (!defaultId || !next.includes(defaultId)) setDefaultId(next[0])
                  return next
                })
              }}
              onSetDefault={pluginId => {
                setSubmitError(null)
                setSelected(prev => (prev.includes(pluginId) ? prev : [...prev, pluginId]))
                setDefaultId(pluginId)
              }}
              labels={{
                setDefault: t(copy + 'setDefault'),
                isDefault: t(copy + 'isDefault'),
                off: t(copy + 'disabledPlugin'),
                toggleFirst: t(copy + 'toggleFirst'),
                associate: t(copy + 'associate'),
                list: t(copy + 'plugin'),
              }}
            />
          </div>
        )}

        {message && <p className="open-with-note is-error" role="alert">{message}</p>}
      </div>
    </li>
  )
}

export function DefaultAppsSection() {
  const { t } = useI18n()
  const [data, setData] = useState<OpenWithListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** 会话内的关联勾选：候选集合由插件声明决定，这里只影响展示，不落库 */
  const [assoc, setAssoc] = useState<Record<string, string[]>>({})
  const [drafts, setDrafts] = useState<number[]>([])
  const draftSeq = useRef(0)

  const refresh = useCallback(async (key?: OpenWithKey): Promise<OpenWithListResult | null> => {
    if (!shellApi.getOpenWithList) {
      setError(t(copy + 'unavailable'))
      setLoading(false)
      return null
    }
    try {
      const list = await shellApi.getOpenWithList(key)
      setData(list)
      setError(null)
      return list
    } catch (err) {
      setError(err instanceof Error ? err.message : t(copy + 'readFailed'))
      return null
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
    const off = shellApi.onEvent?.(payload => {
      if (payload.type === 'contributions-changed' && payload.slot === 'open-with') void refresh()
      if (payload.type === 'plugins-changed') void refresh()
    })
    return () => off?.()
  }, [refresh])

  const mappedRows = useMemo(() => (data?.rows ?? []).filter(row => !!row.routedPluginId), [data])
  const routedKeys = useMemo(() => new Set(mappedRows.map(row => row.key as string)), [mappedRows])

  /** 勾选默认取全部已启用声明者；勾选只作用于当前会话，落库始终是默认路由 */
  const selectedFor = useCallback((row: OpenWithRow): string[] =>
    assoc[row.key] ?? row.providers.filter(provider => provider.enabled).map(provider => provider.pluginId),
  [assoc])

  const toggleProvider = useCallback((row: OpenWithRow, pluginId: string) => {
    setAssoc(prev => {
      const current = prev[row.key] ?? row.providers.filter(p => p.enabled).map(p => p.pluginId)
      const next = current.includes(pluginId)
        ? current.filter(id => id !== pluginId)
        : [...current, pluginId]
      if (!next.length) return prev
      return { ...prev, [row.key]: next }
    })
  }, [])

  /**
   * 写默认路由：route 只落库；系统默认申请走 setOpenWithDefault（开发态或受限
   * 平台注册会返回失败），失败不回滚内部路由——用户在 eNest 内的选择依然生效。
   */
  const applyDefault = useCallback(async (
    key: OpenWithKey,
    pluginId: string
  ): Promise<{ ok: boolean; error?: string; hint?: string }> => {
    if (!shellApi.routeOpenWith) return { ok: false, error: t(copy + 'unavailable') }
    let result: OpenWithActionResult | undefined
    try {
      result = await shellApi.routeOpenWith(key, pluginId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : t(copy + 'routeFailed') }
    }
    if (!result?.ok) return { ok: false, error: result?.error ?? t(copy + 'routeFailed') }
    // 路由已保存；顺手尝试系统默认申请（失败静默——那是可选增强，不阻塞关联）
    const system = await shellApi.setOpenWithDefault?.(key, pluginId).catch(() => undefined)
    await refresh()
    return { ok: true, hint: system && !system.ok ? undefined : system?.hint }
  }, [refresh, t])

  /** 设为默认同时确保该插件在关联集合里（默认必须是被关联的一个） */
  const setDefault = useCallback(async (row: OpenWithRow, pluginId: string, pluginName: string) => {
    if (busyKey) return
    setAssoc(prev => {
      const current = prev[row.key] ?? row.providers.filter(p => p.enabled).map(p => p.pluginId)
      return current.includes(pluginId) ? prev : { ...prev, [row.key]: [...current, pluginId] }
    })
    setBusyKey(row.key)
    try {
      const outcome = await applyDefault(row.key, pluginId)
      if (!outcome.ok) notify.error(outcome.error ?? t(copy + 'routeFailed'))
      else if (outcome.hint) notify.info(outcome.hint)
      else notify.success(t(copy + 'switchedTo', { name: pluginName }))
    } finally {
      setBusyKey(null)
    }
  }, [applyDefault, busyKey, t])

  const removeMapping = useCallback(async (key: OpenWithKey, label: string) => {
    if (busyKey || !shellApi.clearOpenWithDefault) return
    setBusyKey(key)
    try {
      const result = await shellApi.clearOpenWithDefault(key)
      if (!result.ok) notify.error(result.error ?? t(copy + 'removeFailed'))
      else notify.success(t(copy + 'removedFor', { type: label }))
      await refresh()
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t(copy + 'removeFailed'))
    } finally {
      setBusyKey(null)
    }
  }, [busyKey, refresh, t])

  const openSystemSettings = useCallback(async () => {
    try { await shellApi.openOpenWithSystemSettings?.() } catch { /* 引导失败不打断 */ }
  }, [])

  const addDraft = useCallback(() => {
    draftSeq.current += 1
    setDrafts(prev => [...prev, draftSeq.current])
  }, [])

  const closeDraft = useCallback((id: number) => {
    setDrafts(prev => prev.filter(draft => draft !== id))
  }, [])

  const saveDraft = useCallback(async (
    draftId: number,
    key: OpenWithKey,
    pluginId: string
  ): Promise<SaveOutcome> => {
    if (busyKey) return { ok: false, error: t(copy + 'busy') }
    setBusyKey(key)
    try {
      const outcome = await applyDefault(key, pluginId)
      if (!outcome.ok) return { ok: false, error: outcome.error }
      if (outcome.hint) notify.info(outcome.hint)
      else notify.success(t(copy + 'addedDefault'))
      closeDraft(draftId)
      return { ok: true }
    } finally {
      setBusyKey(null)
    }
  }, [applyDefault, busyKey, closeDraft, t])

  const declaredCount = data?.rows.length ?? 0
  const isEmpty = !mappedRows.length && !drafts.length

  return (
    <Card className="open-with-section" title={t(copy + 'title')}
      actions={
        <span className="open-with-head-actions">
          <Button
            variant="ghost"
            className="open-with-icon-btn"
            aria-label={t(copy + 'addNew')}
            title={t(copy + 'addNew')}
            disabled={loading || !data}
            onClick={addDraft}
          >
            <PlusIcon />
          </Button>
          <Button
            variant="ghost"
            className="open-with-icon-btn"
            aria-label={t(copy + 'systemSettings')}
            title={t(copy + 'systemSettings')}
            onClick={() => void openSystemSettings()}
          >
            <SettingsIcon size={16} />
          </Button>
        </span>
      }>
      {loading ? (
        <p className="desc" role="status">{t('common.loading')}</p>
      ) : !data ? (
        <p className="desc" role="alert">{error ?? t(copy + 'unavailable')}</p>
      ) : isEmpty ? (
        <p className="desc">
          {t(copy + 'emptyList', { count: String(declaredCount) })}
        </p>
      ) : (
        <>
          <ul className="open-with-list">
            {mappedRows.map(row => (
              <MappedRow
                key={row.key}
                row={row}
                list={data}
                selected={selectedFor(row)}
                busy={busyKey === row.key}
                onToggle={pluginId => toggleProvider(row, pluginId)}
                onSetDefault={pluginId => {
                  const provider = row.providers.find(item => item.pluginId === pluginId)
                  void setDefault(row, pluginId, provider?.pluginName ?? pluginId)
                }}
                onRemove={() => void removeMapping(row.key, formatType(row.kind, row.value))}
                onInspect={() => void refresh(row.key)}
              />
            ))}
            {drafts.map(id => (
              <DraftRow
                key={id}
                rows={data.rows}
                routedKeys={routedKeys}
                busy={!!busyKey}
                onCancel={() => closeDraft(id)}
                onSave={(key, pluginId) => saveDraft(id, key, pluginId)}
              />
            ))}
          </ul>
        </>
      )}
      {error && data && <p className="desc open-with-error" role="alert">{error}</p>}
    </Card>
  )
}

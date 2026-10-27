/**
 * DefaultAppsSection — 设置 → 通用里的「打开方式」管理
 *
 * 呈现：一张映射列表，每行是「类型（.ext / scheme://）→ 关联插件」。
 *  - 关联插件就是声明了该类型的插件（manifest.contributes.openWith），同一类型可关联多个；
 *  - 标「默认」的那个负责实际打开，落库为设置段 openWith 的路由（setOpenWithDefault）；
 *  - 行尾 × 移除整条映射；标题右侧 + 新增草稿行，齿轮图标进系统默认应用设置。
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
import { SettingsIcon, XIcon } from '@renderer/components/icons'

type OpenWithProvider = OpenWithRow['providers'][number]
type OpenWithKind = 'ext' | 'scheme'

/** 保存结果：失败原因留在草稿行内展示，不走全局通知 */
interface SaveOutcome {
  ok: boolean
  error?: string
}

const CUSTOM_TYPE = 'custom'

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

const formatType = (kind: OpenWithKind, value: string): string =>
  kind === 'ext' ? `.${value}` : `${value}://`

const pluginGlyph = (provider: OpenWithProvider): string =>
  provider.glyph ?? Array.from(provider.pluginName)[0] ?? '?'

/** 归一化用户输入：扩展名去点、协议名去 `://`，统一小写 */
function normalizeTypeValue(kind: OpenWithKind, raw: string): string {
  const value = raw.trim().toLowerCase()
  return kind === 'ext' ? value.replace(/^\.+/, '') : value.replace(/:\/\/$/, '')
}

function shapeErrorOf(kind: OpenWithKind, value: string): string | null {
  if (!value) return null
  if (kind === 'ext') {
    return OPEN_WITH_EXT_RE.test(value) ? null : '扩展名只能包含小写字母和数字（1–10 位，不含点）'
  }
  if ((RESERVED_OPEN_WITH_SCHEMES as readonly string[]).includes(value)) {
    return `${value}:// 由系统保留，不能作为插件的打开方式`
  }
  return OPEN_WITH_SCHEME_RE.test(value) ? null : '协议名需以小写字母开头，可含数字、+、-、.'
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
function ProviderList({ providers, defaultId, selected, disabled, selectable = false, onToggle, onSetDefault }: {
  providers: OpenWithProvider[]
  defaultId?: string
  selected?: string[]
  disabled: boolean
  selectable?: boolean
  onToggle?: (pluginId: string) => void
  onSetDefault: (pluginId: string) => void
}) {
  return (
    <ul className="open-with-providers" aria-label="关联插件">
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
                title={isDefault ? '默认插件，先切换默认再取消关联' : undefined}
                aria-label={`关联 ${provider.pluginName}`}
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
              <span className="open-with-primary">默认</span>
            ) : !provider.enabled ? (
              <span className="open-with-provider-note">已停用</span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="open-with-default-btn"
                disabled={disabled}
                aria-label={`把 ${provider.pluginName} 设为默认打开插件`}
                onClick={() => onSetDefault(provider.pluginId)}
              >
                设为默认
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** 已保存的映射行：勾选表示会话内选中的关联集合，默认插件不可取消 */
function MappedRow({ row, packaged, selected, busy, onToggle, onSetDefault, onRemove }: {
  row: OpenWithRow
  packaged: boolean
  selected: string[]
  busy: boolean
  onToggle: (pluginId: string) => void
  onSetDefault: (pluginId: string) => void
  onRemove: () => void
}) {
  const current = row.providers.find(provider => provider.routed)
  const enabledCount = row.providers.filter(provider => provider.enabled).length
  const label = formatType(row.kind, row.value)
  const desc = [
    current ? `当前用 ${current.pluginName} 打开` : '尚未指定默认插件',
    `${enabledCount} 个插件可处理`,
    row.caps.needsSystemSettings ? '本平台需在系统设置完成最后一步' : null
  ].filter(Boolean).join(' · ')

  return (
    <li className="open-with-row">
      <div className="open-with-row-body" role="group" aria-label={`${label} 的打开方式`}>
        <div className="open-with-row-main">
          <div className="open-with-type-cell">
            <div className="open-with-type-line">
              <span className="open-with-type">{label}</span>
              <span className={`open-with-chip open-with-chip--${statusTone(row)}`}>
                {statusLabel(row, packaged)}
              </span>
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
            />
          </div>
        </div>
        <Button
          variant="ghost"
          className="open-with-icon-btn open-with-remove"
          aria-label={`移除 ${label} 的打开方式`}
          title="移除"
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
 * 草稿行：选类型 → 勾选关联插件 → 指定默认 → 保存。
 * 类型来源：已声明但还没有打开方式的类型（下拉），或自定义输入（扩展名 / 协议名）。
 */
function DraftRow({ rows, routedKeys, busy, onCancel, onSave }: {
  rows: OpenWithRow[]
  routedKeys: Set<string>
  busy: boolean
  onCancel: () => void
  onSave: (key: OpenWithKey, pluginId: string) => Promise<SaveOutcome>
}) {
  const availableRows = useMemo(() => rows.filter(row => !routedKeys.has(row.key)), [routedKeys, rows])
  /** 下拉选中项：已声明类型的 key，或 CUSTOM_TYPE */
  const [typeChoice, setTypeChoice] = useState<string>(() => availableRows[0]?.key ?? CUSTOM_TYPE)
  const [kind, setKind] = useState<OpenWithKind>(() => availableRows[0]?.kind ?? 'ext')
  const [value, setValue] = useState(() => availableRows[0]?.value ?? '')
  const [selected, setSelected] = useState<string[]>([])
  const [defaultId, setDefaultId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLLIElement>(null)

  const typeOptions = useMemo(() => [
    ...availableRows.map(row => ({ value: row.key as string, label: formatType(row.kind, row.value) })),
    { value: CUSTOM_TYPE, label: availableRows.length ? '自定义类型…' : '自定义类型' }
  ], [availableRows])
  /** 选中的类型被占用/消失后回落为自定义，避免下拉显示原始 key */
  const choice = typeOptions.some(option => option.value === typeChoice) ? typeChoice : CUSTOM_TYPE
  const custom = choice === CUSTOM_TYPE
  const normalized = custom ? normalizeTypeValue(kind, value) : value
  const key = normalized && !shapeErrorOf(kind, normalized) ? (`${kind}:${normalized}` as OpenWithKey) : null
  const matched = useMemo(() => (key ? rows.find(row => row.key === key) : undefined), [key, rows])

  // 新草稿行在列表底部：滚到可见处，避免长列表里看不到
  useEffect(() => {
    rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [])

  useEffect(() => {
    if (!custom) return
    inputRef.current?.focus()
  }, [custom])

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
    if (!normalized) return null
    const shape = shapeErrorOf(kind, normalized)
    if (shape) return shape
    if (!matched) return '没有插件声明该类型，安装对应插件后再来关联'
    if (!matched.providers.some(provider => provider.enabled)) return '声明该类型的插件均已停用，启用后再来关联'
    if (routedKeys.has(matched.key)) return '该类型已有打开方式，请先移除原映射'
    return null
  })()
  const canSave = !!matched && !validationError && selected.length > 0 && !saving && !busy
  const message = submitError ?? validationError

  const toggleProvider = (pluginId: string): void => {
    setSubmitError(null)
    setSelected(prev => {
      const next = prev.includes(pluginId) ? prev.filter(id => id !== pluginId) : [...prev, pluginId]
      if (!next.length) return prev
      if (!defaultId || !next.includes(defaultId)) setDefaultId(next[0])
      return next
    })
  }

  /** 设为默认时同时把它加入关联集合（默认必须是被关联的一个） */
  const chooseDefault = (pluginId: string): void => {
    setSubmitError(null)
    setSelected(prev => (prev.includes(pluginId) ? prev : [...prev, pluginId]))
    setDefaultId(pluginId)
  }

  const chooseType = (next: string): void => {
    setSubmitError(null)
    if (next === CUSTOM_TYPE) {
      setTypeChoice(next)
      setKind('ext')
      setValue('')
      return
    }
    const row = rows.find(item => item.key === next)
    if (!row) return
    setTypeChoice(next)
    setKind(row.kind)
    setValue(row.value)
  }

  const save = async (): Promise<void> => {
    if (!canSave || !matched) return
    const primary = defaultId && selected.includes(defaultId) ? defaultId : selected[0]
    setSaving(true)
    setSubmitError(null)
    try {
      const outcome = await onSave(matched.key, primary)
      if (!outcome.ok) setSubmitError(outcome.error ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="open-with-row is-draft" ref={rowRef}>
      <div className="open-with-row-body" role="group" aria-label="新增打开方式">
        <div className="open-with-draft-head">
          <Select
            value={choice}
            ariaLabel="选择文件类型或协议"
            minWidth={124}
            options={typeOptions}
            onChange={chooseType}
          />
          {custom && (
            <>
              <Select
                value={kind}
                ariaLabel="类型类别"
                minWidth={96}
                options={[
                  { value: 'ext', label: '文件类型' },
                  { value: 'scheme', label: '协议' }
                ]}
                onChange={next => {
                  setKind(next)
                  setValue('')
                  setSubmitError(null)
                }}
              />
              <span className="open-with-type-field">
                {kind === 'ext' && <span className="open-with-type-affix" aria-hidden="true">.</span>}
                <Input
                  ref={inputRef}
                  className="open-with-type-input"
                  value={value}
                  placeholder={kind === 'ext' ? 'md' : 'enest-md'}
                  aria-label={kind === 'ext' ? '文件扩展名（不含点）' : '协议名'}
                  aria-invalid={!!message}
                  onChange={event => {
                    setValue(event.target.value)
                    setSubmitError(null)
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && canSave) void save()
                  }}
                />
                {kind === 'scheme' && <span className="open-with-type-affix" aria-hidden="true">://</span>}
              </span>
            </>
          )}
          <Button
            variant="ghost"
            className="open-with-icon-btn open-with-remove"
            aria-label="取消新增"
            title="取消新增"
            onClick={onCancel}
          >
            <XIcon size={14} />
          </Button>
        </div>

        <p className="open-with-row-desc">
          {matched
            ? `声明了该类型的 ${matched.providers.length} 个插件都可关联，勾选要保留的插件并指定默认。`
            : availableRows.length
              ? '选择插件已声明的类型，或选「自定义」手动输入；只有声明过该类型的插件才能被关联。'
              : '暂无可选类型：安装并启用声明了 openWith 的插件后这里会出现可选类型，也可选「自定义」手动输入。'}
        </p>

        {matched && (
          <ProviderList
            providers={matched.providers}
            selected={selected}
            defaultId={defaultId ?? undefined}
            disabled={saving}
            selectable
            onToggle={toggleProvider}
            onSetDefault={chooseDefault}
          />
        )}

        {message && <p className="open-with-note is-error" role="alert">{message}</p>}

        <div className="open-with-draft-actions">
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={!canSave}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </li>
  )
}

export function DefaultAppsSection() {
  const [data, setData] = useState<OpenWithListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** 会话内的关联勾选：候选集合由插件声明决定，这里只影响展示，不落库 */
  const [assoc, setAssoc] = useState<Record<string, string[]>>({})
  const [drafts, setDrafts] = useState<number[]>([])
  const draftSeq = useRef(0)

  const refresh = useCallback(async (): Promise<OpenWithListResult | null> => {
    if (!shellApi.getOpenWithList) {
      setError('当前宿主未提供打开方式接口')
      setLoading(false)
      return null
    }
    try {
      const list = await shellApi.getOpenWithList()
      setData(list)
      setError(null)
      return list
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取打开方式失败')
      return null
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
   * 写默认路由：setDefault 先落库再尝试系统注册；开发态或受限平台注册会返回失败。
   * 因此失败后重读列表，以「路由是否真的指向该插件」判定是否生效，避免误报失败。
   */
  const applyDefault = useCallback(async (
    key: OpenWithKey,
    pluginId: string
  ): Promise<{ ok: boolean; error?: string; hint?: string }> => {
    if (!shellApi.setOpenWithDefault) return { ok: false, error: '当前宿主未提供打开方式接口' }
    let result
    try {
      result = await shellApi.setOpenWithDefault(key, pluginId)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : '设置失败' }
    }
    const list = await refresh()
    const routed = list?.rows.find(row => row.key === key)?.routedPluginId === pluginId
    if (result.ok) return { ok: true, hint: result.hint }
    if (routed) {
      return { ok: true, hint: result.error ? `已关联插件，系统默认未变更：${result.error}` : undefined }
    }
    return { ok: false, error: result.error ?? '设置失败' }
  }, [refresh])

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
      if (!outcome.ok) notify.error(outcome.error ?? '设置失败')
      else if (outcome.hint) notify.info(outcome.hint)
      else notify.success(`默认改用 ${pluginName} 打开`)
    } finally {
      setBusyKey(null)
    }
  }, [applyDefault, busyKey])

  const removeMapping = useCallback(async (key: OpenWithKey, label: string) => {
    if (busyKey || !shellApi.clearOpenWithDefault) return
    setBusyKey(key)
    try {
      const result = await shellApi.clearOpenWithDefault(key)
      if (!result.ok) notify.error(result.error ?? '移除失败')
      else notify.success(`已移除 ${label} 的打开方式`)
      await refresh()
    } catch (err) {
      notify.error(err instanceof Error ? err.message : '移除失败')
    } finally {
      setBusyKey(null)
    }
  }, [busyKey, refresh])

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
    if (busyKey) return { ok: false, error: '有其它操作正在进行，请稍后再试' }
    setBusyKey(key)
    try {
      const outcome = await applyDefault(key, pluginId)
      if (!outcome.ok) return { ok: false, error: outcome.error }
      if (outcome.hint) notify.info(outcome.hint)
      else notify.success('已添加打开方式')
      closeDraft(draftId)
      return { ok: true }
    } finally {
      setBusyKey(null)
    }
  }, [applyDefault, busyKey, closeDraft])

  const declaredCount = data?.rows.length ?? 0
  const isEmpty = !mappedRows.length && !drafts.length

  return (
    <section className="s-card open-with-section" aria-label="打开方式">
      <div className="open-with-head">
        <h2>打开方式</h2>
        <span className="open-with-head-actions">
          <Button
            variant="ghost"
            className="open-with-icon-btn"
            aria-label="新增打开方式"
            title="新增打开方式"
            disabled={loading || !data}
            onClick={addDraft}
          >
            <PlusIcon />
          </Button>
          <Button
            variant="ghost"
            className="open-with-icon-btn"
            aria-label="系统默认应用设置"
            title="系统默认应用设置"
            onClick={() => void openSystemSettings()}
          >
            <SettingsIcon size={16} />
          </Button>
        </span>
      </div>

      {loading ? (
        <p className="desc" role="status">正在读取…</p>
      ) : !data ? (
        <p className="desc" role="alert">{error ?? '打开方式不可用'}</p>
      ) : isEmpty ? (
        <p className="desc">
          还没有打开方式。点右上角 + 添加：选择插件已声明的类型，或自定义输入扩展名 / 协议名，再挑选关联插件。
          {declaredCount
            ? `当前有 ${declaredCount} 个类型可由插件处理。`
            : '安装并启用 markdown / database 等插件后，这里会出现可关联的类型。'}
        </p>
      ) : (
        <>
          {mappedRows.length > 0 && (
            <p className="open-with-hint">
              标「默认」的插件负责实际打开；同一类型可关联多个插件，点「设为默认」切换。
            </p>
          )}
          <ul className="open-with-list">
            {mappedRows.map(row => (
              <MappedRow
                key={row.key}
                row={row}
                packaged={!!data.packaged}
                selected={selectedFor(row)}
                busy={busyKey === row.key}
                onToggle={pluginId => toggleProvider(row, pluginId)}
                onSetDefault={pluginId => {
                  const provider = row.providers.find(item => item.pluginId === pluginId)
                  void setDefault(row, pluginId, provider?.pluginName ?? pluginId)
                }}
                onRemove={() => void removeMapping(row.key, formatType(row.kind, row.value))}
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
    </section>
  )
}

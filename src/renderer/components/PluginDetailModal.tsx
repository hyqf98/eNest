/**
 * PluginDetailModal — 插件详情弹窗
 * 大图头（图标/名称/作者/版本/分类/安装量/权限）+ 安装/打开/更新、启用/禁用切换、
 * 已安装时卸载与关闭操作 + README Markdown 正文。
 * 安装：本地 sample 优先（shellApi.installMarketPlugin），失败展示错误；
 *       远程资产入队下载，进度经 InstallProgressPanel。
 * README 经 shellApi.getPluginReadme 异步拉取；GSAP 控制遮罩模糊与内容 stagger 入退场。
 * 使用方：MarketPage（卡片/轮播点击打开）。依赖：MarkdownView、marketMotion、shellApi。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import type {
  LaunchHotkeyProbeResult,
  PluginLaunchConfig,
  PluginLaunchMode,
  PluginLaunchPatch,
  PluginSummary
} from '@shared/types/plugin'
import { shellApi } from '@renderer/services/shellApi'
import { playModalIn, playModalOut } from '@renderer/gsap/marketMotion'
import { MarkdownView } from '@renderer/components/MarkdownView'
import { useI18n } from '@renderer/hooks/useI18n'
import { IS_MAC } from '@shared/platform'
import { permissionLabel } from '@shared/permissionLabels'
import { requiresUserConsent } from '@shared/pluginPermissionPolicy'
import { PluginBuiltinCapabilities } from '@renderer/components/PluginBuiltinCapabilities'

type ReadmeStatus = 'loading' | 'ok' | 'empty' | 'error'

/** 录制中的热键探测状态：acc + 归属结果 */
interface HotkeyProbeState {
  acc: string
  result: LaunchHotkeyProbeResult
}

/**
 * 键盘事件 → Electron accelerator（如 Alt+Space / CommandOrControl+Shift+J）。
 * 无修饰键、仅 Shift 修饰或无法识别主键时返回 null（不能注册为全局热键）。
 */
function eventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.metaKey) mods.push(IS_MAC ? 'Command' : 'Super')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const code = e.code
  let key = ''
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit\d$/.test(code)) key = code.slice(5)
  else if (/^F\d{1,2}$/.test(code)) key = code
  else {
    const named: Record<string, string> = {
      Space: 'Space',
      Tab: 'Tab',
      Backquote: '`',
      Minus: '-',
      Equal: '=',
      BracketLeft: '[',
      BracketRight: ']',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/',
      Backslash: '\\',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right'
    }
    key = named[code] ?? ''
  }
  if (!key) return null
  // 纯主键 / 仅 Shift：会吞掉正常键盘输入，不允许注册
  if (mods.length === 0) return null
  if (mods.length === 1 && mods[0] === 'Shift') return null
  return [...mods, key].join('+')
}

/** accelerator → 展示文案（Command → ⌘ 等平台化） */
function formatAccelerator(acc: string): string {
  if (!IS_MAC) return acc.replace(/\+/g, ' + ')
  return acc
    .split('+')
    .map((part) =>
      part === 'Command'
        ? '⌘'
        : part === 'Alt'
          ? '⌥'
          : part === 'Shift'
            ? '⇧'
            : part === 'Control'
              ? '⌃'
              : part
    )
    .join(' ')
}

/** 探测结果 → 冲突描述文案 */
function describeProbe(probe: HotkeyProbeState): string {
  const { result } = probe
  switch (result.status) {
    case 'free':
      return '可用'
    case 'eNest-quick':
      return `与快捷启动（Quick）热键冲突，请先到 设置 → 快捷启动 更换 Quick 热键`
    case 'plugin-launch':
      return `已被插件「${result.ownerLabel}」的启动热键占用，可接管`
    case 'plugin-runtime':
      return `已被插件「${result.ownerLabel}」的运行时热键占用，可接管`
    default:
      return `无法注册${result.hint ? `：${result.hint}` : '：被系统或其他应用占用'}`
  }
}

interface Props {
  plugin: PluginSummary
  /** 关闭弹窗（动画结束后由子组件回调） */
  onClose: () => void
  /** 安装完成后打开插件（sample 同步安装成功时调用） */
  onInstall: (id: string) => void
}

/** 插件品牌色推导渐变底色（暗端混入色）：无对应主题 token，品牌色本身即数据 */
const ICON_BG_DARK_MIX = '#111'

function iconBackground(p: PluginSummary): string {
  return `linear-gradient(145deg, ${p.color}, color-mix(in srgb, ${p.color} 50%, ${ICON_BG_DARK_MIX}))`
}

export function PluginDetailModal({ plugin, onClose, onInstall }: Props) {
  const sensitivePermissions = [...new Set(plugin.permissions)].filter(requiresUserConsent)
  const rootRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const [status, setStatus] = useState<ReadmeStatus>('loading')
  const [readme, setReadme] = useState('')
  const [uninstalling, setUninstalling] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 本地可变副本：启用切换后立刻反映，不必等父级刷新 */
  const [enabled, setEnabled] = useState(plugin.enabled !== false)
  /** 图标加载失败时回退 glyph 色块 */
  const [iconFailed, setIconFailed] = useState(false)
  const showIcon = Boolean(plugin.icon) && !iconFailed
  const { t } = useI18n()

  // —— 快捷启动配置（仅已安装插件；settings.pluginLaunch[id]）——
  const [launchCfg, setLaunchCfg] = useState<PluginLaunchConfig | null>(null)
  const [recording, setRecording] = useState(false)
  const [probeState, setProbeState] = useState<HotkeyProbeState | null>(null)
  const [savingLaunch, setSavingLaunch] = useState(false)
  const [aliasDraft, setAliasDraft] = useState('')

  const disabled = plugin.installed && !enabled
  const updateVersion = plugin.latestVersion
  const motionContext = useRef<gsap.Context | null>(null)

  /** 先播退场，再通知父级卸载 */
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    motionContext.current?.add(() => {
      void playModalOut(rootRef.current).then(() => {
        if (motionContext.current) onClose()
      })
    })
  }, [onClose])

  // 入场动画
  useEffect(() => {
    const context = gsap.context(() => playModalIn(rootRef.current), rootRef)
    motionContext.current = context
    closingRef.current = false
    return () => {
      motionContext.current = null
      context.revert()
    }
  }, [plugin.id])

  // plugin 变更时同步 enabled / 图标回退状态
  useEffect(() => {
    setEnabled(plugin.enabled !== false)
    setActionError(null)
    setIconFailed(false)
  }, [plugin.id, plugin.enabled, plugin.icon])

  // 快捷启动配置加载：settings.pluginLaunch[plugin.id]
  useEffect(() => {
    let cancelled = false
    setProbeState(null)
    setRecording(false)
    setLaunchCfg(null)
    if (!plugin.installed) return
    void shellApi
      .getSettings()
      .then((settings) => {
        if (cancelled) return
        const cfg = settings?.pluginLaunch?.[plugin.id] ?? null
        setLaunchCfg(cfg)
        setAliasDraft(cfg?.aliases?.join('、') ?? '')
      })
      .catch(() => {
        /* 读取失败保持空配置 */
      })
    return () => {
      cancelled = true
    }
  }, [plugin.id, plugin.installed])

  // README 拉取
  useEffect(() => {
    let cancelled = false
    closingRef.current = false
    setStatus('loading')
    setReadme('')

    const load = async () => {
      try {
        const md = await shellApi.getPluginReadme(plugin.id)
        if (cancelled) return
        if (!md || !md.trim()) {
          setStatus('empty')
        } else {
          setReadme(md)
          setStatus('ok')
        }
      } catch {
        if (!cancelled) setStatus('error')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [plugin.id])

  // Escape 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        requestClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  const actionLabel = plugin.installed
    ? disabled
      ? t('plugin.disabled')
      : t('plugin.open')
    : installing
      ? t('plugin.installing')
      : t('plugin.install')

  /**
   * 安装 / 打开：
   * - 已安装且启用 → onInstall 打开
   * - 未安装 → installMarketPlugin（sample 同步成功则直接打开；远程入队关弹窗看进度）
   */
  const handlePrimary = async () => {
    if (installing || uninstalling) return
    setActionError(null)
    if (plugin.installed) {
      if (disabled) return
      onInstall(plugin.id)
      requestClose()
      return
    }
    if (!shellApi.installMarketPlugin) {
      onInstall(plugin.id)
      requestClose()
      return
    }
    setInstalling(true)
    try {
      const result = await shellApi.installMarketPlugin(plugin.id)
      if (result.mode === 'sample' || result.mode === 'already') {
        onInstall(plugin.id)
        requestClose()
      } else {
        // remote：已入队，关弹窗由 InstallProgressPanel 展示进度
        requestClose()
      }
    } catch (err) {
      setActionError(t('plugin.installFailed', { error: (err as Error).message }))
      setInstalling(false)
    }
  }

  /** 更新到 latestVersion：二次确认后强制走远程下载入队 */
  const handleUpdate = async () => {
    if (installing || !updateVersion || !shellApi.installMarketPlugin) return
    const ok = window.confirm(
      t('plugin.updateConfirm', { name: plugin.name, version: updateVersion })
    )
    if (!ok) return
    setActionError(null)
    setInstalling(true)
    try {
      await shellApi.installMarketPlugin(plugin.id, { force: true })
      requestClose()
    } catch (err) {
      setActionError(t('plugin.installFailed', { error: (err as Error).message }))
      setInstalling(false)
    }
  }

  /** 启用/禁用切换；乐观更新本地状态，失败回滚 */
  const handleToggleEnabled = async () => {
    if (toggling || !shellApi.setPluginEnabled) return
    const next = !enabled
    setToggling(true)
    setActionError(null)
    setEnabled(next)
    try {
      await shellApi.setPluginEnabled(plugin.id, next)
    } catch (err) {
      setEnabled(!next)
      setActionError(t('plugin.enableFailed', { error: (err as Error).message }))
    } finally {
      setToggling(false)
    }
  }

  /** 二次确认后卸载；结果经 uninstall-result 刷新列表，此处关闭详情并恢复按钮 */
  const handleUninstall = async () => {
    if (uninstalling) return
    const ok = window.confirm(t('plugin.uninstallConfirm', { name: plugin.name }))
    if (!ok) return
    if (!shellApi.uninstallPlugin) return
    setUninstalling(true)
    try {
      await shellApi.uninstallPlugin(plugin.id)
      requestClose()
    } catch {
      /* 失败 toast 已由 uninstall-result 事件覆盖 */
    } finally {
      setUninstalling(false)
    }
  }

  // —— 快捷启动：写入与热键录制 ——

  /** 统一保存入口；失败时展示 probe 冲突详情（可接管项由 UI 提供接管按钮） */
  const saveLaunch = useCallback(
    async (
      patch: PluginLaunchPatch,
      opts?: { takeover?: boolean }
    ): Promise<boolean> => {
      if (!shellApi.setPluginLaunch || savingLaunch) return false
      setSavingLaunch(true)
      setProbeState(null)
      try {
        const result = await shellApi.setPluginLaunch(plugin.id, patch, opts)
        if (!result.ok) {
          if (result.probe) setProbeState({ acc: result.probe.acc, result: result.probe })
          else setActionError(result.error ?? '保存失败')
          return false
        }
        setLaunchCfg(result.config ?? null)
        return true
      } catch (err) {
        setActionError((err as Error).message)
        return false
      } finally {
        setSavingLaunch(false)
      }
    },
    [plugin.id, savingLaunch]
  )

  /** 录制开始：监听下一次组合键（Esc 取消；无效组合继续等待） */
  const startRecording = useCallback(() => {
    if (recording) return
    setProbeState(null)
    setRecording(true)
  }, [recording])

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const acc = eventToAccelerator(e)
      if (!acc) return // 修饰键单独按下 / 无效主键：继续等待
      setRecording(false)
      // 探测归属：free 直接保存；冲突展示详情（可接管项出现「接管并保存」按钮）
      void shellApi.probeLaunchHotkey?.(acc, plugin.id).then((result) => {
        if (result.status === 'free') {
          void saveLaunch({ hotkey: acc })
        } else {
          setProbeState({ acc, result })
        }
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, plugin.id, saveLaunch])

  /** 触发词保存：、/,/空格 分隔，去空去重 */
  const commitAliases = useCallback(() => {
    const aliases = aliasDraft
      .split(/[、,，\s]+/)
      .map((a) => a.trim())
      .filter(Boolean)
    void saveLaunch({ aliases })
  }, [aliasDraft, saveLaunch])

  return (
    <div className="detail-overlay" ref={rootRef} role="presentation">
      <div
        className="detail-backdrop"
        data-detail-backdrop
        onClick={requestClose}
        aria-hidden="true"
      />
      <div
        className="detail-modal"
        data-detail-modal
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-detail-title"
      >
        <header className="detail-header" data-detail-header>
          <div
            className="detail-icon"
            data-detail-icon
            style={{ background: iconBackground(plugin), ...(disabled ? { opacity: 0.6 } : null) }}
          >
            {showIcon ? (
              <img
                src={plugin.icon}
                alt={plugin.name}
                loading="lazy"
                draggable={false}
                onError={() => setIconFailed(true)}
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
              />
            ) : (
              plugin.glyph
            )}
          </div>
          <div className="detail-meta" data-detail-meta>
            <h2 id="plugin-detail-title">{plugin.name}</h2>
            <div className="detail-sub">
              {plugin.author} · v{plugin.version}
              {updateVersion ? ` · ${t('plugin.updateAvailable', { version: updateVersion })}` : ''}
            </div>
            <div className="detail-chips" data-detail-chips>
              <span className="detail-chip">{plugin.category}</span>
              {plugin.installed ? (
                <span className="detail-chip ok">
                  {disabled ? t('plugin.disabled') : t('plugin.installed')}
                </span>
              ) : null}

            </div>
          </div>
          <div className="detail-actions" data-detail-actions>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handlePrimary()}
              disabled={uninstalling || installing || toggling || disabled}
            >
              {actionLabel}
            </button>
            {plugin.installed && updateVersion && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleUpdate()}
                disabled={uninstalling || installing || toggling}
              >
                {installing ? t('plugin.updating') : t('plugin.update')}
              </button>
            )}
            {plugin.installed && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleToggleEnabled()}
                disabled={uninstalling || installing || toggling}
              >
                {toggling ? t('common.loading') : enabled ? t('plugin.disable') : t('plugin.enable')}
              </button>
            )}
            {plugin.installed && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleUninstall()}
                disabled={uninstalling}
              >
                {uninstalling ? t('plugin.uninstalling') : t('plugin.uninstall')}
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={uninstalling}>
              {t('plugin.close')}
            </button>
          </div>
          {actionError && (
            <div
              className="detail-state"
              style={{ gridColumn: '1 / -1', color: 'var(--danger)', fontSize: 12 }}
              role="alert"
            >
              {actionError}
            </div>
          )}
        </header>

        {plugin.installed && shellApi.setPluginLaunch && (
          <section className="detail-launch" data-detail-launch aria-label="快捷启动设置">
            <div className="detail-launch-head">
              <h3>快捷启动</h3>
              <span className="detail-launch-hint">启动方式、全局热键与 Quick 搜索触发词</span>
            </div>

            <div className="detail-launch-row">
              <span className="detail-launch-label">启动方式</span>
              <div className="detail-launch-seg" role="radiogroup" aria-label="启动方式">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!launchCfg?.mode}
                  className={!launchCfg?.mode ? 'active' : ''}
                  disabled={savingLaunch}
                  title="Quick 打开进小窗，主窗打开进大窗"
                  onClick={() => void saveLaunch({ mode: null })}
                >
                  跟随入口
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={launchCfg?.mode === 'quick'}
                  className={launchCfg?.mode === 'quick' ? 'active' : ''}
                  disabled={savingLaunch}
                  title="Quick 与热键唤起时内嵌小窗（输入框下方渲染）"
                  onClick={() => void saveLaunch({ mode: 'quick' })}
                >
                  小窗口
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={launchCfg?.mode === 'shell'}
                  className={launchCfg?.mode === 'shell' ? 'active' : ''}
                  disabled={savingLaunch}
                  title="Quick 与热键唤起时进入主窗大窗 Tab"
                  onClick={() => void saveLaunch({ mode: 'shell' })}
                >
                  大窗口
                </button>
              </div>
            </div>

            <div className="detail-launch-row">
              <span className="detail-launch-label">全局热键</span>
              <div className="detail-launch-hotkey">
                {recording ? (
                  <span className="detail-launch-recording">按下组合键，Esc 取消…</span>
                ) : launchCfg?.hotkey ? (
                  <kbd className="detail-launch-kbd">{formatAccelerator(launchCfg.hotkey)}</kbd>
                ) : (
                  <span className="detail-launch-empty">未设置</span>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={savingLaunch || recording}
                  onClick={startRecording}
                >
                  {launchCfg?.hotkey ? '重新录制' : '录制热键'}
                </button>
                {launchCfg?.hotkey && !recording && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={savingLaunch}
                    onClick={() => void saveLaunch({ hotkey: '' })}
                  >
                    清除
                  </button>
                )}
              </div>
            </div>

            {probeState && (
              <div className="detail-launch-probe" role="alert" data-status={probeState.result.status}>
                <span>{describeProbe(probeState)}</span>
                {probeState.result.takeoverable && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={savingLaunch}
                    onClick={() => void saveLaunch({ hotkey: probeState.acc }, { takeover: true })}
                  >
                    接管并保存
                  </button>
                )}
                {!probeState.result.takeoverable && probeState.result.status !== 'free' && (
                  <button type="button" className="btn btn-ghost" onClick={() => setProbeState(null)}>
                    知道了
                  </button>
                )}
              </div>
            )}

            <div className="detail-launch-row">
              <span className="detail-launch-label">触发词</span>
              <input
                className="detail-launch-aliases"
                type="text"
                value={aliasDraft}
                placeholder="自定义 Quick 搜索触发词，用「、」或空格分隔"
                disabled={savingLaunch}
                onChange={(e) => setAliasDraft(e.target.value)}
                onBlur={commitAliases}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitAliases()
                  }
                }}
              />
            </div>
          </section>
        )}

        <div className="detail-body" data-detail-body>
          <section className="detail-capabilities" aria-label="插件能力与授权">
            <h3>系统与隐私权限</h3>
            <p className="desc">{sensitivePermissions.length ? '以下操作需要你的授权，安装后可在插件设置中管理。' : '此插件未申请系统或隐私权限。'}</p>
            {sensitivePermissions.length > 0 ? (
              <div className="detail-chips">
                {sensitivePermissions.map((permission) => (
                  <span key={permission} className="detail-chip perm" title={permission}>{permissionLabel(permission)}</span>
                ))}
              </div>
            ) : null}
            <PluginBuiltinCapabilities />
          </section>
          {status === 'loading' && (
            <div className="detail-state">
              <div className="detail-spinner" aria-hidden="true" />
              <span>正在加载说明文档…</span>
            </div>
          )}
          {status === 'empty' && (
            <div className="detail-state">
              <strong>暂无说明文档</strong>
              <span>该插件尚未提供 README，可直接安装体验。</span>
            </div>
          )}
          {status === 'error' && (
            <div className="detail-state">
              <strong>加载失败</strong>
              <span>说明文档读取出错，请稍后重试。</span>
            </div>
          )}
          {status === 'ok' && <MarkdownView source={readme} baseUrl={plugin.readmeUrl} imageMap={plugin.readmeImages} />}
        </div>
      </div>
    </div>
  )
}

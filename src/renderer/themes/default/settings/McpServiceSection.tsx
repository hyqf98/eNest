/**
 * McpServiceSection — 设置 → 通用 → MCP 服务管理
 * 启用/端口、运行状态、连接配置复制、令牌重置与已注册工具目录。
 * 仅壳视图可调用（原生 IPC 已校验 sender 角色）；mock 预览不轮询。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { Switch } from '@renderer/components/ui/Switch'
import { Input } from '@renderer/components/ui/Input'
import { useI18n } from '@renderer/hooks/useI18n'
import { isMockShell, shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import type { McpCatalogTool, McpStatus } from '@shared/types/mcpSettings'

const STATE_KEYS: Record<McpStatus['state'], { zh: string; en: string; cls: string }> = {
  disabled: { zh: '未启用', en: 'Disabled', cls: 'mcp-state-off' },
  starting: { zh: '启动中', en: 'Starting', cls: 'mcp-state-warn' },
  running: { zh: '运行中', en: 'Running', cls: 'mcp-state-on' },
  error: { zh: '启动失败', en: 'Error', cls: 'mcp-state-error' },
}

function formatTime(ts: number): string {
  try { return new Date(ts).toLocaleTimeString() } catch { return '—' }
}

export function McpServiceSection() {
  const { t, locale } = useI18n()
  const en = locale === 'en-US'
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [portDraft, setPortDraft] = useState('43921')
  const [busy, setBusy] = useState(false)
  const [tools, setTools] = useState<McpCatalogTool[]>([])
  const [toolsNextCursor, setToolsNextCursor] = useState<string | undefined>(undefined)
  const [toolsLoading, setToolsLoading] = useState(false)
  const wasRunning = useRef(false)
  const revision = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    revision.current++
    return () => { mounted.current = false; revision.current++ }
  }, [])

  const loadTools = useCallback(async (cursor?: string) => {
    setToolsLoading(true)
    try {
      const page = await shellApi.listMcpTools(cursor ? { cursor } : {})
      setTools((prev) => (cursor ? [...prev, ...page.tools] : page.tools))
      setToolsNextCursor(page.nextCursor)
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error))
    } finally {
      setToolsLoading(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    const current = revision.current
    try {
      const next = await shellApi.getMcpStatus()
      if (!mounted.current || current !== revision.current) return
      setStatus(next)
      setLoadError(null)
      setPortDraft(String(next.configuration.port))
      // 服务从关到开（或出错恢复）：目录此前可能不可用，自动重拉工具列表
      const runningNow = next.state === 'running'
      if (runningNow && !wasRunning.current) void loadTools()
      wasRunning.current = runningNow
    } catch (error) {
      if (mounted.current && current === revision.current) setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [loadTools])

  useEffect(() => {
    void refresh()
    if (isMockShell) return
    void loadTools()
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => clearInterval(timer)
  }, [refresh, loadTools])

  const applyConfig = async (enabled: boolean, port: number) => {
    if (busy) return
    setBusy(true)
    try {
      const next = await shellApi.configureMcp({ enabled, port })
      setStatus(next)
      setPortDraft(String(next.configuration.port))
      if (next.state === 'error' && next.error) notify.error(next.error)
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const handleToggle = (checked: boolean) => {
    const port = Math.trunc(Number(portDraft))
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      notify.error(en ? 'Invalid port: enter an integer between 1 and 65535.' : '端口无效：请输入 1–65535 的整数。')
      return
    }
    void applyConfig(checked, port)
  }

  const handleApplyPort = () => {
    const port = Math.trunc(Number(portDraft))
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      notify.error(en ? 'Invalid port: enter an integer between 1 and 65535.' : '端口无效：请输入 1–65535 的整数。')
      void refresh()
      return
    }
    const enabled = status?.configuration.enabled ?? false
    if (enabled && port === status?.configuration.port) return
    void applyConfig(enabled, port)
  }

  const handleCopyConnection = async () => {
    setBusy(true)
    try {
      await shellApi.copyMcpConnectionConfig()
      notify.success(en ? 'Connection config copied to clipboard.' : '连接配置已复制到剪贴板。')
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const stateMeta = status ? STATE_KEYS[status.state] : null
  const running = status?.state === 'running'

  // 按插件分组：插件行可展开/收起，展开后显示工具名与描述
  const groupedTools = useMemo(() => {
    const groups = new Map<string, { pluginName: string; tools: McpCatalogTool[] }>()
    for (const tool of tools) {
      const group = groups.get(tool.pluginId) ?? { pluginName: tool.pluginName || tool.pluginId, tools: [] }
      group.tools.push(tool)
      groups.set(tool.pluginId, group)
    }
    return [...groups.entries()].map(([pluginId, group]) => ({ pluginId, ...group }))
  }, [tools])
  const expandedToolGroups = useRef<Set<string>>(new Set())
  const [toolGroupsRevision, setToolGroupsRevision] = useState(0)
  const toggleToolGroup = (pluginId: string) => {
    const next = expandedToolGroups.current
    if (next.has(pluginId)) next.delete(pluginId)
    else next.add(pluginId)
    setToolGroupsRevision(value => value + 1)
  }

  return (
    <>
      <div className="s-card">
        <div className="mcp-card-head">
          <div className="mcp-card-head-copy">
            <h2>{t('mcp.title')}</h2>
            <p className="hint">{t('mcp.subtitle')}</p>
          </div>
          <div className="mcp-card-head-actions">
            <Switch
              checked={status?.configuration.enabled ?? false}
              onCheckedChange={handleToggle}
              disabled={busy || !status}
              aria-label={t('mcp.enable')}
              title={t('mcp.enable')}
            />
            {stateMeta ? (
              <span className={`mcp-state ${stateMeta.cls}`}>{en ? stateMeta.en : stateMeta.zh}</span>
            ) : <span className="desc">…</span>}
          </div>
        </div>

        {/* 端口与地址只在服务启动后展示；未启用时不暴露空地址。地址与端口同一行。 */}
        {running ? (
          <>
            <div className="mcp-endpoint" role="group" aria-label={t('mcp.endpoint')}>
              <div className="mcp-endpoint-row">
                <span className="mcp-endpoint-label">{t('mcp.endpoint')}</span>
                <code className="mcp-endpoint-value">{status.endpoint}</code>
                <span className="mcp-endpoint-label">{t('mcp.port')}</span>
                <Input
                  className="mcp-port-input"
                  value={portDraft}
                  inputMode="numeric"
                  aria-label={t('mcp.port')}
                  disabled={busy}
                  onChange={(e) => setPortDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
                  onBlur={handleApplyPort}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleApplyPort() }}
                />
                <span className="desc">{t('mcp.portHint')}</span>
              </div>
            </div>

            <div className="mcp-actions">
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleCopyConnection()}>
                {t('mcp.copyConnection')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { void refresh(); void loadTools() }}>
                {t('mcp.refresh')}
              </Button>
            </div>
          </>
        ) : null}

        {status?.state === 'error' && status.error ? (
          <p className="mcp-error">{status.error}</p>
        ) : null}
        {!status && loadError ? <p className="mcp-error">{loadError}</p> : null}

        {/* 已注册工具并入本卡：按插件分组折叠展示，容器限高滚动。 */}
        <div className="mcp-tools-block">
          <div className="dev-card-head">
            <h3 className="mcp-tools-title">{t('mcp.toolsTitle')}</h3>
            <span className="tag">{tools.length}</span>
          </div>
          {running && groupedTools.length > 0 ? (
            <div className="mcp-tool-groups" key={toolGroupsRevision}>
              {groupedTools.map((group) => {
                const expanded = expandedToolGroups.current.has(group.pluginId)
                return (
                  <div className={`mcp-tool-group${expanded ? ' open' : ''}`} key={group.pluginId}>
                    <button
                      type="button"
                      className="mcp-tool-group-head"
                      aria-expanded={expanded}
                      onClick={() => toggleToolGroup(group.pluginId)}
                    >
                      <span className="mcp-tool-group-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                      <strong className="mcp-tool-group-name">{group.pluginName}</strong>
                      <code className="mcp-tool-group-id">{group.pluginId}</code>
                      <span className="tag">{group.tools.length}</span>
                    </button>
                    {expanded ? (
                      <div className="mcp-tool-group-body">
                        {group.tools.map((tool) => (
                          <div className="mcp-tool-item" key={`${tool.pluginId}/${tool.id}`}>
                            <div className="mcp-tool-name">
                              <code>{tool.id}</code>
                              {tool.title ? <span className="desc">{tool.title}</span> : null}
                            </div>
                            {tool.description ? <p className="mcp-tool-desc">{tool.description}</p> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}
          {running && toolsNextCursor ? (
            <Button variant="ghost" size="sm" disabled={toolsLoading} onClick={() => void loadTools(toolsNextCursor)}>
              {t('mcp.toolsMore')}
            </Button>
          ) : null}
        </div>
      </div>

      {status && status.recentCalls.length > 0 ? (
        <div className="s-card">
          <div className="dev-card-head">
            <h2 style={{ margin: 0 }}>{t('mcp.recentCalls')}</h2>
            <span className="tag">{status.recentCalls.length}</span>
          </div>
          <div className="mcp-call-list">
            {status.recentCalls.map((call) => (
              <div className="mcp-call-item" key={call.requestId}>
                <span className="desc">{formatTime(call.startedAt)}</span>
                <code>{call.pluginId} · {call.toolId}</code>
                <span className={`mcp-call-status ${call.status === 'success' ? 'ok' : call.status === 'cancelled' ? 'warn' : 'bad'}`}>
                  {call.status}{call.errorCode ? ` · ${call.errorCode}` : ''}
                </span>
                <span className="desc">{call.durationMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

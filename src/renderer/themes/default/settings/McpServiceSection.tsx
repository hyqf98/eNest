/**
 * McpServiceSection — 设置 → 开发者 → MCP 服务管理
 * 启用/端口、运行状态、连接配置复制、令牌重置与已注册工具目录。
 * 仅壳视图可调用（原生 IPC 已校验 sender 角色）；mock 预览不轮询。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/Button'
import { Switch } from '@renderer/components/ui/Switch'
import { Input } from '@renderer/components/ui/Input'
import { useI18n } from '@renderer/hooks/useI18n'
import { isMockShell, shellApi } from '@renderer/services/shellApi'
import { notify } from '@renderer/services/notifyService'
import { confirmAction } from '@renderer/services/confirmAction'
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
  const revision = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    revision.current++
    return () => { mounted.current = false; revision.current++ }
  }, [])

  const refresh = useCallback(async () => {
    const current = revision.current
    try {
      const next = await shellApi.getMcpStatus()
      if (!mounted.current || current !== revision.current) return
      setStatus(next)
      setLoadError(null)
      setPortDraft(String(next.configuration.port))
    } catch (error) {
      if (mounted.current && current === revision.current) setLoadError(error instanceof Error ? error.message : String(error))
    }
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

  const handleRotateToken = async () => {
    const ok = await confirmAction({
      title: en ? 'Reset MCP token' : '重置 MCP 令牌',
      message: en
        ? 'The old token stops working immediately and existing client sessions are dropped. Copy the new connection config afterwards.'
        : '旧令牌立即失效，现有客户端会话将被断开；之后请重新复制连接配置给客户端。',
      confirmLabel: en ? 'Reset' : '重置',
    })
    if (!ok) return
    setBusy(true)
    try {
      const next = await shellApi.resetMcpToken()
      setStatus(next)
      notify.success(en ? 'Token reset.' : '令牌已重置。')
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const stateMeta = status ? STATE_KEYS[status.state] : null
  const running = status?.state === 'running'

  return (
    <>
      <div className="s-card">
        <h2>{t('mcp.title')}</h2>
        <p className="hint">{t('mcp.subtitle')}</p>

        <div className="mcp-row">
          <span className="mcp-row-label">{t('mcp.enable')}</span>
          <Switch
            checked={status?.configuration.enabled ?? false}
            onCheckedChange={handleToggle}
            disabled={busy || !status}
            aria-label={t('mcp.enable')}
          />
          {stateMeta ? (
            <span className={`mcp-state ${stateMeta.cls}`}>
              {en ? stateMeta.en : stateMeta.zh}
              {status && status.state !== 'disabled' ? ` · ${status.endpoint}` : ''}
            </span>
          ) : <span className="desc">…</span>}
        </div>

        <div className="mcp-row">
          <span className="mcp-row-label">{t('mcp.port')}</span>
          <Input
            className="mcp-port-input"
            value={portDraft}
            inputMode="numeric"
            aria-label={t('mcp.port')}
            disabled={busy || !status}
            onChange={(e) => setPortDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
            onBlur={handleApplyPort}
            onKeyDown={(e) => { if (e.key === 'Enter') handleApplyPort() }}
          />
          <span className="desc">{t('mcp.portHint')}</span>
        </div>

        {status?.state === 'error' && status.error ? (
          <p className="mcp-error">{status.error}</p>
        ) : null}
        {!status && loadError ? <p className="mcp-error">{loadError}</p> : null}

        {status && status.state !== 'disabled' ? (
          <div className="mcp-row mcp-counters">
            <span className="desc">{t('mcp.sessions')}: {status.sessionCount}</span>
            <span className="desc">{t('mcp.activeCalls')}: {status.activeCalls}</span>
          </div>
        ) : null}

        <div className="mcp-actions">
          <Button variant="ghost" size="sm" disabled={!running || busy} onClick={() => void handleCopyConnection()}>
            {t('mcp.copyConnection')}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy || !status?.configuration.enabled} onClick={() => void handleRotateToken()}>
            {t('mcp.rotateToken')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { void refresh(); void loadTools() }}>
            {t('mcp.refresh')}
          </Button>
        </div>
      </div>

      <div className="s-card">
        <div className="dev-card-head">
          <h2 style={{ margin: 0 }}>{t('mcp.toolsTitle')}</h2>
          <span className="tag">{tools.length}</span>
        </div>
        <p className="hint">{t('mcp.toolsHint')}</p>
        {!isMockShell && tools.length === 0 && !toolsLoading ? (
          <p className="desc">{t('mcp.toolsEmpty')}</p>
        ) : null}
        {tools.length > 0 ? (
          <div className="mcp-tool-list">
            {tools.map((tool) => (
              <div className="mcp-tool-item" key={`${tool.pluginId}/${tool.id}`}>
                <div className="mcp-tool-name">
                  <code>{tool.pluginId} · {tool.id}</code>
                  {tool.title ? <span className="desc">{tool.title}</span> : null}
                </div>
                {tool.description ? <p className="mcp-tool-desc">{tool.description}</p> : null}
              </div>
            ))}
          </div>
        ) : null}
        {toolsNextCursor ? (
          <Button variant="ghost" size="sm" disabled={toolsLoading} onClick={() => void loadTools(toolsNextCursor)}>
            {t('mcp.toolsMore')}
          </Button>
        ) : null}
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

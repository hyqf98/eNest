import { useEffect, useRef, useState } from 'react'
import type { FileSearchPreferenceRequest, FileSearchPreferences } from '@shared/types/fileSearch'
import { Button } from '@renderer/components/ui/Button'
import { Switch } from '@renderer/components/ui/Switch'
import { Input } from '@renderer/components/ui/Input'
import { IS_WINDOWS } from '@shared/platform'
import { useI18n } from '@renderer/hooks/useI18n'
import { shellApi } from '@renderer/services/shellApi'
import { Field } from './SettingsFields'
import '@renderer/themes/default/fileSearch.css'

export function FileSearchSettings() {
  const english = useI18n().locale === 'en-US', label = english ? 'File search' : '文件检索'
  const [preferences, setPreferences] = useState<FileSearchPreferences>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [port, setPort] = useState('')
  const validPort = /^\d{1,5}$/u.test(port) && Number(port) >= 1 && Number(port) <= 65535
  useEffect(() => { setPort(preferences?.everythingPort?.toString() ?? '') }, [preferences?.everythingPort])
  const revision = useRef(0)
  useEffect(() => {
    const read = () => {
      const token = ++revision.current
      void shellApi.fileSearchPreferences?.({ operation: 'read' }).then(value => { if (token === revision.current) { setPreferences(value); setError('') } })
        .catch(() => { if (token === revision.current) { setPreferences(undefined); setError(english ? 'File search settings are unavailable.' : '暂时无法读取文件检索设置。') } })
    }
    read(); const off = shellApi.onEvent?.(event => { if (event.type === 'settings-changed' && event.generalKeys.some(key => key === 'fileSearch' || key === 'dataRoot')) read() })
    return () => { revision.current++; off?.() }
  }, [english])
  const update = async (request: FileSearchPreferenceRequest) => {
    if (busy || !shellApi.fileSearchPreferences) return
    setBusy(true); setError('')
    try { setPreferences(await shellApi.fileSearchPreferences(request)) }
    catch { setError(english ? 'Could not save. Select a specific folder, not your home or an entire disk.' : '未能保存设置；请选择具体的文件夹，不能选择整个用户目录或磁盘。') }
    finally { setBusy(false) }
  }
  return <><Field label={label} desc={english ? 'Include a separate Files group in Quick and Home. Searches names only; no plugin is required.' : '在小窗口与桌面页单独显示文件分组。只查文件名，无需安装 Anything。'}>
    <Switch aria-label={label} checked={preferences?.enabled ?? false} disabled={!preferences || busy} onCheckedChange={value => void update({ operation: 'enable', value })} />
  </Field>{IS_WINDOWS && preferences?.enabled && <Field label={english ? 'Everything HTTP (optional)' : 'Everything HTTP（可选）'} desc={english ? 'Only the port you choose on 127.0.0.1 is used. No credentials. Falls back to Windows Search if unavailable.' : '仅连接 127.0.0.1 上你指定的端口，不传账号密码。不可用时自动回退 Windows Search。'}>
    <div className="file-search-settings-roots"><div><code>127.0.0.1 :</code><Input className="file-search-port" type="number" aria-label={english ? 'Local Everything port' : '本机 Everything 端口'} placeholder={english ? 'Port' : '端口'} min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} />
      <Button size="sm" variant="ghost" disabled={busy || !validPort || Number(port) === preferences.everythingPort} onClick={() => void update({ operation: 'everything', port: Number(port) })}>{preferences.everythingPort ? english ? 'Apply' : '应用' : english ? 'Enable' : '启用'}</Button>
      {preferences.everythingPort && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update({ operation: 'everything', port: null })}>{english ? 'Disable' : '停用'}</Button>}</div></div>
  </Field>}{preferences?.enabled && <Field label={english ? 'Fallback folders' : '备用检索目录'} desc={english ? 'Used only without a system index. A bounded, temporary name cache never reads file contents.' : '仅在系统索引不可用时按需读取所选目录。文件名只在内存限量缓存，不读取文件内容。'}>
    <div className="file-search-settings-roots">{preferences.roots.map((root, index) => <div key={root}><code dir="auto">{root}</code><Button size="sm" variant="ghost" disabled={busy} onClick={() => void update({ operation: 'remove-root', index })}>{english ? 'Remove' : '移除'}</Button></div>)}
      <div><Button size="sm" variant="ghost" disabled={busy || preferences.roots.length >= 8} onClick={() => void update({ operation: 'add-root' })}>{english ? 'Choose folder…' : '选择文件夹…'}</Button>{preferences.roots.length > 0 && <><Button size="sm" variant="ghost" disabled={busy} onClick={() => void update({ operation: 'pause', value: !preferences.paused })}>{preferences.paused ? english ? 'Resume fallback' : '恢复备用检索' : english ? 'Pause fallback' : '暂停备用检索'}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void update({ operation: 'clear' })}>{english ? 'Clear cache' : '清理缓存'}</Button></>}</div>
    </div></Field>}{error && <p role="alert">{error}</p>}</>
}

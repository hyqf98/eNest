import { useI18n } from '@renderer/hooks/useI18n'
import { Select } from '@renderer/components/ui/Select'
import { Switch } from '@renderer/components/ui/Switch'
import { Segmented } from '@renderer/components/ui/Segmented'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { ReleaseNotes } from '@renderer/components/ReleaseNotes'
import { availableUpdateVersion } from '@shared/updateAvailability'
import { LanguageSelect } from './LanguageSelect'
import { FileSearchSettings } from './FileSearchSettings'
import { Card, Field } from './SettingsFields'
import type { NotifyPosition, useGeneralSettings } from './useGeneralSettings'
import type { useSettingsUpdates } from './useSettingsUpdates'

export function GeneralSettingsSection({ settings, updates }: {
  settings: ReturnType<typeof useGeneralSettings>
  updates: ReturnType<typeof useSettingsUpdates>
}) {
  const { t, locale } = useI18n()
  const {
    hwAccel, launchAtLogin, launchAtLoginSupported, launchAtLoginError, dataRoot, closeBehavior, notifyPosition, loadingGeneral,
    proxyType, proxyHost, proxyPort, testingProxy, setProxyHost, setProxyPort,
    pendingRoot, migrating, pickNewDataRoot, cancelMigrate, handleMigrate,
    handleLocale, handleHwAccel, handleLaunchAtLogin, handleCloseBehavior, handleNotifyPosition,
    handleProxyType, handleProxyFieldBlur, handleTestProxy, handleOpenDataRoot
  } = settings
  const { updateState, checkingUpdate, openUpdateDialog, handleCheckUpdate, handleInstallUpdate } = updates
  const version = availableUpdateVersion(updateState)
  const checking = checkingUpdate || updateState?.status === 'checking'
  return (
    <Card title={t('settings.general.title')}>
      <Field label={t('settings.general.language')}>
        <LanguageSelect value={locale} onChange={handleLocale} />
      </Field>
      <FileSearchSettings />
      <Field label={t('settings.general.hardwareAccel')} desc={t('settings.general.hardwareAccelDesc')}>
        <Switch checked={hwAccel} onCheckedChange={handleHwAccel} aria-label={t('settings.general.hardwareAccel')} />
      </Field>
      <Field
        label={t('settings.general.launchAtLogin')}
        desc={launchAtLoginError
          ? t('settings.general.launchAtLoginErrorDesc', { error: launchAtLoginError })
          : launchAtLoginSupported
            ? t('settings.general.launchAtLoginDesc')
            : t('settings.general.launchAtLoginUnsupportedDesc')}
      >
        <Switch
          checked={launchAtLogin}
          disabled={!launchAtLoginSupported}
          onCheckedChange={handleLaunchAtLogin}
          aria-label={t('settings.general.launchAtLogin')}
        />
      </Field>
      {/* 选好新目录后进入待迁移态：此时设置未变，点「迁移数据」才真正搬数据并切根 */}
      <Field
        label={t('settings.general.dataRoot')}
        desc={pendingRoot ? t('settings.general.migratePending') : t('settings.general.dataRootDesc')}
      >
        <div className="data-root-control">
          <code className="path-text" title={dataRoot}>
            {loadingGeneral ? t('common.loading') : dataRoot || '—'}
          </code>
          {pendingRoot && (
            <code className="path-text data-root-target" title={pendingRoot}>
              <span aria-hidden="true">→</span> {pendingRoot}
            </code>
          )}
          <div className="path-actions">
            {pendingRoot ? (
              <>
                <Button variant="ghost" size="sm" onClick={cancelMigrate} disabled={migrating}>
                  {t('settings.general.cancelChange')}
                </Button>
                <Button variant="primary" size="sm" onClick={handleMigrate} disabled={migrating} aria-busy={migrating}>
                  {migrating ? t('settings.general.migrating') : t('settings.general.migrateAction')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={handleOpenDataRoot} disabled={!dataRoot}>
                  {t('settings.general.openFolder')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void pickNewDataRoot()} disabled={loadingGeneral || !dataRoot}>
                  {t('settings.general.changeFolder')}
                </Button>
              </>
            )}
          </div>
        </div>
      </Field>
      {settings.hasLegacyCanvas && <Field label={locale === 'en-US' ? 'Previous canvas layout' : '旧版画布布局'}
        desc={locale === 'en-US' ? 'Export the layout, then import it in the optional Free Canvas plugin. Your original data stays here.' : '可导出布局，再到「自由画布」插件中导入。不会移动或删除原数据。'}>
        <Button variant="ghost" size="sm" onClick={() => void settings.exportLegacyCanvas()}>{locale === 'en-US' ? 'Export JSON' : '导出 JSON'}</Button>
      </Field>}
      <Field label={t('settings.general.closeBehavior')}>
        <Select
          ariaLabel={t('settings.general.closeBehavior')}
          value={closeBehavior}
          onChange={handleCloseBehavior}
          minWidth={160}
          options={[
            { value: 'minimize-tray', label: t('settings.general.minimizeToTray') },
            { value: 'quit', label: t('settings.general.quitApp') },
          ]}
        />
      </Field>
      <Field label={t('settings.general.notifyPosition')} desc={t('settings.general.notifyPositionDesc')}>
        <Segmented
          className="notify-pos-seg"
          ariaLabel={t('settings.general.notifyPosition')}
          value={notifyPosition}
          onChange={handleNotifyPosition}
          options={[
            {
              value: 'center' as NotifyPosition,
              label: <>
                <span className="notify-pos-icon center-icon" aria-hidden="true"><i /><i /></span>
                {t('settings.general.notifyPositionCenter')}
              </>
            },
            {
              value: 'bottom-right' as NotifyPosition,
              label: <>
                <span className="notify-pos-icon corner-icon" aria-hidden="true"><i /><i /><i /></span>
                {t('settings.general.notifyPositionCorner')}
              </>
            }
          ]}
        />
      </Field>
      <Field label={t('settings.general.proxy')}>
        <div className="proxy-row">
          <Select
            value={proxyType}
            onChange={handleProxyType}
            minWidth={132}
            ariaLabel={t('settings.general.proxyType')}
            options={[
              { value: 'system', label: t('settings.general.proxySystem') },
              { value: 'none', label: t('settings.general.proxyNone') },
              { value: 'http', label: t('settings.general.proxyHttp') },
            ]}
          />
          {proxyType === 'http' ? (
            <>
              <Input
                className="proxy-host"
                value={proxyHost}
                placeholder={t('settings.general.proxyHostPlaceholder')}
                aria-label={t('settings.general.proxyHost')}
                onChange={(e) => setProxyHost(e.target.value)}
                onBlur={handleProxyFieldBlur}
              />
              <Input
                className="proxy-port"
                value={proxyPort}
                placeholder={t('settings.general.proxyPortPlaceholder')}
                aria-label={t('settings.general.proxyPort')}
                inputMode="numeric"
                onChange={(e) => setProxyPort(e.target.value.replace(/[^\d]/g, ''))}
                onBlur={handleProxyFieldBlur}
              />
            </>
          ) : null}
          <Button variant="ghost" size="sm" onClick={handleTestProxy} disabled={testingProxy || proxyType === 'none'}>
            {testingProxy ? t('settings.general.proxyTesting') : t('settings.general.proxyTest')}
          </Button>
        </div>
      </Field>
      <Field
        label={t('settings.general.updates')}
        desc={
          updateState?.status === 'downloading'
            ? t('settings.general.updateDownloading', {
                progress: String(updateState.progress ?? 0)
              })
            : updateState?.status === 'downloaded'
              ? t('settings.general.updateReadyDesc', {
                  version: updateState.latestVersion ?? ''
                })
              : updateState?.status === 'available'
                ? t('settings.general.updateAvailableDesc', {
                    version: updateState.latestVersion ?? ''
                  })
                : t('settings.general.currentVersion', { version: updateState?.currentVersion ?? '—' })
        }
      >
        <div className="path-actions">
          <Button variant="ghost" size="sm" onClick={handleCheckUpdate} disabled={checking || updateState?.status === 'downloading'}>
            {checking ? t('settings.general.checkingUpdate') : t('settings.general.checkUpdate')}
          </Button>
          {version && (
            <Button variant="ghost" size="sm" onClick={openUpdateDialog}>
              {t('settings.general.updateOptions')}
            </Button>
          )}
          {updateState?.status === 'downloaded' && (
            <Button variant="primary" size="sm" onClick={handleInstallUpdate}>
              {t('settings.general.installUpdate')}
            </Button>
          )}
        </div>
      </Field>
      {version && <div key={version} className="settings-release-notes">
        <div className="settings-release-notes-heading">
          <h3 id="settings-release-notes-title">{t('update.dialog.notesTitle')}</h3>
          <span>v{version}</span>
        </div>
        <div className="settings-release-notes-body" role="region" aria-labelledby="settings-release-notes-title" tabIndex={0}>
          <ReleaseNotes source={updateState?.releaseNotes} fallback={<p className="desc">{t('update.dialog.notesEmpty')}</p>} />
        </div>
      </div>}
    </Card>
  )
}

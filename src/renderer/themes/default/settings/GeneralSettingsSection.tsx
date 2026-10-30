import { useI18n } from '@renderer/hooks/useI18n'
import { Select } from '@renderer/components/ui/Select'
import { Switch } from '@renderer/components/ui/Switch'
import { Segmented } from '@renderer/components/ui/Segmented'
import { Button } from '@renderer/components/ui/Button'
import { Input } from '@renderer/components/ui/Input'
import { LanguageSelect } from './LanguageSelect'
import { Card, Field } from './SettingsFields'
import type { NotifyPosition, useGeneralSettings } from './useGeneralSettings'
import type { useSettingsUpdates } from './useSettingsUpdates'

export function GeneralSettingsSection({ settings, updates }: {
  settings: ReturnType<typeof useGeneralSettings>
  updates: ReturnType<typeof useSettingsUpdates>
}) {
  const { t, locale } = useI18n()
  const {
    hwAccel, dataRoot, closeBehavior, notifyPosition, loadingGeneral,
    proxyType, proxyHost, proxyPort, testingProxy, setProxyHost, setProxyPort,
    handleLocale, handleHwAccel, handleCloseBehavior, handleNotifyPosition,
    handleProxyType, handleProxyFieldBlur, handleTestProxy, handleOpenDataRoot
  } = settings
  const { updateState, checkingUpdate, openUpdateDialog, handleCheckUpdate, handleInstallUpdate } = updates
  return (
    <Card title={t('settings.general.title')}>
      <Field label={t('settings.general.language')}>
        <LanguageSelect value={locale} onChange={handleLocale} />
      </Field>
      <Field label={t('settings.general.hardwareAccel')} desc={t('settings.general.hardwareAccelDesc')}>
        <Switch checked={hwAccel} onCheckedChange={handleHwAccel} aria-label={t('settings.general.hardwareAccel')} />
      </Field>
      <Field label={t('settings.general.dataRoot')}>
        <div className="path-actions">
          <code className="path-text" title={dataRoot}>
            {loadingGeneral ? t('common.loading') : dataRoot || '—'}
          </code>
          <Button variant="ghost" size="sm" onClick={handleOpenDataRoot} disabled={!dataRoot}>
            {t('settings.general.openFolder')}
          </Button>
        </div>
      </Field>
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
                : `${locale === 'en-US' ? 'Version' : '当前版本'} ${updateState?.currentVersion ?? '—'}`
        }
      >
        <div className="path-actions">
          <Button variant="ghost" size="sm" onClick={handleCheckUpdate} disabled={checkingUpdate || updateState?.status === 'downloading'}>
            {checkingUpdate || updateState?.status === 'checking'
              ? t('settings.general.checkingUpdate')
              : t('settings.general.checkUpdate')}
          </Button>
          {(updateState?.status === 'available' || updateState?.status === 'downloaded') && (
            <Button variant="ghost" size="sm" onClick={openUpdateDialog}>
              {t('settings.general.viewUpdateNotes')}
            </Button>
          )}
          {updateState?.status === 'downloaded' && (
            <Button variant="primary" size="sm" onClick={handleInstallUpdate}>
              {t('settings.general.installUpdate')}
            </Button>
          )}
        </div>
      </Field>
    </Card>
  )
}

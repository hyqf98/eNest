/** Trusted-shell adapter; the default theme imports only PluginCardView. */
import { shellApi } from '@renderer/services/shellApi'
import { confirmAction } from '@renderer/services/confirmAction'
import { useI18n } from '@renderer/hooks/useI18n'
import { PluginCardView, type PluginCardViewProps } from './PluginCardView'

type Props = Pick<PluginCardViewProps, 'plugin' | 'onOpen' | 'onDetail'>

export function PluginCard(props: Props) {
  const { t } = useI18n()
  return <PluginCardView {...props}
    onUninstall={shellApi.uninstallPlugin ? async id => {
      if (!await confirmAction({ title: t('plugin.uninstall'), message: t('plugin.uninstallConfirm', { name: props.plugin.name }), confirmLabel: t('plugin.uninstall'), danger: true })) return
      await shellApi.uninstallPlugin!(id)
    } : undefined}
    onSetEnabled={shellApi.setPluginEnabled ? async (id, enabled) => { await shellApi.setPluginEnabled!(id, enabled) } : undefined} />
}

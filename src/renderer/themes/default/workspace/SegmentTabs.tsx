/**
 * SegmentTabs — 市场「浏览 / 已安装」分段切换
 * 受控组件；value 为 shellStore.Seg，onChange 写回 shellStore.setSeg。
 */
import { useI18n } from '@renderer/hooks/useI18n'
import { Segmented } from '@renderer/components/ui/Segmented'
import type { Seg } from '@renderer/stores/shellStore'

interface Props {
  value: Seg
  onChange: (s: Seg) => void
}

export function SegmentTabs({ value, onChange }: Props) {
  const { t } = useI18n()
  return (
    <Segmented
      value={value}
      onChange={onChange}
      ariaLabel={t('market.browse')}
      options={[
        { value: 'browse' as Seg, label: t('market.browse') },
        { value: 'installed' as Seg, label: t('market.installed') },
      ]}
    />
  )
}

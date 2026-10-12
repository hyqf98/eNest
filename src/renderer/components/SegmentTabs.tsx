/**
 * SegmentTabs — 市场「浏览 / 已安装」分段切换
 * 受控组件；value 为 shellStore.Seg，onChange 写回 shellStore.setSeg。
 */
import { useI18n } from '@renderer/hooks/useI18n'
import type { Seg } from '@renderer/stores/shellStore'

interface Props {
  value: Seg
  onChange: (s: Seg) => void
}

export function SegmentTabs({ value, onChange }: Props) {
  const { t } = useI18n()
  return (
    <div className="segmented" role="group" aria-label={t('market.browse')}>
      <button type="button" aria-pressed={value === 'browse'} className={value === 'browse' ? 'active' : ''} onClick={() => onChange('browse')}>
        {t('market.browse')}
      </button>
      <button type="button" aria-pressed={value === 'installed'} className={value === 'installed' ? 'active' : ''} onClick={() => onChange('installed')}>
        {t('market.installed')}
      </button>
    </div>
  )
}

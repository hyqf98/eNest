/**
 * AnimationSettingsSection — 设置页「动画效果」三档（低 / 中 / 高）
 * 受控分段选择；变更即时写入设置并同步 root[data-anim] 与 GSAP。
 * 依赖：useAnimationLevel、useI18n。
 */
import { useAnimationLevel } from '@renderer/hooks/useAnimationLevel'
import { useI18n } from '@renderer/hooks/useI18n'
import type { AnimationLevel } from '@shared/types/plugin'

const LEVELS: { value: AnimationLevel; labelKey: string; descKey: string }[] = [
  { value: 'low', labelKey: 'settings.animation.levelLow', descKey: 'settings.animation.levelLowDesc' },
  { value: 'medium', labelKey: 'settings.animation.levelMedium', descKey: 'settings.animation.levelMediumDesc' },
  { value: 'high', labelKey: 'settings.animation.levelHigh', descKey: 'settings.animation.levelHighDesc' },
]

export function AnimationSettingsSection() {
  const { level, setLevel } = useAnimationLevel()
  const { t } = useI18n()
  const active = LEVELS.find((l) => l.value === level) ?? LEVELS[1]

  return (
    <div className="s-card anim-settings">
      <h2>{t('settings.animation.title')}</h2>
      <p className="hint">{t('settings.animation.hint')}</p>
      <div className="field">
        <div>
          <div className="label">{t('settings.animation.level')}</div>
          <p className="desc">{t(active.descKey)}</p>
        </div>
        <div className="segmented anim-level-seg" role="group" aria-label={t('settings.animation.level')}>
          {LEVELS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={level === opt.value ? 'active' : ''}
              onClick={() => void setLevel(opt.value)}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * ThemeModeSelect — 主题模式选择 + 已安装主题包下拉
 * 三态：浅色 | 深色 | 跟随系统；主题包列表为空时下拉禁用。
 * 由 ThemeSettingsSection 挂载；回调写入 useTheme。
 * 依赖：useTheme（THEME_MODE_LABELS）、@shared/types/plugin。
 */
import type { ThemeMode, ThemePack } from '@shared/types/plugin'
import { THEME_MODE_LABELS } from '@renderer/hooks/useTheme'

interface Props {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  packs: ThemePack[]
  packId: string | null
  onSetMode: (m: ThemeMode) => void
  onApplyPack: (packId: string | null) => void
}

const MODE_ORDER: ThemeMode[] = ['light', 'dark', 'system']

const MODE_HINTS: Record<ThemeMode, string> = {
  light: '明亮日间',
  dark: '深邃工作台',
  system: '随系统自动切换',
}

export function ThemeModeSelect({ mode, resolved, packs, packId, onSetMode, onApplyPack }: Props) {
  const hasPacks = packs.length > 0

  return (
    <div className="s-card">
      <h2>主题模式</h2>
      <p className="hint">
        跟随系统时当前生效
        <strong style={{ marginLeft: 4 }}>{resolved === 'dark' ? '深色' : '浅色'}</strong>
      </p>
      <div className="theme-row">
        {MODE_ORDER.map((m) => (
          <button
            key={m}
            type="button"
            className={`theme-card${mode === m ? ' active' : ''}`}
            onClick={() => onSetMode(m)}
          >
            <div className="sw">
              {m === 'system' ? (
                <>
                  <i style={{ background: '#f3f4f6' }} />
                  <i style={{ background: '#0d1118' }} />
                </>
              ) : (
                (
                  ['--bg', '--surface', '--accent', '--text'] as const
                ).map((k) => {
                  const preset =
                    m === 'light'
                      ? { '--bg': '#f3f4f6', '--surface': '#ffffff', '--accent': '#1a1f2e', '--text': '#0f1420' }
                      : { '--bg': '#0d1118', '--surface': '#161b24', '--accent': '#e8ecf4', '--text': '#f3f5f9' }
                  return <i key={k} style={{ background: preset[k] }} />
                })
              )}
            </div>
            <strong>{THEME_MODE_LABELS[m]}</strong>
            <span>{MODE_HINTS[m]}</span>
          </button>
        ))}
      </div>

      <div className="field" style={{ borderTop: 'none', paddingBottom: 0 }}>
        <div>
          <div className="label">主题包</div>
          <p className="desc">
            {hasPacks ? '由主题插件安装后出现在此处' : '暂无已安装主题包，可从市场安装主题插件'}
          </p>
        </div>
        <select
          aria-label="主题包"
          value={packId ?? ''}
          disabled={!hasPacks}
          onChange={(e) => onApplyPack(e.target.value || null)}
        >
          <option value="">默认配色</option>
          {packs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

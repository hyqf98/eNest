/**
 * ThemeTokenEditor — 颜色 Token 编辑器（友好中文名 + 高级变量名）
 * 展示可编辑 CSS 变量色板与重置；模式/主题包在 ThemeModeSelect，背景在 BackgroundPicker。
 * 由 ThemeSettingsSection 组合挂载；回调经 useTheme 即时写入 DOM 与 shellApi。
 * 依赖：useTheme（EDITABLE_TOKENS / normalizeHex）。
 */
import { EDITABLE_TOKENS, normalizeHex } from '../hooks/useTheme'

interface Props {
  tokens: Record<string, string>
  onSetToken: (key: string, value: string) => void
  onReset: () => void
}

export function ThemeTokenEditor({ tokens, onSetToken, onReset }: Props) {
  return (
    <div className="s-card">
      <h2>颜色微调</h2>
      <p className="hint">修改立即作用于整个壳子；色块下为高级 CSS 变量名</p>
      <div className="token-grid">
        {EDITABLE_TOKENS.map((t) => {
          const raw = tokens[t.key]
          const v = normalizeHex(typeof raw === 'string' && raw.startsWith('#') ? raw : '#1a1f2e')
          return (
            <div className="token-box" key={t.key}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 550 }}>{t.label}</div>
                <code>{t.key}</code>
              </div>
              <div className="right">
                <span className="stars">{v}</span>
                <span className="swatch" style={{ background: v }} />
              </div>
              <input
                type="color"
                value={v}
                aria-label={t.label}
                onChange={(e) => onSetToken(t.key, e.target.value)}
              />
            </div>
          )
        })}
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onReset}>
          重置颜色
        </button>
      </div>
    </div>
  )
}

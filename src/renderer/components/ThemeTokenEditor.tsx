/**
 * ThemeTokenEditor — 颜色 Token 编辑器（友好中文名 + 色卡弹层）
 * 点击色块打开 react-colorful 色卡；色板即时写入 DOM 与 shellApi。
 * 由 ThemeSettingsSection 组合挂载。
 * 依赖：useTheme（EDITABLE_TOKENS / normalizeHex）、ColorPickerField。
 */
import { EDITABLE_TOKENS, normalizeHex } from '@renderer/hooks/useTheme'
import { ColorPickerField } from '@renderer/components/ColorPickerField'

interface Props {
  tokens: Record<string, string>
  onSetToken: (key: string, value: string) => void
  onReset: () => void
}

export function ThemeTokenEditor({ tokens, onSetToken, onReset }: Props) {
  return (
    <div className="s-card">
      <h2>颜色微调</h2>
      <p className="hint">点击色块打开色卡，修改立即作用于整个壳子</p>
      <div className="token-grid">
        {EDITABLE_TOKENS.map((t) => {
          const raw = tokens[t.key]
          const v = normalizeHex(typeof raw === 'string' && raw.startsWith('#') ? raw : '#64748b')
          return (
            <div className="token-box" key={t.key}>
              <div className="token-meta">
                <div className="token-label">{t.label}</div>
                <code>{t.key}</code>
              </div>
              <div className="token-right">
                <span className="token-hex">{v}</span>
                <ColorPickerField
                  value={v}
                  label={t.label}
                  onChange={(hex) => onSetToken(t.key, hex)}
                />
              </div>
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

/**
 * ColorPickerField — 带色卡弹层的颜色选择
 * 基于 react-colorful（轻量无依赖）；点击色块打开 SV 面板 + 色相条 + hex 输入。
 * 关闭：点外部 / Esc。透明色（rgba）回退为 #RRGGBB 展示。
 */
import { useEffect, useRef, useState } from 'react'
import { HexColorPicker, HexColorInput } from 'react-colorful'
import { normalizeHex } from '@renderer/hooks/useTheme'

interface Props {
  value: string
  onChange: (hex: string) => void
  label: string
}

export function ColorPickerField({ value, onChange, label }: Props) {
  const [open, setOpen] = useState(false)
  const hex = normalizeHex(value.startsWith('#') ? value : '#64748b')
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="color-field" ref={wrapRef}>
      <button
        type="button"
        className={`color-swatch-btn${open ? ' open' : ''}`}
        aria-label={`选择${label}颜色`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="color-swatch-face" style={{ background: hex }} />
      </button>
      {open && (
        <div className="color-pop" role="dialog" aria-label={label}>
          <HexColorPicker color={hex} onChange={onChange} />
          <div className="color-pop-row">
            <span className="color-pop-label">#</span>
            <HexColorInput
              color={hex}
              onChange={onChange}
              prefixed={false}
              className="color-hex-input"
              aria-label={`${label} hex`}
            />
          </div>
        </div>
      )}
    </div>
  )
}

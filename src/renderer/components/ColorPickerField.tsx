/**
 * ColorPickerField — 带色卡弹层的颜色选择
 * 基于 react-colorful（轻量无依赖）；点击色块打开 SV 面板 + 色相条 + hex 输入。
 * 关闭：点外部 / Esc。透明色（rgba）回退为 #RRGGBB 展示。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HexColorPicker, HexColorInput } from 'react-colorful'
import { colorWithPreservedAlpha, normalizeHex } from '@renderer/services/themeResources'
import { useAnchoredPopover } from './useAnchoredPopover'
import './select.css'

interface Props {
  value: string
  onChange: (hex: string) => void
  label: string
  disabled?: boolean
  preserveAlpha?: boolean
  onCommit?: () => void
  /** compact：色板网格模式——色块下带标签，不显示 hex 行 */
  compact?: boolean
}

export function ColorPickerField({ value, onChange, label, disabled, preserveAlpha, onCommit, compact }: Props) {
  const [open, setOpen] = useState(false)
  const wasOpen = useRef(false)
  const hex = normalizeHex(value)
  const change = (next: string) => { if (!disabled) onChange(preserveAlpha ? colorWithPreservedAlpha(value, next) : next) }
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPopover(open, triggerRef, panelRef, 240, 300)

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (wasOpen.current && !open) onCommit?.()
    wasOpen.current = open
  }, [open, onCommit])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: Event) => {
      if (!wrapRef.current?.contains(e.target as Node) && !panelRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus({ preventScroll: true })
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onDoc)
    panelRef.current?.querySelector<HTMLElement>('[tabindex="0"], input')?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onDoc)
    }
  }, [open])

  return (
    <div className={`color-field${compact ? ' color-field-compact' : ''}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`color-swatch-btn${open ? ' open' : ''}`}
        aria-label={`选择${label}颜色`}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="color-swatch-face" style={{ background: hex }} />
      </button>
      {compact && <span className="color-swatch-caption" title={label}>{label}</span>}
      {open && createPortal(
        <div ref={panelRef} className="color-pop color-pop-portal" role="dialog" aria-label={label} style={position}>
          <HexColorPicker color={hex} onChange={change} />
          <div className="color-pop-row">
            <span className="color-pop-label">#</span>
            <HexColorInput
              color={hex}
              onChange={change}
              prefixed={false}
              className="color-hex-input"
              aria-label={`${label} hex`}
            />
          </div>
        </div>, document.body
      )}
    </div>
  )
}

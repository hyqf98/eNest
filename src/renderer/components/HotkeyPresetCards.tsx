/**
 * HotkeyPresetCards — 快捷启动触发键：三张卡片（互斥）
 * 预设 A/B 固定组合，自定义可录。点击卡片设为「当前唯一生效」；仅生效键会被全局注册。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { shellApi } from '@renderer/services/shellApi'

const CODE_TO_KEY: Record<string, string> = {
  Space: 'Space',
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/'
}

/** Electron accelerator 字面量（注册用 Control，不是 Ctrl） */
const PRESET_A = 'Alt+Space'
const PRESET_B = 'Control+Space'

function isModifier(code: string): boolean {
  return /^(Meta|Control|Alt|Shift)(Left|Right)?$/.test(code)
}

function eventToAccelerator(e: KeyboardEvent, platform: string): string | null {
  if (isModifier(e.code)) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push(platform === 'darwin' ? 'Command' : 'Super')
  let key = CODE_TO_KEY[e.code]
  if (!key) {
    if (/^Key([A-Z])$/.test(e.code)) key = e.code.slice(3)
    else if (/^Digit(\d)$/.test(e.code)) key = e.code.slice(5)
    else if (/^Numpad(\d)$/.test(e.code)) key = `num${e.code.slice(6)}`
    else if (/^F\d{1,2}$/.test(e.code)) key = e.code
    else return null
  }
  return [...mods, key].join('+')
}

function formatAcc(acc: string): string {
  return acc
    .split('+')
    .map((p) => {
      switch (p) {
        case 'Control':
          return 'Ctrl'
        case 'Command':
          return '⌘'
        case 'Super':
          return 'Win'
        case 'Shift':
          return '⇧'
        default:
          return p
      }
    })
    .join(' + ')
}

type Slots = { a: string; b: string; c: string | null }

function slotsFromHotkeys(hotkeys: string[]): Slots {
  const rest = hotkeys.filter((h) => h !== PRESET_A && h !== PRESET_B)
  return {
    a: hotkeys.includes(PRESET_A) ? PRESET_A : '',
    b: hotkeys.includes(PRESET_B) ? PRESET_B : '',
    c: rest[0] ?? null
  }
}

/** 加载时补齐缺失的 A/B 默认值，避免设置里只有 Alt+Space 导致 B 槽空白 */
function withDefaultPresets(hotkeys: string[]): string[] {
  const next = [...hotkeys]
  if (!next.includes(PRESET_A)) next.unshift(PRESET_A)
  if (!next.includes(PRESET_B)) next.push(PRESET_B)
  return next
}

function hotkeysFromSlots(s: Slots): string[] {
  return [s.a, s.b, s.c].filter((x): x is string => !!x)
}

function HotkeyCard({
  acc,
  slotLabel,
  active,
  recording,
  locked,
  onCardClick,
  onClear,
  emptyLabel,
  hint
}: {
  acc: string
  slotLabel: string
  active: boolean
  recording: boolean
  locked?: boolean
  onCardClick?: () => void
  onClear?: () => void
  emptyLabel: string
  hint: string
}) {
  const empty = !acc
  const interactive = !!onCardClick
  return (
    <div
      className={`hotkey-card${active ? ' active' : ''}${recording ? ' recording' : ''}${empty ? ' empty' : ''}${locked ? ' locked' : ''}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={
        empty
          ? emptyLabel
          : active
            ? `当前生效：${formatAcc(acc)}${locked ? '（固定预设）' : ''}`
            : `点击设为生效：${formatAcc(acc)}`
      }
      onClick={() => {
        if (interactive && !recording) onCardClick()
      }}
      onKeyDown={(e) => {
        if (interactive && (e.key === 'Enter' || e.key === ' ') && !recording) {
          e.preventDefault()
          onCardClick?.()
        }
      }}
    >
      <div className="hotkey-card-top">
        <span className="hotkey-card-slot">{slotLabel}</span>
        {active && !empty ? <span className="hotkey-card-badge">生效中</span> : null}
      </div>
      <div className="hotkey-card-keys">
        {recording ? (
          <span className="hotkey-card-record">请按下组合键…</span>
        ) : empty ? (
          <span className="hotkey-card-empty">{emptyLabel}</span>
        ) : (
          <span className="hotkey-card-acc">{formatAcc(acc)}</span>
        )}
      </div>
      <div className="hotkey-card-foot">{recording ? 'Esc 取消 · 被系统占用时会提示' : hint}</div>
      {!empty && onClear && !recording && !locked ? (
        <button
          type="button"
          className="hotkey-card-clear"
          aria-label="清除"
          onClick={(e) => {
            e.stopPropagation()
            onClear()
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}

export function HotkeyPresetCards({
  hotkeys,
  platform = 'darwin',
  activeHotkey = '',
  onChange
}: {
  hotkeys: string[]
  platform?: string
  /** 当前唯一生效的 accelerator */
  activeHotkey?: string
  onChange: (hotkeys: string[], activeHotkey: string) => void
}) {
  const [slots, setSlots] = useState<Slots>(() => slotsFromHotkeys(withDefaultPresets(hotkeys)))
  const [recording, setRecording] = useState(false)
  const lastEmitted = useRef<string>(
    JSON.stringify({
      h: hotkeysFromSlots(slotsFromHotkeys(withDefaultPresets(hotkeys))),
      a: activeHotkey
    })
  )
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  const activeRef = useRef(activeHotkey)
  activeRef.current = activeHotkey
  const probeBusy = useRef(false)

  useEffect(() => {
    const filled = withDefaultPresets(hotkeys)
    const key = JSON.stringify({ h: filled, a: activeHotkey })
    if (key === lastEmitted.current) return
    setSlots(slotsFromHotkeys(filled))
    lastEmitted.current = key
  }, [hotkeys, activeHotkey])

  const emit = useCallback(
    (next: Slots, nextActive?: string) => {
      const locked: Slots = { a: PRESET_A, b: PRESET_B, c: next.c }
      setSlots(locked)
      const list = hotkeysFromSlots(locked)
      const active = nextActive ?? activeRef.current
      const activeFinal = active && list.includes(active) ? active : (list[0] ?? '')
      lastEmitted.current = JSON.stringify({ h: list, a: activeFinal })
      onChange(list, activeFinal)
    },
    [onChange]
  )

  /** 点击卡片：设为唯一生效；自定义空槽则进入录制 */
  const selectSlot = useCallback(
    (acc: string | null, isCustomEmpty: boolean) => {
      if (isCustomEmpty) {
        setRecording(true)
        return
      }
      if (!acc) return
      if (acc === activeRef.current) {
        // 已生效的自定义：再点可重录
        if (acc !== PRESET_A && acc !== PRESET_B) setRecording(true)
        return
      }
      emit(slotsRef.current, acc)
    },
    [emit]
  )

  useEffect(() => {
    if (!recording) return
    window.focus()
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (probeBusy.current) return
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const acc = eventToAccelerator(e, platform)
      if (!acc) return
      if (acc === PRESET_A || acc === PRESET_B) {
        window.alert('该组合已是固定预设 A/B，请点选对应卡片设为生效。')
        return
      }

      void (async () => {
        probeBusy.current = true
        try {
          let free = true
          let hint: string | undefined
          if (shellApi.quickProbeHotkey) {
            const probe = await shellApi.quickProbeHotkey(acc)
            free = probe.free
            hint = probe.hint
          }
          if (!free) {
            const hintLine = hint ? `\n提示：${hint}` : ''
            const ok = window.confirm(
              `「${formatAcc(acc)}」可能已被系统或其他应用占用，全局呼出可能无效。${hintLine}\n\n仍要保存为自定义快捷键并设为生效？`
            )
            if (!ok) return
          }
          emit({ ...slotsRef.current, c: acc }, acc)
          setRecording(false)
        } catch {
          emit({ ...slotsRef.current, c: acc }, acc)
          setRecording(false)
        } finally {
          probeBusy.current = false
        }
      })()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, platform, emit])

  const isActive = (acc: string): boolean => !!acc && acc === activeHotkey
  const a = slots.a || PRESET_A
  const b = slots.b || PRESET_B

  return (
    <div className="hotkey-cards">
      <HotkeyCard
        acc={a}
        slotLabel="预设 A"
        locked
        active={isActive(a)}
        recording={false}
        emptyLabel=""
        hint={isActive(a) ? '当前生效' : '点击设为生效'}
        onCardClick={() => selectSlot(a, false)}
      />
      <HotkeyCard
        acc={b}
        slotLabel="预设 B"
        locked
        active={isActive(b)}
        recording={false}
        emptyLabel=""
        hint={isActive(b) ? '当前生效' : '点击设为生效'}
        onCardClick={() => selectSlot(b, false)}
      />
      <HotkeyCard
        acc={slots.c ?? ''}
        slotLabel="自定义"
        active={isActive(slots.c ?? '')}
        recording={recording}
        emptyLabel="录制自定义组合键"
        hint={
          !slots.c
            ? '点击录入，录完自动生效'
            : isActive(slots.c)
              ? '当前生效 · 点击可重新录入'
              : '点击设为生效'
        }
        onCardClick={() => selectSlot(slots.c ?? null, !slots.c)}
        onClear={() => {
          const nextActive = activeHotkey === slots.c ? a : activeHotkey
          emit({ ...slots, c: null }, nextActive)
        }}
      />
    </div>
  )
}

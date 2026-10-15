/** Keyboard capture owns a bounded host suspension, including late IPC replies. */
export interface ShortcutKeyEvent {
  code: string
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  repeat?: boolean
}

const CODE_TO_KEY: Record<string, string> = {
  Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/'
}

export function eventToAccelerator(event: ShortcutKeyEvent, platform: string): string | null {
  if (event.repeat || !(event.ctrlKey || event.altKey || event.metaKey)) return null
  let key = CODE_TO_KEY[event.code]
  if (!key && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3)
  if (!key && /^Digit\d$/.test(event.code)) key = event.code.slice(5)
  if (!key && /^Numpad\d$/.test(event.code)) key = `num${event.code.slice(6)}`
  if (!key && /^F\d{1,2}$/.test(event.code)) key = event.code
  if (!key) return null
  return [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift',
    event.metaKey && (platform === 'darwin' ? 'Command' : 'Super'), key].filter(Boolean).join('+')
}

export function formatAccelerator(value: string): string {
  return value.split('+').map(part => ({ Control: 'Ctrl', Command: '⌘', Super: 'Win', Shift: '⇧' })[part] ?? part).join(' + ')
}

type CapturePhase = 'idle' | 'starting' | 'recording' | 'restoring'
interface CaptureOptions {
  begin(): Promise<{ token: string }>
  end(token: string): Promise<void>
  onPhase(phase: CapturePhase): void
  onError(error: unknown): void
  onValue(value: string): void
  platform: string
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>
}

let currentCapture: ShortcutCapture | null = null

export class ShortcutCapture {
  private generation = 0
  private token: string | null = null
  private timeout: ReturnType<typeof setTimeout> | undefined
  private active = false
  private disposed = false
  private pending: { code: string; value: string } | null = null

  constructor(private readonly options: CaptureOptions) {}

  async start(): Promise<void> {
    if (this.active || this.disposed) return
    if (currentCapture !== this) void currentCapture?.stop()
    currentCapture = this
    const generation = ++this.generation
    this.active = true
    this.options.onPhase('starting')
    this.options.target.addEventListener('blur', this.onBlur)
    this.timeout = setTimeout(() => { void this.stop() }, 30_000)
    try {
      const { token } = await this.options.begin()
      if (!this.active || generation !== this.generation || this.disposed) {
        await this.options.end(token)
        return
      }
      this.token = token
      this.options.target.addEventListener('keydown', this.onKey, true)
      this.options.target.addEventListener('keyup', this.onKeyUp, true)
      this.options.onPhase('recording')
    } catch (error) {
      if (generation !== this.generation || this.disposed) return
      await this.stop()
      this.options.onError(error)
    }
  }

  async stop(value?: string): Promise<void> {
    const generation = ++this.generation
    const token = this.token
    this.token = null
    this.active = false
    this.pending = null
    if (currentCapture === this) currentCapture = null
    clearTimeout(this.timeout)
    this.options.target.removeEventListener('keydown', this.onKey, true)
    this.options.target.removeEventListener('keyup', this.onKeyUp, true)
    this.options.target.removeEventListener('blur', this.onBlur)
    if (!this.disposed) this.options.onPhase(token ? 'restoring' : 'idle')
    try {
      if (token) await this.options.end(token)
      if (generation === this.generation && !this.disposed) this.options.onPhase('idle')
      // Saving/probing must happen after all suspended shortcuts have been restored.
      if (value && generation === this.generation && !this.disposed) this.options.onValue(value)
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        this.options.onPhase('idle')
        this.options.onError(error)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    void this.stop()
  }

  private onBlur = (): void => { void this.stop() }
  private onKey = (event: KeyboardEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') { void this.stop(); return }
    if (this.pending) return
    const value = eventToAccelerator(event, this.options.platform)
    if (value) this.pending = { code: event.code, value }
  }
  private onKeyUp = (event: KeyboardEvent): void => {
    if (!this.pending || event.code !== this.pending.code) return
    event.preventDefault()
    event.stopPropagation()
    // Keep the host suspended until the main key is released (including OS repeat).
    void this.stop(this.pending.value)
  }
}

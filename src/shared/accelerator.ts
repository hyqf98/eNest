/** Normalize Electron accelerators without depending on Electron or the DOM. */
const keyNames = [
  'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete',
  'Insert', 'Return', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Home', 'End',
  'PageUp', 'PageDown', 'PrintScreen', 'Plus', 'VolumeUp', 'VolumeDown',
  'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop',
  'MediaPlayPause', 'MediaSelect', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv'
]
const keys = new Map(keyNames.map(key => [key.toLowerCase(), key]))
// Electron's parser adds Shift for these symbols; normalize them like recorded physical keys.
const shiftedKeys: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', Plus: '=', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '{': '[', '}': ']', '|': '\\', '~': '`'
}
keys.set('enter', 'Return')
keys.set('esc', 'Escape')
keys.set('spacebar', 'Space')
keys.set('del', 'Delete')
keys.set('ins', 'Insert')
for (const key of ['Up', 'Down', 'Left', 'Right']) keys.set(`arrow${key.toLowerCase()}`, key)

export function normalizeAccelerator(value: unknown, platform = 'linux'): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) return null
  let source = value.trim()
  if (source === '+') source = 'Plus'
  else source = source.replace(/\+\s*\+$/, '+Plus')
  const parts = source.split('+').map(part => part.trim())
  if (parts.some(part => !part)) return null
  const modifiers = new Set<string>()
  let key: string | undefined
  for (const part of parts) {
    const lower = part.toLowerCase()
    let modifier: string | undefined
    if (lower === 'ctrl' || lower === 'control') modifier = 'Control'
    else if (lower === 'alt' || lower === 'option') modifier = 'Alt'
    else if (lower === 'shift') modifier = 'Shift'
    else if (lower === 'altgr') modifier = 'AltGr'
    else if (lower === 'commandorcontrol' || lower === 'cmdorctrl') modifier = platform === 'darwin' ? 'Command' : 'Control'
    // Electron maps all of these aliases to VKEY_COMMAND on every platform.
    // Keep one ownership key so imported macOS shortcuts cannot bypass conflicts on Windows/Linux.
    else if (['command', 'cmd', 'meta', 'super', 'win', 'windows'].includes(lower)) modifier = platform === 'darwin' ? 'Command' : 'Super'
    if (modifier) {
      modifiers.add(modifier)
      continue
    }
    if (key) return null
    if (/^[a-z0-9]$/i.test(part)) key = part.toUpperCase()
    else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) key = part.toUpperCase()
    else if (/^num[0-9]$/i.test(part)) key = lower
    else if (/^[`\-=_\[\]\\;',./!@#$%^&*():<>?{}|~"]$/.test(part)) key = part
    else key = keys.get(lower)
    if (!key) return null
  }
  if (!key) return null
  if (shiftedKeys[key]) { key = shiftedKeys[key]; modifiers.add('Shift') }
  return [...['Control', 'Alt', 'AltGr', 'Shift', 'Command', 'Super'].filter(modifier => modifiers.has(modifier)), key].join('+')
}

/** User launcher bindings must not consume ordinary typing, Shift typing, or bare function keys. */
export function normalizeUserShortcut(value: unknown, platform = 'linux'): string | null {
  const accelerator = normalizeAccelerator(value, platform)
  if (!accelerator) return null
  return accelerator.split('+').slice(0, -1).some(part => ['Control', 'Alt', 'AltGr', 'Command', 'Super'].includes(part))
    ? accelerator : null
}

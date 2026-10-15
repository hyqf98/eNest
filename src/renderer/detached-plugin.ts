import type { DetachedPluginState, PluginWindowCommand } from '@shared/types/plugin-window'
import type { QuickInputState } from '@shared/types/plugin-tools'
import { IS_MAC } from '@shared/platform'
import { applyLevelToDefaults } from '@renderer/gsap/marketMotion'
import { startBackgroundEffect } from '@renderer/background/backgroundEffect'
import { validateBackgroundEffects } from '@shared/backgroundEffects'
import { backgroundAtmosphereStyle, syncBackgroundAtmosphere, syncBackgroundAtmosphereTheme } from '@renderer/components/backgroundAtmosphere'
import { bindPluginDragSource } from '@renderer/services/pluginWindowDrag'
import './detached-plugin.css'
import '@renderer/styles/plugin-window-drag.css'
import '@renderer/styles/backgroundEffect.css'

const api = window.enestWindows
const root = document.documentElement
const query = new URLSearchParams(location.search)
root.dataset.mode = query.get('mode') === 'quick' ? 'quick' : 'shell'
root.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light'
root.dataset.platform = IS_MAC ? 'mac' : 'other'
function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id)
  if (!result) throw new Error(`Missing detached chrome: ${id}`)
  return result as T
}
const title = element('plugin-title'), badge = element('plugin-badge'), glyph = element('plugin-glyph')
const icon = element<HTMLImageElement>('plugin-icon'), input = element<HTMLInputElement>('plugin-input')
const status = element('plugin-status'), notice = element('window-notice'), grip = element('plugin-grip')
const pin = element('pin-window'), placeholder = element('plugin-placeholder'), quickBar = element('quick-bar')
const focusPlugin = element<HTMLButtonElement>('focus-plugin')
let current: DetachedPluginState | null = null
let composing = false, disposed = false, stateVersion = 0, inputVersion = 0
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let tokenKeys = new Set<string>()
const disposers: Array<() => void> = []
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let backgroundSignature = ''
let clearBackground: (() => void) | undefined
let backgroundContainer: HTMLDivElement | undefined

function syncBackground(): void {
  if (disposed) return
  const appearance = current?.appearance
  syncBackgroundAtmosphereTheme(root, appearance?.background)
  const effect = appearance?.backgroundEffect
  const level = appearance?.animationLevel ?? 'medium'
  const reduced = reducedMotion.matches
  const signature = JSON.stringify([effect ?? null, level, reduced])
  if (signature === backgroundSignature && backgroundContainer) {
    if (!effect && !backgroundAtmosphereStyle(appearance?.background)) {
      clearBackground?.(); clearBackground = undefined; backgroundContainer = undefined
      return
    }
    syncBackgroundAtmosphere(backgroundContainer, appearance?.background, !!effect)
    return
  }
  backgroundSignature = signature
  clearBackground?.(); clearBackground = undefined
  backgroundContainer = undefined
  root.dataset.backgroundEffect = effect?.id ?? 'none'
  if (!effect && !backgroundAtmosphereStyle(appearance?.background)) return
  const container = document.createElement('div')
  backgroundContainer = container
  container.className = 'background-effect detached-background'
  container.setAttribute('aria-hidden', 'true')
  document.body.prepend(container)
  syncBackgroundAtmosphere(container, appearance?.background, !!effect)
  if (!effect) { clearBackground = () => container.remove(); return }
  const failed = () => container.classList.add('background-effect--fallback')
  if (effect.renderer === 'preset') {
    const canvas = document.createElement('canvas')
    container.appendChild(canvas)
    const stop = startBackgroundEffect(canvas, {
      preset: effect.preset, level, reducedMotion: reduced, colors: effect.colors, speed: effect.speed, onError: failed,
    })
    clearBackground = () => { stop(); container.remove() }
    return
  }
  // Recheck media ownership before assigning a renderer URL, including state from
  // an older host. A selected background can belong to a different installed plugin.
  let media
  try {
    media = validateBackgroundEffects([{
      id: 'detached', name: effect.name, renderer: 'video', video: effect.video,
      ...(effect.poster ? { poster: effect.poster } : {}),
    }], effect.source ?? '')[0]
  } catch {
    failed(); clearBackground = () => container.remove(); return
  }
  if (media.renderer !== 'video') { container.remove(); return }
  const video = document.createElement('video')
  video.muted = true; video.loop = true; video.playsInline = true
  video.preload = 'metadata'
  if (media.poster) video.poster = media.poster
  const animate = level !== 'low' && !reduced
  container.appendChild(video)
  let mediaDisposed = false
  let mediaFailed = false
  let focused = document.hasFocus()
  const releaseSource = () => {
    video.pause(); video.removeAttribute('src'); video.load()
  }
  const fail = () => {
    if (mediaDisposed || mediaFailed) return
    mediaFailed = true
    releaseSource()
    failed()
  }
  const sync = () => {
    if (mediaDisposed || mediaFailed) return
    if (!animate || document.hidden || !focused) video.pause()
    else void video.play().catch((error: unknown) => {
      // Pausing can reject an outstanding play; autoplay denial keeps the poster.
      const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
      if (name !== 'AbortError' && name !== 'NotAllowedError') fail()
    })
  }
  const focus = () => { focused = true; sync() }
  const blur = () => { focused = false; sync() }
  video.addEventListener('loadeddata', sync)
  video.addEventListener('error', fail)
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('focus', focus)
  window.addEventListener('blur', blur)
  // A poster (or the static fallback) suffices in low/reduced mode; no decoder needed.
  if (animate) video.src = media.video
  sync()
  clearBackground = () => {
    mediaDisposed = true
    video.removeEventListener('loadeddata', sync)
    video.removeEventListener('error', fail)
    document.removeEventListener('visibilitychange', sync)
    window.removeEventListener('focus', focus)
    window.removeEventListener('blur', blur)
    releaseSource(); video.removeAttribute('poster')
    container.remove()
  }
}
reducedMotion.addEventListener('change', syncBackground)
disposers.push(() => reducedMotion.removeEventListener('change', syncBackground))

function showNotice(message: string): void {
  clearTimeout(noticeTimer)
  notice.textContent = message; notice.hidden = !message
  noticeTimer = setTimeout(() => { notice.hidden = true }, 3500)
}
async function command(value: PluginWindowCommand): Promise<void> {
  try {
    const result = await api?.command(value)
    if (result && !result.ok) showNotice(result.error || '操作未完成，请重试')
  } catch (error) { showNotice(error instanceof Error ? error.message : '操作未完成，请重试') }
}
function setInput(next: QuickInputState | null | undefined): void {
  if (!current || next && (next.pluginId !== current.pluginId || next.generation !== current.generation)) return
  inputVersion++
  current.input = next ? { ...next } : null
  syncInputAvailability()
  if (input.value !== (next?.value ?? '')) input.value = next?.value ?? ''
}
function syncInputAvailability(): void {
  const ready = current?.status === 'ready'
  input.disabled = !ready || current?.mode !== 'quick' || !current.input
  input.placeholder = ready ? current?.input?.placeholder || '该插件未启用输入'
    : current?.status === 'loading' ? '正在打开插件…'
      : current?.status === 'error' ? '插件加载失败'
        : current?.status === 'hibernated' ? '插件已休眠' : '打开插件后可输入'
  focusPlugin.disabled = !ready
}
function applyState(state: DetachedPluginState, preserveInput = false): void {
  if (disposed) return
  const sameInstance = current?.pluginId === state.pluginId && current.generation === state.generation
  // Same-instance ready snapshots describe window metadata. Input configuration and
  // clears arrive through quick-input; an older pin/theme/history snapshot must not undo typing.
  const keepInput = sameInstance && state.status === 'ready' && (current?.status === 'ready' || preserveInput || composing)
  const previousInput = current?.input
  const nextInput = state.input?.pluginId === state.pluginId && state.input.generation === state.generation ? state.input : null
  if (!sameInstance || state.status !== 'ready') composing = false
  current = { ...state, input: keepInput ? previousInput : nextInput }; stateVersion++
  root.dataset.mode = state.mode; root.dataset.status = state.status
  title.textContent = state.title; document.title = state.title
  grip.setAttribute('aria-label', `拖动${state.title}，收回主窗口或小窗口`)
  glyph.textContent = state.glyph || '⌥'
  badge.textContent = state.badge ?? ''; badge.hidden = !state.badge
  const source = state.icon || ''
  if ((icon.getAttribute('src') ?? '') !== source) {
    icon.hidden = true; glyph.hidden = false
    if (source) icon.src = source; else icon.removeAttribute('src')
  }
  status.textContent = state.status === 'loading' ? '正在打开…' : state.status === 'error' ? '加载失败' : state.status === 'hibernated' ? '已休眠' : ''
  element('retry').hidden = state.status !== 'error' && state.status !== 'hibernated'
  placeholder.hidden = state.status !== 'lazy'
  quickBar.hidden = state.mode !== 'quick' || state.status === 'lazy'
  const pinned = Boolean(state.alwaysOnTop)
  pin.setAttribute('aria-pressed', String(pinned))
  pin.setAttribute('title', pinned ? '取消置顶' : '置顶窗口')
  pin.setAttribute('aria-label', pinned ? '取消置顶' : '置顶窗口')
  if (!keepInput) setInput(current.input); else syncInputAvailability()
  const appearance = state.appearance
  if (appearance) {
    root.dataset.theme = appearance.theme; root.dataset.anim = appearance.animationLevel
    applyLevelToDefaults(appearance.animationLevel)
    const nextKeys = new Set(Object.keys(appearance.tokens).filter(key => key.startsWith('--')))
    for (const key of tokenKeys) if (!nextKeys.has(key)) root.style.removeProperty(key)
    for (const key of nextKeys) root.style.setProperty(key, appearance.tokens[key])
    tokenKeys = nextKeys
    const fonts = [appearance.fontFamilyEn, appearance.fontFamily].filter(Boolean).join(', ')
    if (fonts) root.style.setProperty('--font', fonts); else root.style.removeProperty('--font')
    const scale = Math.min(1.3, Math.max(.9, appearance.fontSizeScale ?? 1))
    root.style.setProperty('--font-size-base', `${14 * scale}px`)
    root.lang = appearance.locale || 'zh-CN'
  }
  syncBackground()
}
async function refresh(): Promise<void> {
  const version = stateVersion
  const inputAtRead = inputVersion
  try {
    const state = await api?.getState()
    if (state && stateVersion === version) applyState(state, inputVersion !== inputAtRead)
  } catch { showNotice('暂时无法读取窗口状态') }
}
function sendInput(): void {
  const state = current?.input
  if (!state || input.disabled || current?.status !== 'ready') return
  inputVersion++
  if (composing) return
  state.value = input.value
  void command({ action: 'input', message: { pluginId: state.pluginId, generation: state.generation, type: 'change', value: input.value } })
}
function onKey(event: KeyboardEvent): void {
  if (composing || event.isComposing || event.keyCode === 229 || !current) return
  const modifier = event.metaKey || event.ctrlKey
  if (modifier && event.key.toLowerCase() === 'k' && current.mode === 'quick' && !input.disabled) {
    event.preventDefault(); input.focus(); input.select(); return
  }
  if (modifier && event.key === 'Enter') { event.preventDefault(); void command({ action: 'dock', pluginId: current.pluginId, target: 'shell' }); return }
  if (event.target !== input || input.disabled) return
  if (event.key === 'Tab') { event.preventDefault(); void command({ action: 'input-tab', shift: event.shiftKey }); return }
  const state = current.input
  if (!state || modifier || event.altKey) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!event.repeat) void command({ action: 'input', message: { pluginId: state.pluginId, generation: state.generation, type: 'escape' } })
  } else if (['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
    if (input.selectionStart !== input.selectionEnd) return
    event.preventDefault()
    void command({ action: 'input', message: { pluginId: state.pluginId, generation: state.generation, type: 'action', action: event.key === 'ArrowUp' ? 'previous' : event.key === 'ArrowDown' ? 'next' : 'submit' } })
  }
}
function bindClick(id: string, value: () => PluginWindowCommand | null): void {
  const button = element(id)
  const callback = () => { const request = value(); if (request) void command(request) }
  button.addEventListener('click', callback)
  disposers.push(() => button.removeEventListener('click', callback))
}
icon.onload = () => { icon.hidden = !icon.naturalWidth; glyph.hidden = Boolean(icon.naturalWidth) }
icon.onerror = () => { icon.hidden = true; glyph.hidden = false }
for (const action of ['minimize', 'maximize', 'close'] as const) bindClick(action, () => ({ action }))
bindClick('retry', () => current?.status === 'error' || current?.status === 'hibernated' ? { action: 'retry' } : null)
bindClick('focus-plugin', () => current?.status === 'ready' ? { action: 'focus-plugin' } : null)
bindClick('activate', () => current?.status === 'lazy' ? { action: 'activate' } : null)
bindClick('pin-window', () => current ? { action: 'toggle-always-on-top' } : null)
for (const target of ['shell', 'quick'] as const) bindClick(`dock-${target}`, () => current ? { action: 'dock', pluginId: current.pluginId, target } : null)
const startComposition = () => { composing = true; inputVersion++ }
const endComposition = () => { composing = false; sendInput() }
input.addEventListener('input', sendInput)
input.addEventListener('compositionstart', startComposition)
input.addEventListener('compositionend', endComposition)
document.addEventListener('keydown', onKey)
disposers.push(bindPluginDragSource(grip, () => current ? { element: grip, pluginId: current.pluginId } : null))
if (api) disposers.push(api.onEvent(event => {
  if (event.type === 'state') { applyState(event.state); return }
  const message = event.event
  if (message.type === 'quick-input') setInput(message.state)
  else if (message.type === 'quick-focus-search' && !input.disabled) { input.focus(); input.select() }
  else if (message.type === 'plugin-toast' && message.pluginId === current?.pluginId) {
    const options = message.notification ?? { body: message.message ?? '', level: message.toastType ?? 'info' }
    if (window.enestNotifications) void window.enestNotifications.show(options).catch(() => showNotice(options.body ?? ''))
    else showNotice(options.body ?? '')
  }
  else if (message.type === 'settings-changed' || message.type === 'theme-changed' || message.type === 'theme-packs-changed') void refresh()
}))
void refresh()
function dispose(): void {
  if (disposed) return
  disposed = true; clearTimeout(noticeTimer)
  clearBackground?.(); clearBackground = undefined
  disposers.splice(0).forEach(off => off())
  input.removeEventListener('input', sendInput); input.removeEventListener('compositionstart', startComposition); input.removeEventListener('compositionend', endComposition)
  document.removeEventListener('keydown', onKey)
  icon.onload = null; icon.onerror = null
}
window.addEventListener('pagehide', dispose, { once: true })
if (import.meta.hot) import.meta.hot.dispose(dispose)

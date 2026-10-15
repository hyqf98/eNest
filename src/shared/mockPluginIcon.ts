import { BUILTIN_PLUGIN_ICON_SVGS } from './builtinPluginIcons'

/** Offline previews use the same artwork as plugin packages, without a runtime repository dependency. */
export function mockPluginIcon(id: string, color: string): string {
  const packaged = Object.hasOwn(BUILTIN_PLUGIN_ICON_SVGS, id) ? BUILTIN_PLUGIN_ICON_SVGS[id] : undefined
  if (packaged) return `data:image/svg+xml,${encodeURIComponent(packaged)}`
  const path = '<rect x="15" y="15" width="14" height="14" rx="4"/><rect x="35" y="15" width="14" height="14" rx="4"/><rect x="15" y="35" width="14" height="14" rx="4"/><path d="M35 42h14M42 35v14"/>'
  const fill = /^#[0-9a-f]{6}$/i.test(color) ? color : '#5b8cff'
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="${fill}"/><circle cx="54" cy="4" r="37" fill="white" opacity=".12"/><g fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${path}</g></svg>`)}`
}

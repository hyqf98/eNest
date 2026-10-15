import { BUILTIN_PLUGIN_ICON_SVGS, LEGACY_PLUGIN_ICONS } from './builtinPluginIcons'

/** Refresh only old, official default URLs. Custom origins/paths and future versions keep their artwork. */
export function resolveOfficialPluginIcon(id: string, version: string, src?: string): string | undefined {
  const legacy = Object.hasOwn(LEGACY_PLUGIN_ICONS, id) ? LEGACY_PLUGIN_ICONS[id] : undefined
  if (!src || !legacy || !/^\d+\.\d+\.\d+$/.test(version)) return src
  const current = version.split('.').map(Number)
  const limit = legacy.throughVersion.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (current[index] > limit[index]) return src
    if (current[index] < limit[index]) break
  }
  let url: URL
  try { url = new URL(src) } catch { return src }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) return src
  let path: string
  try { path = decodeURIComponent(url.pathname) } catch { return src }
  let relative: string | undefined
  if (url.hostname === 'raw.githubusercontent.com') {
    relative = /^\/hyqf98\/eNest_plugin\/[^/]+\/(.+)$/.exec(path)?.[1]
  } else if (url.hostname === 'github.com') {
    relative = /^\/hyqf98\/eNest_plugin\/releases\/(?:latest\/download|download\/[^/]+)\/(.+)$/.exec(path)?.[1]
  }
  if (!relative || ![
    `plugins/${id}/icon.svg`,
    `plugins/${id}/public/assets/market/icon.svg`,
    `plugins/${id}/assets/market/icon.svg`,
    `${id}@${version}/assets/market/icon.svg`,
    `dist/${id}@${version}/assets/market/icon.svg`,
    `${id}@${version}-icon.svg`
  ].includes(relative)) return src
  return `data:image/svg+xml,${encodeURIComponent(BUILTIN_PLUGIN_ICON_SVGS[id])}`
}

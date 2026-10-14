/** Offline preview artwork. Installed/development plugins always use their packaged icon. */
export function mockPluginIcon(id: string, color: string): string {
  const paths: Record<string, string> = {
    'screen-assistant': '<rect x="15" y="17" width="34" height="25" rx="5"/><path d="M25 48h14M32 42v6M22 25h7m-7 0v7m20-7h-7m7 0v7"/>',
    clipboard: '<rect x="18" y="17" width="28" height="34" rx="5"/><rect x="25" y="13" width="14" height="9" rx="3"/><path d="M25 31h14M25 38h14M25 45h8"/>',
    translate: '<path d="M12 21h24M24 15v6M17 22c2 12 10 18 18 20M31 22c-2 10-8 17-17 21M36 47l8-23 8 23M39 40h10"/>'
  }
  const key = id.split('.').pop() ?? ''
  const path = paths[key] ?? '<rect x="15" y="15" width="14" height="14" rx="4"/><rect x="35" y="15" width="14" height="14" rx="4"/><rect x="15" y="35" width="14" height="14" rx="4"/><path d="M35 42h14M42 35v14"/>'
  const fill = /^#[0-9a-f]{6}$/i.test(color) ? color : '#5b8cff'
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="${fill}"/><circle cx="54" cy="4" r="37" fill="white" opacity=".12"/><g fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${path}</g></svg>`)}`
}

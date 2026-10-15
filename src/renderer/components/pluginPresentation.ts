/** Registry asset bytes only; an absent size never becomes a made-up zero. */
export function formatPluginPackageSize(bytes?: number): string | undefined {
  if (!Number.isSafeInteger(bytes) || !bytes || bytes < 1) return undefined
  if (bytes < 1024) return `${bytes} B`
  const value = bytes < 1024 * 1024 ? bytes / 1024 : bytes / (1024 * 1024)
  return `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')} ${bytes < 1024 * 1024 ? 'KiB' : 'MiB'}`
}

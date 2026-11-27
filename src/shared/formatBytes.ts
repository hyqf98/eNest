/**
 * formatBytes — 字节数的人类可读格式。
 * 规则与设置页内存监控一致：不足 0.5 GiB 用 MiB 保留粒度，之后切 GiB。
 * 更小的量级依次用 KiB / B，避免小文件都显示成 0.0 MiB。
 */
export function formatBytes(bytes: number, locale: string, digits = { gib: 2, mib: 1, kib: 1 }): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const KIB = 1024, MIB = 1024 * KIB, GIB = 1024 * MIB
  if (bytes >= GIB / 2) return `${(bytes / GIB).toLocaleString(locale, { maximumFractionDigits: digits.gib })} GiB`
  if (bytes >= MIB) return `${(bytes / MIB).toLocaleString(locale, { maximumFractionDigits: digits.mib })} MiB`
  if (bytes >= KIB) return `${(bytes / KIB).toLocaleString(locale, { maximumFractionDigits: digits.kib })} KiB`
  return `${bytes.toLocaleString(locale)} B`
}

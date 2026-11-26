/**
 * 插件市场素材标准：图标与截图的唯一来源。
 *
 * eNest 按这些规则校验素材，并以同一比例渲染。插件仓的构建校验由
 * `scripts/generate-api-types.mjs` 从本文件转译生成，不另抄一份。
 * 张数与字节上限沿用既有约束（manifest schema、CATALOG_IMAGE_LIMIT），这里不重复定义。
 */

/** 图标是矢量，文件本身保持轻量。 */
export const PLUGIN_ICON_MAX_BYTES = 64 * 1024

/** 截图固定 1200×800（3:2）；首页精选、详情图库与缩略图都按这个比例出容器。 */
export const PLUGIN_SCREENSHOT_WIDTH = 1200
export const PLUGIN_SCREENSHOT_HEIGHT = 800

export interface MarketAssetIssue {
  path: string
  message: string
}

/**
 * 图标会进入首页、Tab 与 Quick 的受信渲染面。矢量画布的数值不影响清晰度，
 * 所以只要求正方形 viewBox，不强制具体数值；拒绝位图、脚本与一切外部引用。
 */
export function pluginIconIssues(svg: string): string[] {
  const issues: string[] = []
  if (new TextEncoder().encode(svg).length > PLUGIN_ICON_MAX_BYTES) issues.push(`图标不得超过 ${PLUGIN_ICON_MAX_BYTES / 1024} KiB`)
  const open = /<svg\b([^>]*)>/i.exec(svg)
  if (!open) return [...issues, '图标必须是 SVG 文档']
  const viewBox = /\bviewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)\s*["']/i.exec(open[1])
  const box = viewBox?.slice(1).map(Number)
  if (!box || box.some(value => !Number.isFinite(value))) issues.push('图标缺少合法的 viewBox')
  else if (box[2] <= 0 || box[3] <= 0 || Math.abs(box[2] - box[3]) > 1e-6) issues.push(`图标画布必须是正方形，当前 ${box[2]}×${box[3]}`)
  if (/<\s*(?:script|foreignObject|image|iframe|object|embed|use|animation|set|animate|animateTransform|animateMotion)\b/i.test(svg)) issues.push('图标不得包含脚本、位图、外部引用或动画元素')
  if (/\b(?:href|xlink:href)\s*=/i.test(svg)) issues.push('图标不得包含外部引用')
  if (/\bon[a-z]+\s*=/i.test(svg)) issues.push('图标不得包含事件属性')
  if (/@import\b|url\s*\(\s*["']?(?!#)/i.test(svg)) issues.push('图标不得引用外部资源')
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(svg)) issues.push('图标不得包含声明、处理指令或实体')
  return issues
}

/** PNG / JPEG / WebP 的像素尺寸；无法识别时返回 null。 */
export function marketImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const be32 = (offset: number): number => view.getUint32(offset)
  const be16 = (offset: number): number => view.getUint16(offset)
  // PNG：签名 89 50 4e 47 0d 0a 1a 0a，IHDR 的宽高为大端，位于第 16、20 字节。
  if (bytes.length >= 24 && be32(0) === 0x89504e47 && be32(4) === 0x0d0a1a0a) return { width: be32(16), height: be32(20) }
  // WebP：RIFF + WEBP，尺寸随子格式以小端位域存放。
  if (bytes.length >= 30 && be32(0) === 0x52494646 && be32(8) === 0x57454250) {
    const chunk = be32(12)
    // VP8（有损）：3 字节帧标记 + 3 字节起始码之后，是 14 位宽、14 位高。
    if (chunk === 0x56503820) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    // VP8L（无损）：1 字节签名之后是 28 位位域，宽、高各 14 位，存的是实际值减一。
    if (chunk === 0x56503858) {
      const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    return null
  }
  // JPEG：按段扫描到 SOFn；段内高在前、宽在后，均为大端。
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]
      if (marker === 0xff) { offset += 1; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      if (marker === 0xd9 || marker === 0xda) return null
      const length = be16(offset + 2)
      if (length < 2) return null
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (sof) {
        if (offset + 9 > bytes.length) return null
        return { height: be16(offset + 5), width: be16(offset + 7) }
      }
      offset += 2 + length
    }
  }
  return null
}

/** 截图必须是 1200×800；比例相近的尺寸（1200×764、1280×800 等）同样不通过。 */
export function pluginScreenshotIssues(bytes: Uint8Array, path: string): MarketAssetIssue[] {
  const size = marketImageSize(bytes)
  if (!size) return [{ path, message: '无法读取截图尺寸，请使用标准 PNG / JPEG / WebP' }]
  if (size.width !== PLUGIN_SCREENSHOT_WIDTH || size.height !== PLUGIN_SCREENSHOT_HEIGHT) {
    return [{ path, message: `截图尺寸必须是 ${PLUGIN_SCREENSHOT_WIDTH}×${PLUGIN_SCREENSHOT_HEIGHT}，当前 ${size.width}×${size.height}` }]
  }
  return []
}

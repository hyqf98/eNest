/**
 * icons.paths — Lucide SVG 路径与字符串模板工具（纯数据/字符串，无 React）
 * 供两处共享，避免路径逐字重复：
 * - components/icons.tsx（React 内联组件，JSX）
 * - orb-overlay.ts（无 React 的独立 vite entry，字符串模板 DOM 内联）
 * 路径按 Lucide v1 设计规范手写（24 网格），描边默认 @shared UI_ICON_STROKE_WIDTH。
 */
import { UI_ICON_STROKE_WIDTH } from '@shared/constants'

/** 统一描边：精致线性 chrome（勿再各处写死 strokeWidth=2） */
export const ICON_STROKE_WIDTH = UI_ICON_STROKE_WIDTH

/**
 * 非 React 字符串模板场景（orb-overlay 等 DOM 内联）用的 Lucide SVG 片段。
 * 与 icons.tsx 组件路径一致；描边默认 ICON_STROKE_WIDTH。
 */
export function lucideSvgMarkup(
  pathInner: string,
  size = 16,
  strokeWidth: number = ICON_STROKE_WIDTH
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathInner}</svg>`
}

/** Lucide path 内容（供 orb-overlay 等字符串模板复用） */
export const LUCIDE_PATHS = {
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  settings:
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  trash2:
    '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  house:
    '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  rotateCw:
    '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  user:
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
} as const

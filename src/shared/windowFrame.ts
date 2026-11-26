import type { HomeAction } from '@shared/types/home'

export type WindowControl = Extract<HomeAction, { type: 'window' }>['control']

export const DESKTOP_CORNER_RADIUS = 12
export const WINDOW_BUTTON_LAYOUT = { left: 20, diameter: 12, pitch: 20 } as const

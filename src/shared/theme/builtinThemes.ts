import { DEFAULT_THEME_IDENTITY, DEFAULT_THEME_PACKAGE } from '@shared/theme/defaultTheme/package'

export { DEFAULT_BODY_FONT, DEFAULT_MONO_FONT, DEFAULT_THEME_IDENTITY, DEFAULT_THEME_PACKAGE } from '@shared/theme/defaultTheme/package'

/** Registry compatibility adapter; the package manifest owns both contributions. */
export const BUILTIN_THEME_SOURCE = DEFAULT_THEME_PACKAGE.id
export const BUILTIN_THEME_IDS = [DEFAULT_THEME_IDENTITY.id] as const
export const BUILTIN_THEME_PACKS = DEFAULT_THEME_PACKAGE.contributes.themePacks

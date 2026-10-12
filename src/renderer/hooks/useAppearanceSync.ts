/** Keep independent shell surfaces in sync without persisting settings again. */
import { useEffect } from 'react'
import { shellApi } from '@renderer/services/shellApi'
import { useAnimationLevelStore } from '@renderer/hooks/useAnimationLevel'
import { useFontStore } from '@renderer/hooks/useFont'
import { useThemeStore } from '@renderer/hooks/useTheme'

const FONT_SETTINGS = new Set(['fontFamily', 'fontFamilyEn', 'fontSizeScale', 'customFonts', 'dataRoot'])

/** Quick 等独立 WebContents 使用；主窗口自身的设置动作仍先乐观更新。 */
export function useAppearanceSync(): void {
  useEffect(() => {
    const off = shellApi.onEvent((payload) => {
      if (payload.type === 'theme-changed' || payload.type === 'theme-packs-changed') {
        void useThemeStore.getState().refresh()
      } else if (payload.type === 'settings-changed') {
        if (payload.generalKeys.includes('animationLevel')) {
          void useAnimationLevelStore.getState().refresh()
        }
        if (payload.generalKeys.some((key) => FONT_SETTINGS.has(key))) {
          void useFontStore.getState().refresh()
        }
      }
    })
    void useThemeStore.getState().hydrate()
    void useAnimationLevelStore.getState().hydrate()
    void useFontStore.getState().hydrate()
    return off
  }, [])
}

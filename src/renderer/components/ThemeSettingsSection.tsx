/**
 * ThemeSettingsSection — 设置页「主题」整块（模式 / 主题包 / 背景（含启动画面）/ 颜色 Token）
 * 供 SettingsPage 或其它容器一键挂载；只订阅本区域需要的主题状态。
 * 依赖：useThemeStore、ThemeModeSelect、BackgroundPicker、ThemeTokenEditor。
 */
import { useShallow } from 'zustand/react/shallow'
import { useThemeStore } from '@renderer/hooks/useTheme'
import { ThemeModeSelect } from '@renderer/components/ThemeModeSelect'
import { BackgroundPicker } from '@renderer/components/BackgroundPicker'
import { ThemeTokenEditor } from '@renderer/components/ThemeTokenEditor'
import { resolveThemePalette } from '@shared/theme/presets'

export function ThemeSettingsSection() {
  // Background previews must not rerender palette cards and every token color picker.
  const theme = useThemeStore(useShallow(({ mode, resolved, packs, packId, overrides, tokens, setMode, applyPack, setToken, resetMode }) => ({
    mode, resolved, packs, packId, overrides, tokens, setMode, applyPack, setToken, resetMode,
  })))
  const pack = theme.packs.find((item) => item.id === theme.packId)
  const palettes = {
    light: resolveThemePalette('light', theme.overrides.light, pack?.tokens),
    dark: resolveThemePalette('dark', theme.overrides.dark, pack?.tokens),
  }

  return (
    <>
      <ThemeModeSelect
        mode={theme.mode}
        resolved={theme.resolved}
        packs={theme.packs}
        packId={theme.packId}
        palettes={palettes}
        onSetMode={(m) => void theme.setMode(m)}
        onApplyPack={(id) => void theme.applyPack(id)}
      />
      {/* 背景卡片内含：壳子背景 + 启动画面 */}
      <BackgroundPicker />
      <ThemeTokenEditor
        tokens={theme.tokens}
        onSetToken={theme.setToken}
        onReset={() => void theme.resetMode()}
      />
    </>
  )
}

/**
 * ThemeSettingsSection — 设置页「主题」整块（模式 / 主题包 / 背景 / 启动背景 / 颜色 Token）
 * 供 SettingsPage 或其它容器一键挂载；内部读 useTheme，无需透传 props。
 * 依赖：useTheme、ThemeModeSelect、BackgroundPicker、SplashBackgroundSection、ThemeTokenEditor。
 */
import { useTheme } from '@renderer/hooks/useTheme'
import { ThemeModeSelect } from '@renderer/components/ThemeModeSelect'
import { BackgroundPicker } from '@renderer/components/BackgroundPicker'
import { SplashBackgroundSection } from '@renderer/components/SplashBackgroundSection'
import { ThemeTokenEditor } from '@renderer/components/ThemeTokenEditor'

export function ThemeSettingsSection() {
  const theme = useTheme()

  return (
    <>
      <ThemeModeSelect
        mode={theme.mode}
        resolved={theme.resolved}
        packs={theme.packs}
        packId={theme.packId}
        onSetMode={(m) => void theme.setMode(m)}
        onApplyPack={(id) => void theme.applyPack(id)}
      />
      <BackgroundPicker />
      <SplashBackgroundSection />
      <ThemeTokenEditor
        tokens={theme.tokens}
        onSetToken={theme.setToken}
        onReset={() => void theme.resetMode()}
      />
    </>
  )
}

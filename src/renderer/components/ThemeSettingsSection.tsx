/**
 * ThemeSettingsSection — 设置页「主题」整块（模式 / 主题包 / 背景（含启动画面）/ 颜色 Token）
 * 供 SettingsPage 或其它容器一键挂载；内部读 useTheme，无需透传 props。
 * 依赖：useTheme、ThemeModeSelect、BackgroundPicker、ThemeTokenEditor。
 */
import { useTheme } from '@renderer/hooks/useTheme'
import { ThemeModeSelect } from '@renderer/components/ThemeModeSelect'
import { BackgroundPicker } from '@renderer/components/BackgroundPicker'
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

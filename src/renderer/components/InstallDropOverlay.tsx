/**
 * InstallDropOverlay — 拖拽安装全窗遮罩
 * 职责：拖入文件时显示透明遮罩 + 居中大「+」与「释放以安装插件」提示；离开/放下即隐藏。
 * pointer-events: none，保证 drop 事件仍能落到 window（由 useInstallDrop 处理）。
 * 被 ShellLayout 挂载。
 * 依赖：useInstallDrop.dragging、install.css。
 */
import '../styles/install.css'
import { useInstallDrop } from '@renderer/hooks/useInstallDrop'

export function InstallDropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <div className="install-drop-overlay" aria-hidden>
      <div className="install-drop-inner">
        <div className="install-drop-plus">+</div>
        <div className="install-drop-hint">释放以安装插件</div>
      </div>
    </div>
  )
}

/** 带 hook 的容器：ShellLayout 直接挂这一支即可 */
export function InstallDropHost() {
  const { dragging } = useInstallDrop()
  return <InstallDropOverlay visible={dragging} />
}

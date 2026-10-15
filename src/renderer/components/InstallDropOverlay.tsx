import '@renderer/styles/install.css'
import { useInstallDrop } from '@renderer/hooks/useInstallDrop'

export function InstallDropOverlay({ visible }: { visible: boolean }) {
  return <div className={`install-drop-overlay${visible ? ' is-visible' : ''}`} aria-hidden={!visible}>
    <div className="install-drop-inner">
      <div className="install-drop-plus" aria-hidden="true"><span /><span /></div>
      <strong className="install-drop-hint">松开以安装插件</strong>
      <span className="install-drop-detail">ZIP / .enestplugin 插件包</span>
    </div>
  </div>
}
export function InstallDropHost() {
  const { dragging } = useInstallDrop()
  return window.enestInstallNative ? null : <InstallDropOverlay visible={dragging} />
}

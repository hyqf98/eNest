/**
 * SegmentTabs — 市场「浏览 / 已安装」分段切换
 * 受控组件；value 为 shellStore.Seg，onChange 写回 shellStore.setSeg。
 */
import type { Seg } from '@renderer/stores/shellStore'

interface Props {
  value: Seg
  onChange: (s: Seg) => void
}

export function SegmentTabs({ value, onChange }: Props) {
  return (
    <div className="segmented">
      <button type="button" className={value === 'browse' ? 'active' : ''} onClick={() => onChange('browse')}>
        浏览市场
      </button>
      <button type="button" className={value === 'installed' ? 'active' : ''} onClick={() => onChange('installed')}>
        已安装
      </button>
    </div>
  )
}

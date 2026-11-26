import { useLayoutEffect, useRef } from 'react'
import { useI18n } from '@renderer/hooks/useI18n'
import type { WindowControl } from '@shared/windowFrame'
import { renderWindowControls } from './windowControlButtons'

export function WindowControls({ onControl }: { onControl: (control: WindowControl) => void }) {
  const slot = useRef<HTMLDivElement>(null)
  const { locale } = useI18n()
  useLayoutEffect(() => {
    if (slot.current) renderWindowControls(slot.current, locale, onControl)
  }, [locale, onControl])
  return <div className="window-controls" ref={slot} />
}

/** Theme-aware flowing light shared with the launch screen. */
import { useEffect, useRef } from 'react'
import { useAnimationLevelStore, useReducedMotion } from '@renderer/hooks/useAnimationLevel'
import { startAmbientFlow } from '@renderer/gsap/ambientFlow'
import '@renderer/styles/ambient.css'

export function AmbientParticles() {
  const level = useAnimationLevelStore((s) => s.level)
  const reducedMotion = useReducedMotion()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || reducedMotion) return
    return startAmbientFlow(canvas, { level })
  }, [level, reducedMotion])

  if (reducedMotion) return null

  return <canvas ref={canvasRef} className="ambient-particles ambient-flow" aria-hidden />
}

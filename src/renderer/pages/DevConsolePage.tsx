/**
 * DevConsolePage — 开发者控制台页（与设置页 DevConsoleSection 同构精简版）
 */
import { DevConsoleSection } from '@renderer/components/DevConsoleSection'

export function DevConsolePage() {
  return (
    <section className="page">
      <div className="dev-shell">
        <DevConsoleSection />
      </div>
    </section>
  )
}
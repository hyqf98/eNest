import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyDefaultQuickUsage, type DefaultQuickOpened } from './usagePolicy'
import { createDefaultQuickUsageSession, type DefaultQuickStateClient } from './usageState'

export function useQuickUsage(client: DefaultQuickStateClient) {
  const [usage, setUsage] = useState(emptyDefaultQuickUsage)
  const session = useRef<ReturnType<typeof createDefaultQuickUsageSession> | null>(null)
  useEffect(() => {
    const current = createDefaultQuickUsageSession(client, setUsage)
    session.current = current
    void current.initialize().catch(error => console.warn('[default-quick] Unable to load private usage state', error))
    return () => { current.dispose(); if (session.current === current) session.current = null }
  }, [client])
  const recordOpened = useCallback((opened: DefaultQuickOpened) => {
    void session.current?.recordOpened(opened).catch(error => console.warn('[default-quick] Unable to persist usage state', error))
  }, [])
  const refreshUsage = useCallback(() => { void session.current?.refresh().catch(error => console.warn('[default-quick] Unable to refresh usage state', error)) }, [])
  return { usage, recordOpened, refreshUsage }
}

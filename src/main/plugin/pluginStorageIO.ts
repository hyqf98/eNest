import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(dir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try { await handle.sync() } finally { await handle.close() }
}

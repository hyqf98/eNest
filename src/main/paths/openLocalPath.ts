import { shell } from 'electron'
import { resolveLocalUserPath } from './userPath'

/** Trusted shell UI only; plugin file access must keep using its own granted handles. */
export async function openLocalPath(input: string): Promise<void> {
  const path = resolveLocalUserPath(input, { baseDir: process.cwd() })
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}

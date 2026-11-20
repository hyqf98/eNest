import { lstat, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'

export async function existingOwnedDirectory(root: string, ...children: string[]): Promise<string | null> {
  try {
    let directory = await realpath(root)
    for (const child of children) {
      if (!child || child === '.' || child === '..' || basename(child) !== child) throw new Error('Invalid directory component')
      directory = join(directory, child)
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error(`Unsafe directory: ${directory}`)
    }
    return directory
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

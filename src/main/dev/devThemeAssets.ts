import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isPluginAssetPath } from '@shared/pluginContract'
import type { ThemePackV2 } from '@shared/types/appearance'
import type { PluginManifest } from '@shared/types/plugin'
import { installFromDirectory } from '@main/plugin/PluginInstaller'

function themeDeclarations(manifest: PluginManifest) {
  return {
    homePages: manifest.contributes?.homePages ?? [],
    themePacks: manifest.contributes?.themePacks ?? []
  }
}

function themeEntries(manifest: PluginManifest): string[] {
  const declarations = themeDeclarations(manifest)
  return [...new Set([
    ...declarations.homePages.map(home => home.entry),
    ...declarations.themePacks.flatMap(pack => {
      const { quick, chrome, settingsPage } = pack as Partial<ThemePackV2>
      return [
        ...(quick ? [quick.entry] : []),
        ...(settingsPage ? [settingsPage.entry] : []),
        ...(['classic', 'rail', 'dock'] as const).flatMap(part => chrome?.[part] ? [chrome[part]!.entry] : [])
      ]
    })
  ])]
}

async function hasThemeEntries(root: string, entries: string[]): Promise<boolean> {
  try {
    const canonicalRoot = await realpath(root)
    const present = await Promise.all(entries.map(async entry => {
      if (!isPluginAssetPath(entry) || !entry.endsWith('.html')) return false
      const parts = entry.split('/')
      let cursor = canonicalRoot
      for (let index = 0; index < parts.length; index++) {
        cursor = join(cursor, parts[index])
        const info = await lstat(cursor)
        if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) return false
      }
      return true
    }))
    return present.every(Boolean)
  } catch { return false }
}

/** Restricted theme surfaces use one local asset root independently of the business dev server. */
export async function inspectDevThemeRoot(sourcePath: string, manifest: PluginManifest, output: string): Promise<string> {
  const entries = themeEntries(manifest)
  if (!entries.length || await hasThemeEntries(sourcePath, entries)) return sourcePath
  const outputPath = join(sourcePath, output)
  try {
    // Full published-package validation rejects escaped/symlinked entries and incomplete output.
    const built = await installFromDirectory(outputPath)
    if (built.id === manifest.id && built.version === manifest.version
      && isDeepStrictEqual(themeDeclarations(built), themeDeclarations(manifest))) return outputPath
  } catch { /* Keep the source selected so the existing surface recovery reports unavailable assets. */ }
  return sourcePath
}

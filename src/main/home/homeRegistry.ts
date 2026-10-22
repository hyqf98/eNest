import { join } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { HomePageContribution } from '@shared/types/appearance'
import type { HomePageRegistrationResult } from '@shared/types/home'
import { contributionRegistry } from '@main/contrib/ContributionRegistry'
import { pluginRegistry } from '@main/plugin/PluginRegistry'
import { logWarn } from '@main/logs/logService'
import { isInsideDirectory } from './homeSecurity'
import {
  BUILT_IN_HOME_ID,
  BUILT_IN_HOME_SOURCE,
  BUILT_IN_HOME_PAGE,
  validateHomeContribution
} from './homeContract'

export interface ResolvedHomePage {
  contribution: HomePageContribution
  rootPath: string
  entryPath: string
}

export function builtinHomeReference(): HomePageContribution {
  return {
    ...BUILT_IN_HOME_PAGE,
    variants: [...BUILT_IN_HOME_PAGE.variants]
  }
}

export function listHomeContributions(): Array<{ source: string; contribution: HomePageContribution }> {
  const results: Array<{ source: string; contribution: HomePageContribution }> = []
  for (const row of contributionRegistry.listSlot('home-pages')) {
    const contribution = validateHomeContribution(row.data, row.source)
    if (contribution && currentManifestContribution(row.source, contribution.id, contribution)) {
      results.push({ source: row.source, contribution })
    }
  }
  return results
}

function currentManifestContribution(source: string, id: string, cached?: HomePageContribution): HomePageContribution | null {
  const installed = pluginRegistry.getInstalledDescriptors().find(entry => entry.id === source && entry.enabled)
  if (!installed) return null
  const declared = validateHomeContribution(
    pluginRegistry.getManifest(source)?.contributes?.homePages?.find(item => item.id === id),
    source
  )
  if (!declared || (cached && JSON.stringify(declared) !== JSON.stringify(cached))) return null
  return declared
}

/** Runtime registration cannot mint a new entry, change another source, or activate a theme. */
export async function registerDeclaredHomeContribution(source: string, input: unknown): Promise<HomePageRegistrationResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid home contribution' }
  const contribution = validateHomeContribution({ ...input, source }, source)
  if (!contribution) return { ok: false, error: 'invalid home contribution' }
  const declared = currentManifestContribution(source, contribution.id, contribution)
  if (!declared) return { ok: false, error: 'home entry must exactly match an enabled installed manifest declaration' }
  const page = await resolveHomePage(source, declared.id, declared.variants[0])
  if (!page) return { ok: false, error: 'declared home entry is unavailable' }
  if (!currentManifestContribution(source, declared.id, declared)) return { ok: false, error: 'home contribution changed during registration' }
  return { ok: true, contribution: declared }
}

function declaredContributionFor(source: string, id: string, variant: string): HomePageContribution | null {
  const contribution = source === BUILT_IN_HOME_SOURCE && id === BUILT_IN_HOME_ID
    ? builtinHomeReference()
    : listHomeContributions().find(item => item.source === source && item.contribution.id === id)?.contribution
  if (!contribution || !contribution.variants.includes(variant)) return null

  // Persisted rows are a cache; the enabled installed manifest remains authoritative.
  if (source !== BUILT_IN_HOME_SOURCE) {
    if (!currentManifestContribution(source, id, contribution)) return null
  }
  return contribution
}

export async function resolveHomePage(source: string, id: string, variant: string): Promise<ResolvedHomePage | null> {
  const contribution = declaredContributionFor(source, id, variant)
  if (!contribution) return null
  if (source === BUILT_IN_HOME_SOURCE) {
    // Renderer output is host-owned. The view cannot select a sibling file.
    const entryPath = join(__dirname, '..', 'renderer', ...contribution.entry.split('/'))
    return { contribution, rootPath: join(entryPath, '..'), entryPath }
  }
  const requestedRoot = pluginRegistry.getAssetRootPath(source)
  if (!requestedRoot) return null
  const entryPath = join(requestedRoot, ...contribution.entry.split('/'))
  let rootPath: string
  let canonicalEntry: string
  try {
    if (!(await stat(entryPath)).isFile()) return null
    rootPath = await realpath(requestedRoot)
    canonicalEntry = await realpath(entryPath)
  } catch {
    logWarn('home', `unavailable entry for ${source}/${id}`)
    return null
  }
  if (!isInsideDirectory(rootPath, canonicalEntry)) {
    logWarn('home', `refused unsafe entry for ${source}/${id}`)
    return null
  }
  return {
    contribution,
    rootPath,
    entryPath: canonicalEntry
  }
}

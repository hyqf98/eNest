import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import { OPEN_WITH_EXT_RE, OPEN_WITH_SCHEME_RE, type OpenWithStatus } from '@shared/types/openWith'
import { run, type OpenWithKind } from './registrar'

interface BundleAssociations {
  bundleId: string
  extensions: string[]
  schemes: string[]
}
interface AssociationQuery { kind: OpenWithKind; value: string }
interface AssociationAnswer { key: string; defaultBundleId: string | null; candidateBundleIds: string[] }

const TTL = 30_000
const MAX_BATCH = 128
const MAX_CACHED_STATUSES = 512
let bundleCache: { value: BundleAssociations | null; expiresAt: number } | undefined
let bundleRead: Promise<BundleAssociations | null> | undefined
const statuses = new Map<string, { expiresAt: number; value: OpenWithStatus | undefined }>()
let detection: Promise<void> | undefined

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

async function readBundle(): Promise<BundleAssociations | null> {
  const executableDirectory = dirname(app.getPath('exe'))
  const contents = dirname(executableDirectory)
  if (basename(executableDirectory) !== 'MacOS' || basename(contents) !== 'Contents') return null
  const result = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', join(contents, 'Info.plist')], 3000)
  if (result.code !== 0) return null
  try {
    const plist = record(JSON.parse(result.stdout))
    const bundleId = plist?.CFBundleIdentifier
    if (typeof bundleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(bundleId)) return null
    const documents = Array.isArray(plist?.CFBundleDocumentTypes) ? plist.CFBundleDocumentTypes : []
    const protocols = Array.isArray(plist?.CFBundleURLTypes) ? plist.CFBundleURLTypes : []
    return {
      bundleId,
      extensions: [...new Set(documents.flatMap(item => strings(record(item)?.CFBundleTypeExtensions))
        .map(value => value.toLowerCase()).filter(value => OPEN_WITH_EXT_RE.test(value)))],
      schemes: [...new Set(protocols.flatMap(item => strings(record(item)?.CFBundleURLSchemes))
        .map(value => value.toLowerCase()).filter(value => OPEN_WITH_SCHEME_RE.test(value)))]
    }
  } catch { return null }
}

/** Read the running app's package, never the checkout's build snapshot or a fixed bundle ID. */
export function getDarwinBundleAssociations(): Promise<BundleAssociations | null> {
  if (!app.isPackaged) return Promise.resolve(null)
  if (bundleCache && bundleCache.expiresAt > Date.now()) return Promise.resolve(bundleCache.value)
  if (!bundleRead) {
    bundleRead = readBundle().catch(() => null).then(value => {
      bundleCache = { value, expiresAt: value ? Infinity : Date.now() + TTL }
      return value
    }).finally(() => { bundleRead = undefined })
  }
  return bundleRead
}

// NSWorkspace returns Objective-C objects, unlike the opaque CF refs returned by old LS APIs.
// Preferences are not authoritative: LaunchServices also resolves UTI and installed-app defaults.
const QUERY_SOURCE = String.raw`
ObjC.import('AppKit');
ObjC.import('UniformTypeIdentifiers');
function nil(value) {
  return value === null || value === undefined || (typeof value.isNil === 'function' && value.isNil());
}
function bundleId(url) {
  if (nil(url)) return null;
  var bundle = $.NSBundle.bundleWithURL(url);
  if (nil(bundle)) throw new Error('Application bundle is unavailable');
  var id = ObjC.unwrap(bundle.bundleIdentifier);
  if (typeof id !== 'string' || !id.length) throw new Error('Invalid application identifier');
  return id;
}
function candidateIds(urls) {
  if (nil(urls)) throw new Error('Candidate query is unavailable');
  var count = ObjC.unwrap(urls.count);
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 10000) {
    throw new Error('Invalid candidate list');
  }
  var ids = [];
  for (var i = 0; i < count; i++) {
    var id = bundleId(urls.objectAtIndex(i));
    if (id === null) throw new Error('Invalid candidate application');
    ids.push(id);
  }
  return ids;
}
function run(argv) {
  var queries = JSON.parse(argv[0]);
  var workspace = $.NSWorkspace.sharedWorkspace;
  return JSON.stringify(queries.map(function(query) {
    var key = query.kind + ':' + query.value;
    try {
      var defaultHandler, handlers;
      if (query.kind === 'scheme') {
        var url = $.NSURL.URLWithString(query.value + ':');
        if (nil(url)) return {key: key};
        defaultHandler = workspace.URLForApplicationToOpenURL(url);
        handlers = workspace.URLsForApplicationsToOpenURL(url);
      } else {
        var type = $.UTType.typeWithFilenameExtension(query.value);
        if (nil(type)) return {key: key};
        defaultHandler = workspace.URLForApplicationToOpenContentType(type);
        handlers = workspace.URLsForApplicationsToOpenContentType(type);
      }
      return {key: key, defaultBundleId: bundleId(defaultHandler), candidateBundleIds: candidateIds(handlers)};
    } catch (error) { return {key: key}; }
  }));
}
`

async function readStatuses(bundle: BundleAssociations, queries: AssociationQuery[]): Promise<void> {
  let answers: unknown
  try {
    const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', QUERY_SOURCE, JSON.stringify(queries)], 5000)
    if (result.code === 0) answers = JSON.parse(result.stdout)
  } catch { /* An unavailable system bridge must remain unknown, never become candidate. */ }
  const rows = new Map<string, AssociationAnswer>()
  if (Array.isArray(answers)) {
    for (const raw of answers) {
      const answer = record(raw)
      if (typeof answer?.key !== 'string' || answer.defaultBundleId !== null && typeof answer.defaultBundleId !== 'string'
        || !Array.isArray(answer.candidateBundleIds) || answer.candidateBundleIds.some(value => typeof value !== 'string')) continue
      rows.set(answer.key, answer as unknown as AssociationAnswer)
    }
  }
  const ours = bundle.bundleId.toLowerCase()
  for (const query of queries) {
    const key = `${query.kind}:${query.value}`, answer = rows.get(key)
    const value: OpenWithStatus | undefined = !answer ? undefined
      : answer.defaultBundleId?.toLowerCase() === ours ? 'default'
        : answer.candidateBundleIds.some(id => id.toLowerCase() === ours) ? 'candidate' : 'unregistered'
    statuses.delete(key)
    statuses.set(key, { expiresAt: Date.now() + TTL, value })
    while (statuses.size > MAX_CACHED_STATUSES) statuses.delete(statuses.keys().next().value!)
  }
}

/** Prime the package's declared types in one read instead of spawning a process for every row. */
export async function detectDarwinAssociation(kind: OpenWithKind, value: string): Promise<OpenWithStatus | undefined> {
  if (!app.isPackaged || !(kind === 'ext' ? OPEN_WITH_EXT_RE : OPEN_WITH_SCHEME_RE).test(value)) return undefined
  const bundle = await getDarwinBundleAssociations()
  if (!bundle) return undefined
  const key = `${kind}:${value}`
  const cached = statuses.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  while (detection) {
    await detection
    const completed = statuses.get(key)
    if (completed && completed.expiresAt > Date.now()) return completed.value
  }
  for (const [cacheKey, entry] of statuses) if (entry.expiresAt <= Date.now()) statuses.delete(cacheKey)
  const queries = new Map<string, AssociationQuery>([[key, { kind, value }]])
  for (const extension of bundle.extensions) queries.set(`ext:${extension}`, { kind: 'ext', value: extension })
  for (const scheme of bundle.schemes) queries.set(`scheme:${scheme}`, { kind: 'scheme', value: scheme })
  detection = readStatuses(bundle, [...queries.values()].slice(0, MAX_BATCH)).finally(() => { detection = undefined })
  await detection
  return statuses.get(key)?.value
}

export async function refreshDarwinAssociation(kind: OpenWithKind, value: string): Promise<OpenWithStatus | undefined> {
  await detection
  statuses.delete(`${kind}:${value}`)
  return detectDarwinAssociation(kind, value)
}

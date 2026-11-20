import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import { validOpenWithValue, type OpenWithStatus } from '@shared/types/openWith'
import { run, type OpenWithKind } from './registrar'

interface BundleAssociations {
  bundleId: string
  extensions: string[]
  schemes: string[]
}
let bundleCache: BundleAssociations | undefined
let bundleRead: Promise<BundleAssociations | null> | undefined

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
      extensions: [...new Set(documents.filter(item => record(item)?.CFBundleTypeRole !== 'None' && record(item)?.LSHandlerRank !== 'None')
        .flatMap(item => strings(record(item)?.CFBundleTypeExtensions))
        .map(value => value.toLowerCase()).filter(value => validOpenWithValue('ext', value)))],
      schemes: [...new Set(protocols.filter(item => record(item)?.CFBundleTypeRole !== 'None').flatMap(item => strings(record(item)?.CFBundleURLSchemes))
        .map(value => value.toLowerCase()).filter(value => validOpenWithValue('scheme', value)))]
    }
  } catch { return null }
}

/** Read the running app's package, never the checkout's build snapshot or a fixed bundle ID. */
export function getDarwinBundleAssociations(): Promise<BundleAssociations | null> {
  if (!app.isPackaged) return Promise.resolve(null)
  if (bundleCache) return Promise.resolve(bundleCache)
  if (!bundleRead) {
    bundleRead = readBundle().catch(() => null).then(value => {
      if (value) bundleCache = value
      return value
    }).finally(() => { bundleRead = undefined })
  }
  return bundleRead
}

// NSWorkspace returns Objective-C objects, unlike the opaque CF refs returned by old LS APIs.
// Preferences are not authoritative: LaunchServices also resolves UTI and installed-app defaults.
// UTType is resolved through NSClassFromString: ObjC.import('UniformTypeIdentifiers') fails on
// recent macOS, which silently disabled every association query.
const QUERY_SOURCE = String.raw`
ObjC.import('AppKit');
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
  var query = JSON.parse(argv[0]);
  var workspace = $.NSWorkspace.sharedWorkspace;
  var defaultHandler, handlers;
  if (query.kind === 'scheme') {
    var url = $.NSURL.URLWithString(query.value + ':');
    if (nil(url)) throw new Error('Invalid URL');
    defaultHandler = workspace.URLForApplicationToOpenURL(url);
    handlers = workspace.URLsForApplicationsToOpenURL(url);
  } else {
    var typeClass = $.NSClassFromString ? $.NSClassFromString('UTType') : $.UTType;
    if (nil(typeClass)) throw new Error('UTType is unavailable');
    var type = typeClass.typeWithFilenameExtension(query.value);
    if (nil(type)) throw new Error('Unknown file type');
    defaultHandler = workspace.URLForApplicationToOpenContentType(type);
    handlers = workspace.URLsForApplicationsToOpenContentType(type);
  }
  return JSON.stringify({defaultBundleId: bundleId(defaultHandler), candidateBundleIds: candidateIds(handlers)});
}
`

export async function detectDarwinAssociation(kind: OpenWithKind, value: string): Promise<OpenWithStatus | undefined> {
  if (!app.isPackaged || !validOpenWithValue(kind, value)) return undefined
  const bundle = await getDarwinBundleAssociations()
  if (!bundle) return undefined
  try {
    const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', QUERY_SOURCE, JSON.stringify({ kind, value })], 5000)
    if (result.code !== 0) return undefined
    const answer = record(JSON.parse(result.stdout))
    if (!answer || (answer.defaultBundleId !== null && typeof answer.defaultBundleId !== 'string')
      || !Array.isArray(answer.candidateBundleIds) || answer.candidateBundleIds.some(id => typeof id !== 'string')) return undefined
    const ours = bundle.bundleId.toLowerCase()
    return answer.defaultBundleId?.toLowerCase() === ours ? 'default'
      : answer.candidateBundleIds.some(id => id.toLowerCase() === ours) ? 'candidate' : 'unregistered'
  } catch { return undefined }
}

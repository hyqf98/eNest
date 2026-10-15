import { createRequire } from 'node:module'
import { copyFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const sourceExtensions = /\.[cm]?[jt]sx?$/
const noticeName = /^(?:licen[cs]e|copying|copyright|notice|third[-_ ]party)(?:$|[._ -])/i

async function packageDirectory(name, fromDirectory) {
  const require = createRequire(join(fromDirectory, 'package.json'))
  try { return dirname(require.resolve(`${name}/package.json`)) } catch { /* Some packages export only their entry point. */ }
  let dir = dirname(require.resolve(name))
  while (true) {
    try {
      const info = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      if (info.name === name) return dir
    } catch { /* Continue to the package root. */ }
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`Cannot locate license metadata for bundled package: ${name}`)
    dir = parent
  }
}

export async function rendererPackages(sourceDir) {
  const packages = new Set()
  const add = name => {
    if (/^(?:\.|\/|node:|@(?:renderer|shared|main|preload)\/)/.test(name)) return
    packages.add(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0])
  }
  const visitDirectory = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) await visitDirectory(file)
      else if (entry.isFile() && sourceExtensions.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
        const visit = node => {
          if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text)
          if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text)
          if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0].text)
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
  }
  await visitDirectory(sourceDir)
  return [...packages].sort()
}

export async function collectBundledLicenses({ projectDir = process.cwd(), sourceDir = join(projectDir, 'src/renderer'), outputDir = join(projectDir, 'out/licenses/bundled-ui') } = {}) {
  const seeds = await rendererPackages(sourceDir), visited = new Set(), packages = []
  const visitPackage = async (name, fromDirectory) => {
    const dir = await realpath(await packageDirectory(name, fromDirectory))
    if (visited.has(dir)) return
    visited.add(dir)
    const info = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const files = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile() && noticeName.test(entry.name)).map(entry => entry.name)
    if (!files.length) {
      // GSAP publishes its copyright and complete license reference in README/package metadata.
      const readme = (await readdir(dir)).find(file => /^readme(?:\.|$)/i.test(file))
      if (!readme || !/(?:license|licence|copyright)/i.test(await readFile(join(dir, readme), 'utf8'))) throw new Error(`Bundled package ${info.name} has no license notice`)
      files.push(readme)
    }
    const destination = `${info.name.replaceAll('/', '__')}@${info.version}`
    packages.push({ name: info.name, version: info.version, license: info.license || info.licenses || null, repository: info.repository || null, destination, files, dir })
    for (const dependency of Object.keys(info.dependencies || {}).sort()) await visitPackage(dependency, dir)
  }
  for (const name of seeds) await visitPackage(name, projectDir)
  packages.sort((a, b) => a.destination.localeCompare(b.destination))
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })
  for (const { dir, destination, files, ...metadata } of packages) {
    const target = join(outputDir, destination)
    await mkdir(target)
    for (const file of files) await copyFile(join(dir, file), join(target, file))
    await writeFile(join(target, 'package-notice.json'), JSON.stringify(metadata, null, 2) + '\n')
  }
  const manifest = { source: 'Renderer runtime imports and their transitive dependencies; license notices retained after bundling', roots: seeds, packages: packages.map(({ dir, ...metadata }) => metadata) }
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await collectBundledLicenses()
  console.log(`Retained bundled UI license notices for ${result.packages.length} packages`)
}

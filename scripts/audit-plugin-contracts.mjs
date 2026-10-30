#!/usr/bin/env node
/** Static inventory only: parses source without importing or running application code. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const models = new Map()
const failures = new Set()
const summaries = []
const securityPath = 'src/main/ipc/ipcSecurity.ts'
const homePath = 'src/main/home/homeIpc.ts'
const key = path => relative(root, path).split(sep).join('/')
const location = node => {
  const source = node.getSourceFile()
  const position = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${key(source.fileName)}:${position.line + 1}:${position.character + 1}`
}
const fail = (node, message) => failures.add(`${location(node)}: ${message}`)

function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

function filesUnder(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      failures.add(`${key(child)}: BOUNDARY: symlink prevents a complete source inventory`)
      return []
    }
    return entry.isDirectory() ? filesUnder(child) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [child] : []
  })
}

function load(path) {
  path = resolve(root, path)
  if (models.has(path)) return models.get(path)
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const model = { path, source, imports: new Map(), constants: new Map() }
  models.set(path, model)
  for (const error of source.parseDiagnostics) {
    failures.add(`${key(path)}:${source.getLineAndCharacterOfPosition(error.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`)
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
      const bindings = statement.importClause.namedBindings
      const module = statement.moduleSpecifier.text
      if (bindings && ts.isNamespaceImport(bindings)) model.imports.set(bindings.name.text, { module, name: '*', node: bindings })
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (!binding.isTypeOnly) model.imports.set(binding.name.text, { module, name: (binding.propertyName ?? binding.name).text, node: binding })
        }
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) model.constants.set(declaration.name.text, declaration)
      }
    }
  }
  return model
}

function modulePath(model, name) {
  const base = name.startsWith('.') ? resolve(dirname(model.path), name)
    : /^@(main|preload|shared)\//.test(name) ? join(root, 'src', name.slice(1)) : null
  if (!base) throw new Error(`unsupported module ${name}`)
  const path = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(candidate => existsSync(candidate) && /\.[cm]?[jt]sx?$/.test(candidate))
  if (!path) throw new Error(`unresolved module ${name}`)
  return path
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))) node = node.expression
  return node
}

// This intentionally small evaluator fails closed when a contract becomes dynamic.
function evaluate(node, model = load(node.getSourceFile().fileName), seen = new Set()) {
  node = unwrap(node)
  if (!node) throw new Error('missing expression')
  if (seen.has(node)) throw new Error('cyclic static expression')
  seen = new Set(seen).add(node)
  if (ts.isStringLiteralLike(node)) return node.text
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isIdentifier(node)) {
    const imported = model.imports.get(node.text)
    if (imported) {
      const target = load(modulePath(model, imported.module))
      if (imported.name === '*') return { namespace: target }
      return constant(target, imported.name, seen)
    }
    return constant(model, node.text, seen)
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const object = evaluate(node.expression, model, seen)
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : evaluate(node.argumentExpression, model, seen)
    if (object?.namespace) return constant(object.namespace, name, seen)
    if (object instanceof Map && object.has(name)) return object.get(name).value
    throw new Error(`unknown static property ${name}`)
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result = new Map()
    const add = (name, value, origin) => {
      if (result.has(name)) fail(origin, `duplicate static key ${name}; first at ${location(result.get(name).node)}`)
      result.set(name, { value, node: origin })
    }
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = evaluate(property.expression, model, seen)
        if (!(spread instanceof Map)) throw new Error('object spread is not a static object')
        for (const [name, entry] of spread) add(name, entry.value, entry.node)
      } else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const name = ts.isComputedPropertyName(property.name) ? evaluate(property.name.expression, model, seen) : property.name.text
        if (typeof name !== 'string') throw new Error('object key is not a string')
        add(name, evaluate(ts.isPropertyAssignment(property) ? property.initializer : property.name, model, seen), property)
      } else throw new Error(`unsupported object member ${ts.SyntaxKind[property.kind]}`)
    }
    return result
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap(element => {
      if (!ts.isSpreadElement(element)) return [evaluate(element, model, seen)]
      const spread = evaluate(element.expression, model, seen)
      if (!Array.isArray(spread)) throw new Error('array spread is not a static array')
      return spread
    })
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Set' && node.arguments?.length === 1) {
    const values = evaluate(node.arguments[0], model, seen)
    if (!Array.isArray(values)) throw new Error('Set input is not a static array')
    return values
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object'
    && node.expression.name.text === 'freeze' && node.arguments.length === 1) return evaluate(node.arguments[0], model, seen)
  throw new Error(`unsupported ${ts.SyntaxKind[node.kind]}: ${node.getText().slice(0, 100)}`)
}

function constant(model, name, seen = new Set()) {
  const declaration = model.constants.get(name)
  if (!declaration?.initializer || !(declaration.parent.flags & ts.NodeFlags.Const)) throw new Error(`unresolved or non-const binding ${name} in ${key(model.path)}`)
  return evaluate(declaration.initializer, model, seen)
}

function attempt(node, operation, fallback) {
  try { return operation() } catch (error) {
    fail(node, `BOUNDARY: ${error.message}`)
    return fallback
  }
}

function stringValue(node) {
  return attempt(node, () => {
    const value = evaluate(node)
    if (typeof value !== 'string') throw new Error('contract name is not a static string')
    return value
  }, null)
}

const isName = (node, name) => !!node && ts.isIdentifier(node) && node.text === name

function requireOne(model, predicate, label) {
  const nodes = []
  walk(model.source, node => { if (predicate(node)) nodes.push(node) })
  if (nodes.length !== 1) fail(model.source, `expected exactly one ${label}; found ${nodes.length}`)
  return nodes.length === 1 ? nodes[0] : null
}

function addMethod(methods, name, node, unique) {
  if (name === null) return
  if (unique && methods.has(name)) fail(node, `duplicate method ${name}; first at ${location(methods.get(name))}`)
  if (!methods.has(name)) methods.set(name, node)
}

function wrapperMethods(path, name, callers = [path]) {
  const model = load(path), methods = new Map()
  const declaration = requireOne(model, node => ts.isFunctionDeclaration(node) && node.name?.text === name, `${name}() wrapper`)
  let count = 0
  const audited = new Set(callers)
  for (const file of filesUnder(join(root, 'src/preload'))) {
    const caller = load(file), localNames = new Set()
    for (const statement of caller.source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.moduleSpecifier
        || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
      const specifier = statement.moduleSpecifier.text
      if (!(specifier.startsWith('.') || specifier.startsWith('@preload/'))
        || !attempt(statement, () => key(modulePath(caller, specifier)) === path, false)) continue
      const clause = statement.exportClause
      if (!clause || ts.isNamespaceExport(clause) || clause.elements.some(item => !item.isTypeOnly && (item.propertyName ?? item.name).text === name)) {
        fail(statement, `BOUNDARY: re-exporting ${path}:${name} hides wrapper usage`)
      }
    }
    walk(caller.source, node => {
      if (!ts.isCallExpression(node) || !(node.expression.kind === ts.SyntaxKind.ImportKeyword || isName(node.expression, 'require'))
        || !node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) return
      const specifier = node.arguments[0].text
      if ((specifier.startsWith('.') || specifier.startsWith('@preload/'))
        && attempt(node, () => key(modulePath(caller, specifier)) === path, false)) {
        fail(node, `BOUNDARY: dynamic loading of ${path} hides ${name} wrapper usage`)
      }
    })
    if (key(file) === path) localNames.add(name)
    for (const [local, imported] of caller.imports) {
      if (imported.name === '*' && (imported.module.startsWith('.') || imported.module.startsWith('@preload/'))
        && attempt(imported.node, () => key(modulePath(caller, imported.module)) === path, false)) {
        fail(imported.node, `BOUNDARY: namespace import of ${path} hides ${name} wrapper usage`)
      }
      if (imported.name === name && importedName(imported.node.name, path, name)) localNames.add(local)
    }
    if (!localNames.size) {
      if (audited.has(key(file))) fail(caller.source, `BOUNDARY: expected a direct import of ${path}:${name}`)
      continue
    }
    if (key(file) !== path && !audited.has(key(file))) {
      fail(caller.source, `BOUNDARY: ${path}:${name} is used outside its explicit audited modules`)
    }
    walk(caller.source, node => {
      if (!ts.isIdentifier(node) || !localNames.has(node.text)) return
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
        || (ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node
        || ts.isBindingElement(node.parent) && node.parent.propertyName === node) return
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isImportDeclaration(parent) || ts.isTypeNode(parent)) return
      }
      if (node.parent === declaration && declaration?.name === node) return
      const call = node.parent
      if (!ts.isCallExpression(call) || call.expression !== node) {
        fail(node, `BOUNDARY: ${name} wrapper aliasing, shadowing or indirect use cannot be inventoried`)
        return
      }
      count++
      const method = unwrap(call.arguments[0])
      if (!method || !ts.isStringLiteralLike(method)) fail(call, `BOUNDARY: ${name}() method must be a direct string literal`)
      else addMethod(methods, method.text, call, false)
    })
  }
  if (!count) fail(model.source, `no ${name}() method calls found`)
  return { methods, count }
}

function dispatchMethods(path, name, member = false) {
  const model = load(path), methods = new Map()
  const owner = requireOne(model, node => (member ? ts.isMethodDeclaration(node) : ts.isFunctionDeclaration(node))
    && node.name?.getText() === name, `${name} dispatcher`)
  if (!owner) return methods
  const switches = []
  walk(owner, node => {
    if (ts.isSwitchStatement(node) && isName(node.expression, 'method')) switches.push(node)
  })
  if (switches.length !== 1) fail(owner, `expected one switch(method); found ${switches.length}`)
  for (const statement of switches) {
    for (const clause of statement.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) addMethod(methods, stringValue(clause.expression), clause, true)
    }
  }
  return methods
}

function compare(left, right, leftName, rightName) {
  for (const [name, node] of left) if (!right.has(name)) fail(node, `${leftName} ${name} has no ${rightName}`)
  for (const [name, node] of right) if (!left.has(name)) fail(node, `${rightName} ${name} has no ${leftName}`)
}

function permissionMethods(path, name) {
  const model = load(path), declaration = model.constants.get(name)
  const value = attempt(declaration ?? model.source, () => constant(model, name), new Map())
  const methods = new Map()
  if (!(value instanceof Map)) fail(declaration ?? model.source, `${name} is not a static object`)
  else for (const [method, entry] of value) {
    if (entry.value !== null && typeof entry.value !== 'string') fail(entry.node, `permission for ${method} is not a string or null`)
    methods.set(method, entry.node)
  }
  return methods
}

function importedName(node, module, name) {
  if (!ts.isIdentifier(node)) return false
  const model = load(node.getSourceFile().fileName), imported = model.imports.get(node.text)
  if (!imported || imported.name !== name) return false
  if (module === 'electron') return imported.module === module
  return attempt(node, () => key(modulePath(model, imported.module)) === module, false)
}

function electronMember(node, owner) {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null
  if (!importedName(node.expression, 'electron', owner)) return null
  return ts.isPropertyAccessExpression(node) ? node.name.text : stringValue(node.argumentExpression)
}

function inspectIpcReference(node, owner) {
  if (!ts.isIdentifier(node) || !importedName(node, 'electron', owner)) return
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isImportDeclaration(parent) || ts.isTypeNode(parent)) return
  }
  const access = node.parent
  if (!(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) || access.expression !== node
    || !ts.isCallExpression(access.parent) || access.parent.expression !== access) {
    fail(node, `BOUNDARY: ${owner} aliasing or indirect use cannot be inventoried`)
  }
}

const forwardedRegistrations = new Set()
const wrappers = new Map()

function registerWrapper(path, name, kind, local = false) {
  const model = load(path)
  const declaration = requireOne(model, node => local
    ? ts.isVariableDeclaration(node) && isName(node.name, name)
    : ts.isFunctionDeclaration(node) && node.name?.text === name, `${name} IPC registration wrapper`)
  if (!declaration) return
  const fn = local ? unwrap(declaration.initializer) : declaration
  if (!fn || !ts.isFunctionLike(fn) || !fn.body || !isName(fn.parameters[0]?.name, 'channel')) {
    fail(declaration, `BOUNDARY: unsupported ${name} wrapper declaration`)
    return
  }
  const forwards = [], guards = []
  walk(fn.body, node => {
    if (!ts.isCallExpression(node)) return
    if (electronMember(node.expression, 'ipcMain') === kind) forwards.push(node)
    if (isName(node.expression, 'assertSurfaceSender')) guards.push(node)
  })
  if (forwards.length !== 1 || !isName(forwards[0].arguments[0], 'channel')
    || !guards.some(guard => isName(guard.arguments[1], 'channel'))) {
    fail(declaration, `BOUNDARY: ${name} must forward its channel once with assertSurfaceSender`)
    return
  }
  forwardedRegistrations.add(forwards[0])
  wrappers.set(`${path}:${name}`, { kind, declaration, local })
}

function registrationWrapper(node) {
  if (!ts.isIdentifier(node.expression)) return null
  const model = load(node.getSourceFile().fileName)
  for (const [id, wrapper] of wrappers) {
    const [path, name] = id.split(':')
    if (wrapper.local) {
      if (key(model.path) === path && node.expression.text === name) {
        // The home wrapper is block-local, not a global function with a matching name.
        const scope = wrapper.declaration.parent.parent.parent
        if (node.pos >= scope.pos && node.end <= scope.end) return wrapper
        fail(node, `BOUNDARY: ${name} call is outside its known wrapper scope`)
      }
    } else if (importedName(node.expression, path, name)) return wrapper
  }
  return null
}

function ipcInventory(preloads, mainFiles) {
  const requests = [], receivers = []
  for (const path of [...preloads, ...mainFiles]) {
    const model = load(path), preload = preloads.includes(path)
    walk(model.source, node => {
      inspectIpcReference(node, preload ? 'ipcRenderer' : 'ipcMain')
      if (!ts.isCallExpression(node)) return
      const method = electronMember(node.expression, preload ? 'ipcRenderer' : 'ipcMain')
      const wrapper = preload ? null : registrationWrapper(node)
      if (forwardedRegistrations.has(node)) return
      let kind
      if (preload && (method === 'invoke' || method === 'send')) kind = method
      else if (!preload && ['handle', 'handleOnce', 'on', 'once'].includes(wrapper?.kind ?? method)) {
        kind = ['handle', 'handleOnce'].includes(wrapper?.kind ?? method) ? 'invoke' : 'send'
      } else {
        if (method && !(preload ? ['on', 'once', 'removeListener', 'removeAllListeners'] : ['removeHandler', 'removeListener', 'removeAllListeners']).includes(method)) {
          fail(node, `BOUNDARY: unsupported IPC operation ${method}`)
        }
        return
      }
      if (!node.arguments[0]) { fail(node, 'IPC call has no channel'); return }
      const channel = stringValue(node.arguments[0])
      if (channel !== null) (preload ? requests : receivers).push({ channel, kind, node, path: key(path) })
    })
  }
  const registered = new Map(), requested = new Set()
  for (const receiver of receivers) {
    const id = `${receiver.kind}:${receiver.channel}`
    if (receiver.kind === 'invoke' && registered.has(id)) fail(receiver.node, `duplicate invoke receiver ${receiver.channel}; first at ${location(registered.get(id).node)}`)
    registered.set(id, receiver)
  }
  for (const request of requests) {
    const id = `${request.kind}:${request.channel}`
    requested.add(id)
    if (!registered.has(id)) fail(request.node, `${request.kind} ${request.channel} has no matching main receiver`)
  }
  for (const [id, receiver] of registered) {
    if (!requested.has(id)) fail(receiver.node, `${receiver.kind} receiver ${receiver.channel} has no static preload request`)
  }
  summaries.push(`IPC: ${requests.length} preload request sites / ${requested.size} channel-operation pairs; ${receivers.length} receiver sites / ${registered.size} pairs; ${forwardedRegistrations.size} recognized registration wrappers.`)
  return requests
}

function restrictedRoles(requests) {
  const roles = {
    install: 'installPreload', notification: 'notificationPreload', home: 'homePreload',
    detached: 'detachedPluginPreload', modal: 'modalPreload', panel: 'panelPreload', region: 'regionPreload'
  }
  const security = load(securityPath)
  for (const [role, entry] of Object.entries(roles)) {
    const declaration = security.constants.get(`${role}Channels`)
    const allowed = attempt(declaration ?? security.source, () => constant(security, `${role}Channels`), [])
    if (!Array.isArray(allowed) || allowed.some(value => typeof value !== 'string')) {
      fail(declaration ?? security.source, `${role} allowlist is not a static string collection`)
      continue
    }
    const reachable = new Set()
    const include = path => {
      const model = load(path), file = key(model.path)
      if (reachable.has(file)) return
      reachable.add(file)
      for (const imported of model.imports.values()) {
        if (imported.module.startsWith('.') || imported.module.startsWith('@preload/')) {
          attempt(imported.node, () => include(modulePath(model, imported.module)))
        }
      }
    }
    include(`src/preload/${entry}.ts`)
    const roleRequests = requests.filter(request => reachable.has(request.path))
    for (const request of roleRequests) if (!allowed.includes(request.channel)) fail(request.node, `${role} preload request ${request.channel} is outside ${role}Channels`)
    summaries.push(`Restricted ${role}: ${new Set(roleRequests.map(request => request.channel)).size} request channels in ${reachable.size} preload modules checked against ${allowed.length} allowed channels.`)
  }
}

const plugin = wrapperMethods('src/preload/pluginRpc.ts', 'call', ['src/preload/pluginPreload.ts'])
const permissions = permissionMethods('src/main/ipc/pluginHandlers.ts', 'METHOD_PERMISSION')
const dispatch = dispatchMethods('src/main/ipc/pluginHandlers.ts', 'dispatch')
const tools = dispatchMethods('src/main/ipc/pluginToolsHandlers.ts', 'dispatchPluginTool')
const toolPermissions = permissionMethods('src/main/ipc/pluginToolsHandlers.ts', 'PLUGIN_TOOL_PERMISSIONS')
compare(toolPermissions, tools, 'tool permission entry', 'tool dispatch case')
for (const [name, node] of tools) addMethod(dispatch, name, node, true)
compare(plugin.methods, permissions, 'plugin preload method', 'permission entry')
compare(permissions, dispatch, 'permission entry', 'dispatch case')
summaries.push(`Plugin RPC: ${plugin.count} call sites / ${plugin.methods.size} methods; ${permissions.size} permission entries (including ${toolPermissions.size} PLUGIN_TOOL_PERMISSIONS); ${dispatch.size} cases across both dispatchers.`)

const background = wrapperMethods('src/preload/backgroundPreload.ts', 'invoke')
const host = dispatchMethods('src/main/plugin/pluginBackgroundRuntime.ts', 'host', true)
compare(background.methods, host, 'background preload method', 'host dispatch case')
summaries.push(`Background RPC: ${background.count} call sites / ${background.methods.size} methods; ${host.size} host dispatch cases.`)

registerWrapper(securityPath, 'handleShellIpc', 'handle')
registerWrapper(securityPath, 'onShellIpc', 'on')
registerWrapper(homePath, 'handle', 'handle', true)
const preloads = filesUnder(join(root, 'src/preload'))
const mainFiles = filesUnder(join(root, 'src/main'))
const requests = ipcInventory(preloads, mainFiles)
restrictedRoles(requests)

console.log(`Static contract audit: ${preloads.length} preload files and ${mainFiles.length} main files parsed; application code was not executed.`)
for (const summary of summaries) console.log(summary)
console.log('Scope boundary: public API types, argument/result shapes and generated SDK consistency still require typecheck and generator --check separately.')
console.log('Scope boundary: shared shell preload role partitioning, owner validation for plugin/background/chrome/auxiliary surfaces, guard control flow, handler reachability and runtime behavior are not proven by this inventory.')
console.log('Scope boundary: main-to-renderer event delivery and transport implementations other than direct Electron calls or the three recognized wrappers are not inferred.')
if (failures.size) {
  console.error(`Contract audit failed (${failures.size} findings):`)
  for (const failure of [...failures].sort()) console.error(`- ${failure}`)
  process.exitCode = 1
} else console.log('Static contract audit passed (not runtime or public-type acceptance).')

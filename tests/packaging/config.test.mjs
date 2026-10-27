import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import yaml from 'js-yaml'

const require = createRequire(import.meta.url)
const { validateConfiguration } = require('app-builder-lib/out/util/config/config')
const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper')
const configFile = new URL('../../electron-builder.yml', import.meta.url)

test('release configuration validates against the installed electron-builder schema', async () => {
  const configuration = yaml.load(await readFile(configFile, 'utf8'))
  await validateConfiguration(configuration, { isEnabled: false })
  const metadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(metadata.desktopName, `${configuration.appId}.desktop`)
  assert.equal(configuration.linux.desktop.entry.StartupWMClass, configuration.appId)
  const desktopFileName = LinuxTargetHelper.prototype.getDesktopFileName.call({
    packager: { executableName: metadata.name, platformSpecificBuildOptions: configuration.linux, info: { metadata } }
  })
  assert.equal(`${desktopFileName}.desktop`, metadata.desktopName, 'the installed desktop file resolves the Electron Wayland portal identity')
  // Prove the real schema rejects the legacy shape that breaks builder 26 releases.
  const legacy = structuredClone(configuration)
  legacy.linux.desktop = { StartupWMClass: 'enest' }
  await assert.rejects(validateConfiguration(legacy, { isEnabled: false }), /Invalid configuration object/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const host = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-app-boot')))

test('plugin and development Host resolve the same SDK at the tested runtime version', async () => {
  const version = manifest.devDependencies['@deepseek-ai/dsh']
  assert.equal(getDshRuntimeVersion(), version)
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
  for (const name of Object.keys(manifest.peerDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} must use the tested Host version`)
    assert.equal(await realpath(require.resolve(name)), await realpath(host.resolve(name)), `${name} must share its runtime identity with the Host`)
  }
})

test('native compatibility gate accepts supported 0.2.x and rejects old and next-minor runtimes', () => {
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.1', '0.2.5']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
  }
  for (const version of ['0.2.0-rc.2', '0.3.0-rc.1', '0.3.0']) {
    assert.ok(evaluatePluginCompatibility(manifest, {}, version), version)
  }
})

#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { localCs16BackendReady } from './dev.mjs'

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(rootPackage.scripts.dev, 'node scripts/dev.mjs')
assert.equal(rootPackage.scripts['dev:web'], 'vite')
assert.equal(rootPackage.scripts['dev:server'], 'npm --prefix server start')
assert.equal(rootPackage.scripts['start:ssr'], 'npm --prefix server start')

const response = (body, ok = true) => ({ ok, json: async () => body })
assert.equal(await localCs16BackendReady(async () => response({
  enabled: true,
  connections: { active: 0 },
})), true)
assert.equal(await localCs16BackendReady(async () => response({ enabled: true })), false)
assert.equal(await localCs16BackendReady(async () => response({}, false)), false)
assert.equal(await localCs16BackendReady(async () => { throw new TypeError('Failed to fetch') }), false)

const launcher = readFileSync(new URL('../public/web/cs16/cs16.js', import.meta.url), 'utf8')
assert.match(launcher, /The local online backend is not connected\. Restart npm run dev\./)
assert.match(launcher, /Network connection failed\. Please try again later\./)
assert.doesNotMatch(launcher, /const detail = .*String\(error\)/)

console.log('✅ 本地全栈启动与 CS1.6 目录错误提示回归通过')

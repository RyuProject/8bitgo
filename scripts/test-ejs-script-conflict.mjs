#!/usr/bin/env node
/**
 * 引擎脚本解析失败当场判死（src/emulator/engineScriptErrors.ts）回归，不开浏览器：
 *   - 2026-11-19 诊断包 #1331 / #1334 / #1343 的原句（Chrome）与 Firefox / Safari 的同义措辞都认得出重复声明的全局名；
 *   - 只认本站引擎脚本（/emulatorjs/、/_cn/emulatorjs/、本站源 blob 胶水），扩展 / 第三方脚本、非语法错误不算；
 *   - 适配器接线：开局前当场 failLoad，重复声明按 'config'（不自动重试），其它语法错误按 'runtime'；
 *   - 八种语言都有提示；服务端诊断把这句归成 script_conflict，而不是「启动流程超时」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { engineScriptName, engineScriptSyntaxError } from '../src/emulator/engineScriptErrors.ts'
import { diagnoseStartupFailure } from '../server/src/startup-diagnostics.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const ORIGIN = 'https://8bitgo.com'
const LOADER = `${ORIGIN}/emulatorjs/loader.js?v=968fa7e61032e49c`
const syntax = (message) => Object.assign(new Error(message), { name: 'SyntaxError' })

// 现场原句（#1331 / #1334 / #1343）
assert.deepEqual(
  engineScriptSyntaxError({ message: "Uncaught SyntaxError: Identifier 'debug' has already been declared", filename: LOADER, error: syntax("Identifier 'debug' has already been declared") }, ORIGIN),
  { file: LOADER, message: "SyntaxError: Identifier 'debug' has already been declared", redeclared: 'debug' },
)
// 没有 error 对象（老浏览器）也按原文认
assert.equal(engineScriptSyntaxError({ message: "Uncaught SyntaxError: Identifier 'debug' has already been declared", filename: LOADER }, ORIGIN)?.redeclared, 'debug')
// Firefox / Safari 的措辞
assert.equal(engineScriptSyntaxError({ message: 'SyntaxError: redeclaration of let debug', filename: LOADER, error: syntax('redeclaration of let debug') }, ORIGIN)?.redeclared, 'debug')
assert.equal(engineScriptSyntaxError({ message: 'SyntaxError: redeclaration of var EJS_Runtime', filename: LOADER, error: syntax('redeclaration of var EJS_Runtime') }, ORIGIN)?.redeclared, 'EJS_Runtime')
assert.equal(engineScriptSyntaxError({ message: "SyntaxError: Can't create duplicate variable: 'debug'", filename: LOADER, error: syntax("Can't create duplicate variable: 'debug'") }, ORIGIN)?.redeclared, 'debug')
assert.equal(engineScriptSyntaxError({ message: "SyntaxError: Cannot declare a let variable twice: 'debug'", filename: LOADER, error: syntax("Cannot declare a let variable twice: 'debug'") }, ORIGIN)?.redeclared, 'debug')
// 核心胶水是本站源下的 blob；大陆加速入口的引擎目录也算
const blob = `blob:${ORIGIN}/0c8b8f2e-1111-2222-3333-444455556666`
assert.equal(engineScriptSyntaxError({ message: "Uncaught SyntaxError: Identifier 'EJS_Runtime' has already been declared", filename: blob }, ORIGIN)?.redeclared, 'EJS_Runtime')
assert.equal(engineScriptName(blob), '核心胶水（blob）')
assert.ok(engineScriptSyntaxError({ message: 'Uncaught SyntaxError: Unexpected token }', filename: 'https://cn.8bitgo.com/_cn/emulatorjs/loader.js?v=1' }, ORIGIN))
// 其它语法错误：认得出是引擎脚本坏了，但不是重复声明
assert.deepEqual(
  engineScriptSyntaxError({ message: 'Uncaught SyntaxError: Unexpected end of input', filename: LOADER, error: syntax('Unexpected end of input') }, ORIGIN),
  { file: LOADER, message: 'SyntaxError: Unexpected end of input', redeclared: null },
)
assert.equal(engineScriptName(LOADER), 'loader.js')
// 不归我们管的
assert.equal(engineScriptSyntaxError({ message: "Uncaught SyntaxError: Identifier 'debug' has already been declared", filename: 'chrome-extension://abc/inject.js' }, ORIGIN), null, '扩展自己的脚本')
assert.equal(engineScriptSyntaxError({ message: "Uncaught SyntaxError: Identifier 'debug' has already been declared", filename: 'blob:chrome-extension://abc/1' }, ORIGIN), null, '扩展的 blob')
assert.equal(engineScriptSyntaxError({ message: 'Uncaught SyntaxError: x', filename: 'https://8bitgo.com/socket.io/socket.io.js' }, ORIGIN), null, '联机脚本坏了不该判死开局')
assert.equal(engineScriptSyntaxError({ message: 'Script error.', filename: '' }, ORIGIN), null, '跨源被抹掉的错误认不出')
assert.equal(engineScriptSyntaxError({ message: 'Uncaught TypeError: x is not a function', filename: LOADER, error: Object.assign(new Error('x'), { name: 'TypeError' }) }, ORIGIN), null, '只管语法错误')

// 适配器接线
{
  const adapter = read('src/emulator/adapters/emulatorjs.ts')
  assert.match(adapter, /const scriptError = onScriptSyntaxError \? engineScriptSyntaxError\(event, window\.location\.origin\) : null\s*if \(scriptError\) onScriptSyntaxError\?\.\(scriptError\)/, 'iframe 的 error 事件交给分类器')
  assert.match(adapter, /\(scriptError\) => \{\s*if \(started \|\| loadFailed \|\| destroyed\) return/, '只管开局前')
  assert.match(adapter, /if \(scriptError\.redeclared\) return failLoad\(fmt\(rt\.ejsScriptConflict, \{ name: scriptError\.redeclared \}\), 'config'\)/, '重复声明：不自动重试')
  assert.match(adapter, /return failLoad\(fmt\(rt\.ejsEngineError, \{ msg: `\$\{name\}: \$\{scriptError\.message\}` \}\), 'runtime'\)/, '其它语法错误：引擎设施故障')
  // loader.js 自己不往全局写名字（4b46d14），check-emulatorjs 守着；这里再确认一遍包了立即执行函数
  const loader = read('public/emulatorjs/loader.js')
  assert.match(loader.replace(/^(?:\/\/[^\n]*\n)+/, ''), /^\(function \(\) \{/, 'loader.js 整份包在立即执行函数里')
  for (const lang of ['zh-Hans', 'zh-Hant', 'en', 'es', 'fr', 'it', 'de', 'ja']) {
    assert.match(read(`src/locales/${lang}.ts`), /ejsScriptConflict: ['"][^\n]*\{name\}/, `${lang} 有扩展冲突提示`)
  }
}

// 服务端诊断：三份现场的日志归成 script_conflict
{
  const diagnose = (line, detail) => diagnoseStartupFailure({ event: 'failed', platform: 'arcade', detail, diagnostics: { logs: [{ s: 'ejs', l: 'error', m: line }] } })
  assert.equal(diagnose("Uncaught SyntaxError: Identifier 'debug' has already been declared", '加载在「fbneo」这一步停住了。').code, 'script_conflict')
  assert.equal(diagnose("Uncaught SyntaxError: Identifier 'debug' has already been declared", 'Loading got stuck at “fbneo”.').confidence, 'high')
  assert.equal(diagnose('SyntaxError: redeclaration of let debug', '').code, 'script_conflict')
  assert.equal(diagnose('[engine-script] loader.js 解析失败，整份没执行：SyntaxError: Unexpected end of input', '').code, 'engine_asset')
  assert.match(read('src/admin/diagnosticsReport.ts'), /'error\.global_redeclaration':/)
}

console.log('✔ 引擎脚本解析失败：重复声明 / 其它语法错误当场判死（不等看门狗），只认本站引擎脚本，八种语言提示，诊断归类')

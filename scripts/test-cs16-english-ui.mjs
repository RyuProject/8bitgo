#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const HAN = /\p{Script=Han}/u
const root = new URL('../', import.meta.url)

function assertJavaScriptUiIsEnglish(relativePath) {
  const sourceText = readFileSync(new URL(relativePath, root), 'utf8')
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const failures = []
  const visit = (node) => {
    // 注释继续使用中文；这里只检查运行时字符串，避免玩家可见文案以后悄悄混回中文。
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && HAN.test(node.text)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      failures.push(`${relativePath}:${position.line + 1}:${position.character + 1} ${JSON.stringify(node.text)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.deepEqual(failures, [], `CS1.6 JavaScript contains non-English UI strings:\n${failures.join('\n')}`)
}

function assertHtmlUiIsEnglish(relativePath) {
  const sourceText = readFileSync(new URL(relativePath, root), 'utf8')
  // CSS 和 HTML 注释里保留中文工程说明；移除它们后，剩余文字和可访问名称都属于用户界面。
  const uiMarkup = sourceText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  assert.doesNotMatch(uiMarkup, HAN, `${relativePath} contains non-English UI text`)
}

function assertServerResponsesAreEnglish(relativePath, ranges) {
  const sourceText = readFileSync(new URL(relativePath, root), 'utf8')
  for (const [startMarker, endMarker] of ranges) {
    const start = sourceText.indexOf(startMarker)
    const end = sourceText.indexOf(endMarker, start + startMarker.length)
    assert(start >= 0 && end > start, `Could not locate UI response range in ${relativePath}: ${startMarker}`)
    // 后端日志与工程注释仍可使用中文；这些切片只覆盖会回传给启动器的公开字段和 API 响应。
    const responseCode = sourceText.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(responseCode, HAN, `${relativePath} contains a non-English player-facing response near ${startMarker}`)
  }
}

assertHtmlUiIsEnglish('public/web/cs16/index.html')
for (const file of [
  'public/web/cs16/cs16.js',
  'public/web/cs16/cs16-net.js',
  'public/web/cs16/tar-stream.js',
]) {
  assertJavaScriptUiIsEnglish(file)
}

assertServerResponsesAreEnglish('server/src/cs16-relay.js', [
  ['function publicServer(', 'function compatiblePublicServer('],
  ['function automaticServer(', 'function directServer('],
  ['function directServer(', 'async function mapLimited('],
  ["router.post('/servers/resolve'", 'const id = prospectiveId'],
])
assertServerResponsesAreEnglish('server/src/cs16-rooms.js', [
  ["router.post('/rooms'", "router.get('/rooms-status'"],
])

console.log('✅ CS1.6 launcher UI strings are English-only')

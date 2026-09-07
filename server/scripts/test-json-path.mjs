/**
 * MySQL JSON 路径拼接的回归测试。跑：npm run test:json-path
 *
 * ## 为什么会有这份测试
 *
 * 2026-09-07 线上跑 pretranslate 时冒出来一批：
 *
 *     ER_INVALID_JSON_PATH Invalid JSON path expression.
 *     The error is around character position 9.
 *
 * 病灶是三处写库都直接拼 `` `$.${lang}` ``。MySQL 的路径里，成员名**只有在它是合法
 * ECMAScript 标识符时**才能裸写；`zh-Hant` 里那个连字符不是，必须写成 `$."zh-Hant"`。
 *
 * 后果的形状很坏：站点八种语言里只有 zh-Hans / zh-Hant 带连字符，而 zh-Hans 是源文
 * 不需要写 —— 于是**恰好只有繁体全军覆没**，其余六种语言一直好好的，
 * 而失败还被调用方吞掉了。这类「只在某一个取值上错」的 bug 靠人眼几乎看不出来，
 * 所以这里按**站点真实的语言清单**逐个过一遍。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE_LANGUAGES } from '../../shared/site-languages.js'
import { jsonMemberPath } from '../src/db.js'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const read = (f) => readFileSync(path.join(root, f), 'utf8')
/** 去注释再扫：注释里引用一段旧代码会让朴素的 grep 误判 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

let n = 0
const check = (name, fn) => {
  n++
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (e) {
    console.log('  ✗ ' + name)
    throw e
  }
}

/**
 * MySQL 允许裸写成员名的条件：它得是个合法的 ECMAScript 标识符。
 * 这里只实现 ASCII 那部分 —— 够用来说明问题，而这正是「不要自己判、一律加引号」的理由。
 */
const BARE_OK = /^[A-Za-z_$][A-Za-z0-9_$]*$/

console.log('\n一、那个 bug 本身')

check('⭐ zh-Hant 裸写是非法的（这就是 ER_INVALID_JSON_PATH 的成因）', () => {
  assert.ok(!BARE_OK.test('zh-Hant'), 'zh-Hant 不该是合法的裸成员名')
  assert.ok(!BARE_OK.test('zh-Hans'))
  // 而这六种恰好合法 —— 所以线上「只有繁体坏了」，其余一直好好的，没人发现
  for (const l of ['en', 'es', 'fr', 'it', 'de', 'ja']) assert.ok(BARE_OK.test(l), `${l} 应该是合法裸名`)
})

check('⭐ jsonMemberPath 一律加双引号，不做「需要时才加」的判断', () => {
  assert.equal(jsonMemberPath('zh-Hant'), '$."zh-Hant"')
  assert.equal(jsonMemberPath('en'), '$."en"')
  // 「需要时才加」要实现一遍 ECMAScript 标识符规则（还得管 Unicode），
  // 而那正是最初出错的那类聪明写法。无条件加引号一种写法应付所有情况。
  for (const l of ['a', 'zh-Hant-tw', '_x', '$y']) {
    assert.match(jsonMemberPath(l), /^\$\."[^"]*"$/, `${l} 应该被引号包起来`)
  }
})

console.log('\n二、站点真实的语言清单逐个过')

check('⭐ 八种语言全部能拼出合法路径', () => {
  const codes = SITE_LANGUAGES.map((l) => l.code)
  assert.ok(codes.length >= 8, `站点语言只有 ${codes.length} 种？`)
  assert.ok(codes.includes('zh-Hant'), '清单里没有 zh-Hant —— 这条测试的意义就在它身上')
  for (const code of codes) assert.equal(jsonMemberPath(code), `$."${code}"`, `${code} 的路径不对`)
})

check('将来加一种带连字符的语言也不会静默出问题', () => {
  for (const code of ['zh-Hant-tw', 'pt-BR', 'en-GB']) {
    assert.ok(!BARE_OK.test(code), `${code} 裸写会炸`)
    assert.equal(jsonMemberPath(code), `$."${code}"`)
  }
})

console.log('\n三、这个函数自己的兜底')

check('引号和反斜杠会被转义', () => {
  assert.equal(jsonMemberPath('a"b'), '$."a\\"b"')
  assert.equal(jsonMemberPath('a\\b'), '$."a\\\\b"')
})

check('空值和控制字符一律抛', () => {
  for (const bad of ['', null, undefined]) assert.throws(() => jsonMemberPath(bad), /不能为空/)
  assert.throws(() => jsonMemberPath('a\nb'), /控制字符/)
})

console.log('\n四、调用点')

const SITES = [
  ['server/src/games-repo.js', 'writeDescriptionTranslation'],
  ['server/src/games-repo.js', 'writeTitleTranslation'],
  ['server/src/routes/posts.js', 'writePostTranslation'],
]

check('⭐ 三处写库都走 jsonMemberPath，没有裸拼', () => {
  for (const file of new Set(SITES.map(([f]) => f))) {
    assert.match(strip(read(file)), /jsonMemberPath\(lang\)/, `${file} 没用 jsonMemberPath`)
  }
})

check('⭐ 全仓库没有任何裸拼的 JSON 路径', () => {
  // 最要紧的一条：将来有人新写一个写库函数、照抄旧写法，这里就会红
  const bad = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(js|mjs|ts)$/.test(name)) {
        const src = strip(readFileSync(p, 'utf8'))
        if (/`\$\.\$\{/.test(src) || /['"`]\$\.[A-Za-z0-9_$]*-/.test(src)) bad.push(path.relative(root, p))
      }
    }
  }
  for (const d of ['server/src', 'server/scripts', 'shared']) walk(path.join(root, d))
  assert.deepEqual(bad, [], '这些文件里还在裸拼 JSON 路径 —— 一律改走 db.js 的 jsonMemberPath')
})

check('每个写库函数仍然校验 lang（jsonMemberPath 不替代白名单）', () => {
  // jsonMemberPath 只保证「拼出来的路径语法合法」，不保证 lang 是我们支持的语言。
  // 两道防线各管一件事，别因为加了前者就把后者删了。
  for (const [file, fn] of SITES) {
    const src = read(file)
    const i = src.indexOf(`export async function ${fn}`)
    assert.ok(i > 0, `${file} 里找不到 ${fn}`)
    assert.match(src.slice(i, i + 600), /\/\^\[a-zA-Z-\]\{2,10\}\$\/\.test\(lang\)/, `${fn} 少了 lang 的格式校验`)
  }
})

console.log(`\n✅ MySQL JSON 路径：${n} 项检查通过`)

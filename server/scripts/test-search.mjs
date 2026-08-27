/**
 * 分词器的单元测试（不连数据库）。
 * 用法：cd server && node scripts/test-search.mjs
 *
 * 改过 src/search.js 的规则就跑一遍 —— 分词错了不会报错，只会「搜不到」，
 * 而「搜不到」在开发时太容易被当成数据问题。
 */
import { normalize, tokenize, pinyinTokens, queryTerms, tokenMatchSql, buildGameTokens, WEIGHT } from '../src/search.js'

let pass = 0
const fails = []
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) pass++
  else fails.push(`${name}\n    实际 ${g}\n    期望 ${w}`)
}
const ok = (name, cond, extra = '') => {
  if (cond) pass++
  else fails.push(`${name}${extra ? ' — ' + extra : ''}`)
}

/* ---------------- 归一化 ---------------- */
eq('繁转简', normalize('魂鬥羅'), '魂斗罗')
eq('繁转简（长标题）', normalize('薩爾達傳說'), '萨尔达传说')
eq('全角转半角', normalize('ＺＥＬＤＡ'), 'zelda')
eq('去音调符号', normalize('Pokémon'), 'pokemon')
eq('大小写', normalize('Contra'), 'contra')
ok('空输入', normalize('') === '' && normalize(null) === '')

/* ---------------- 分词 ---------------- */
eq('中文单字 + 二字组', [...tokenize('魂斗罗')].sort(), ['斗', '斗罗', '罗', '魂', '魂斗'].sort())
eq('英文按词', [...tokenize('The Legend of Zelda')].sort(), ['legend', 'of', 'the', 'zelda'].sort())
ok('中英混排', (() => {
  const t = tokenize('Contra 魂斗罗')
  return t.has('contra') && t.has('魂斗') && t.has('罗')
})())
ok('标点不产生 token', ![...tokenize('a...b')].some((x) => x.includes('.')))

/* ---------------- 拼音 ---------------- */
const py = pinyinTokens('魂斗罗')
eq('全拼', py.get('hundouluo'), WEIGHT.pinyin)
eq('首字母', py.get('hdl'), WEIGHT.pinyin)
eq('后缀拼音降一档', py.get('douluo'), WEIGHT.pinyinPart)
ok('长度不足 2 的丢掉', !py.has('l'))
ok('繁体也能出拼音', (() => {
  const t = pinyinTokens('薩爾達傳說')
  return t.has('saerdachuanshuo') && t.has('sedcs')
})())
ok('纯英文不产生拼音', pinyinTokens('Super Mario').size === 0)

/* ---------------- 查询切分 ---------------- */
{
  const t = queryTerms('塞尔达时之笛')
  eq('中文：单字必须全中', t.required.map((x) => x.token), ['塞', '尔', '达', '时', '之', '笛'])
  eq('中文：二字组只加分', t.optional.map((x) => x.token), ['塞尔', '尔达', '达时', '时之', '之笛'])
}
{
  const t = queryTerms('super mario')
  eq('英文整词必须命中', t.required.map((x) => x.token), ['super', 'mario'])
  ok('最后一个词按前缀', t.required[1].prefix === true && t.required[0].prefix === false)
}
{
  const t = queryTerms('super mario', { prefixLast: false })
  ok('可以关掉前缀', t.required.every((x) => !x.prefix))
}
ok('纯标点算空', queryTerms('！！！').empty === true)
ok('汉字不放宽成前缀', queryTerms('魂斗罗').required.every((x) => !x.prefix))

/* ---------------- 索引条目 ---------------- */
{
  const m = buildGameTokens({ title: 'Contra', title_zh: '魂斗罗', developer: 'Konami', tags: ['射击'] })
  eq('原名权重', m.get('contra'), WEIGHT.title)
  eq('译名权重', m.get('魂斗'), WEIGHT.titleZh)
  eq('开发商权重', m.get('konami'), WEIGHT.developer)
  eq('标签权重', m.get('射击'), WEIGHT.tag)
  eq('拼音权重', m.get('hdl'), WEIGHT.pinyin)
  ok('token 不超长', [...m.keys()].every((k) => k.length <= 32))
}

/* ---------------- SQL 拼装 ---------------- */
{
  const parsed = queryTerms('魂斗罗')
  const { sql, params } = tokenMatchSql(parsed)
  ok('必须项计数正确', sql.includes(`SUM(req) = ${parsed.required.length}`), sql.slice(-60))
  ok('参数个数对得上', params.length === parsed.required.length + parsed.optional.length)
  ok('没有拼进未转义的用户输入', !sql.includes('魂'))
}
{
  // 分词只保留 [a-z0-9] 和汉字，所以 % 和 _ 根本活不到 LIKE 那一步。
  // 这条守住的是这个性质本身 —— 哪天分词放宽了字符集，转义那行才真正要顶事。
  const t = queryTerms('100% _ 50_off')
  ok('通配符在分词阶段就没了', t.required.every((x) => !/[%_]/.test(x.token)), JSON.stringify(t.required))
  const { params } = tokenMatchSql(queryTerms('a%b'))
  ok('LIKE 参数里只有我们自己加的尾部 %', params.every((p) => typeof p !== 'string' || !/[%_].*[%_]/.test(p)), JSON.stringify(params))
}

console.log(`通过 ${pass} 项`)
if (fails.length) {
  console.log(`\n失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exitCode = 1
} else {
  console.log('全部通过')
}

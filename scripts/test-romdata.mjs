/**
 * arcade_romdata 的入库校验。
 *
 * 这一列的内容会被原样写进模拟器的虚拟文件系统再交给 FBNeo 解析，
 * 所以校验的重点不是语法，而是那两类「存得进去、跑起来却安静失效」的情况：
 *   · CRLF —— dat 是按行 token 化解析的，\r 会并进最后一个 token，romset 名就对不上了
 *   · 缺 ZipName 或 DrvName —— 核心拿不到驱动名会安静退回普通流程，
 *     表现是「后台明明填了，游戏还是 Romset is unknown」
 */
import assert from 'node:assert/strict'
import { arcadeRomDataOf, gameApiToRow, gameApiToPartialRow, gameRowToApi } from '../server/src/mappers.js'

const OK = 'ZipName wofcn\nDrvName wofj\nFullName Warriors of Fate (Chinese)\ntk2_01.3a 0x080000 0x0d9cb9bf BRF_GRA CPS1_TILES'

assert.equal(arcadeRomDataOf(OK), OK)
assert.equal(arcadeRomDataOf(null), null)
assert.equal(arcadeRomDataOf('   '), null)

// CRLF 统一成 LF，控制字符清掉，但制表符保留（dat 的分隔符里就有 \t）
assert.equal(arcadeRomDataOf('ZipName\twofcn\r\nDrvName\twofj\r\n'), 'ZipName\twofcn\nDrvName\twofj')
assert.ok(!arcadeRomDataOf('ZipName wofcn\nDrvName wofj').includes(''))

// 别名也认：RomName / Parent 是 FBNeo 接受的同义词
assert.equal(arcadeRomDataOf('RomName wofcn\nParent wofj'), 'RomName wofcn\nParent wofj')
// 大小写不敏感，和核心的 _tcsicmp 一致
assert.equal(arcadeRomDataOf('zipname wofcn\ndrvname wofj'), 'zipname wofcn\ndrvname wofj')

// 缺任一必填项都要当场 400，而不是留到玩家点开游戏才发现
assert.throws(() => arcadeRomDataOf('ZipName wofcn\ntk2_01.3a 0x80000 0x0d9cb9bf BRF_GRA'), /ZipName/)
assert.throws(() => arcadeRomDataOf('DrvName wofj\n'), /ZipName/)
// 只在注释里出现不算数
assert.throws(() => arcadeRomDataOf('// DrvName wofj\nZipName wofcn'), /ZipName/)
assert.throws(() => arcadeRomDataOf('ZipName wofcn\nDrvName wofj\n' + 'x'.repeat(40000)), /太长/)

for (const fn of [arcadeRomDataOf]) {
  try {
    fn('ZipName wofcn')
    assert.fail('应该抛错')
  } catch (e) {
    assert.equal(e.status, 400)
    assert.equal(e.expose, true)
  }
}

assert.equal(gameRowToApi({ slug: 'wofcn', arcade_romdata: OK }).arcadeRomData, OK)
assert.equal(gameRowToApi({ slug: 'kof97' }).arcadeRomData, undefined)
assert.equal(gameApiToRow({ slug: 'wofcn', arcadeRomData: OK }).arcade_romdata, OK)
assert.equal(gameApiToRow({ slug: 'kof97' }).arcade_romdata, null)
// 清空要写成 NULL，否则会留下一份空 dat
assert.deepEqual(gameApiToPartialRow({ arcadeRomData: '' }), { arcade_romdata: null })

console.log('街机 RomData 映射测试通过')

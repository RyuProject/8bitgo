/**
 * 云存档配额的自检。不连数据库 —— 判定本身是纯函数（saveQuotaError）。
 *
 * 为什么值得单独测：这块的规则是两条互相打架的诉求折中出来的
 *   · 要挡住「拿它当网盘」（份数 200 × 单份 4MB = 一个账号 800MB）
 *   · 又不能让玩家玩到一半突然存不上（那比拒绝新建难受得多）
 * 折中点是「只在变大时才查体积」。改这段之前先跑一遍，别把哪一头折没了。
 *
 * 用法：cd server && npm run test:save-quota
 */
import assert from 'node:assert/strict'

const MB = 1024 * 1024
process.env.SAVE_MAX_PER_USER = '3'
process.env.SAVE_MAX_TOTAL_BYTES = String(10 * MB)
const { saveQuotaError } = await import('../src/routes/saves.js')

let n = 0
let failedChecks = 0
/**
 * ⚠️ 断言失败**不再抛异常**，而是记一笔继续往下跑。
 *
 * 原来是 `assert.ok(cond, msg)` —— 第一条炸了整个进程就退出，后面的用例一条都不执行。
 * 2026-09-11 的教训：test:indexnow 从 09-08 起就红着，28 条里只跑到第 6 条，
 * 后面 22 条三天没被执行过，而没人知道，因为根本没人跑它（现在有 `npm test` 了）。
 * 一条小毛病不该把整套的价值清零。
 *
 * 退出码由下面那个 exit 钩子负责 —— 有失败就是非零，绝不会变成静默通过。
 */
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('✅ ' + msg)
    return
  }
  failedChecks++
  console.log('❌ ' + msg)
}
process.on('exit', () => {
  if (failedChecks) {
    console.log(`\n❌ ${failedChecks} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})
const pass = (used, oldSize, newSize) => saveQuotaError(used, oldSize, newSize) === null
const deny = (used, oldSize, newSize) => saveQuotaError(used, oldSize, newSize)

console.log('── 份数 ──')
ok(pass({ count: 2, bytes: 0 }, 0, 1000), '没满就能新开一格')
ok(deny({ count: 3, bytes: 0 }, 0, 1000)?.status === 409, '份数满了不给新开')
ok(pass({ count: 3, bytes: 1000 }, 1000, 2000), '份数满了，但覆盖已有的那格照样行')

console.log('\n── 体积 ──')
ok(pass({ count: 1, bytes: 9 * MB }, 0, 1 * MB), '刚好填满可以')
ok(deny({ count: 1, bytes: 9 * MB }, 0, 1 * MB + 1)?.status === 409, '超一个字节就拒')
ok(/MB/.test(deny({ count: 1, bytes: 10 * MB }, 0, 1)?.error ?? ''), '拒绝时说清是总量超了（错误里带 MB）')

console.log('\n── 玩到一半不能被卡住 ──')
// 这是那条折中规则：已经超额了（比如上限被调小过），存得不比原来大就永远放行
ok(pass({ count: 1, bytes: 50 * MB }, 4 * MB, 4 * MB), '存得和原来一样大 —— 放行')
ok(pass({ count: 1, bytes: 50 * MB }, 4 * MB, 1 * MB), '存得比原来小 —— 放行')
ok(deny({ count: 1, bytes: 50 * MB }, 4 * MB, 4 * MB + 1)?.status === 409, '只要变大就按总量卡')

console.log('\n── 覆盖时算的是"换掉之后"的总量，不是叠加 ──')
// 老的那份要先减掉，否则一份 6MB 的存档覆盖成 6MB 会被自己顶出去
ok(pass({ count: 1, bytes: 6 * MB }, 6 * MB, 8 * MB), '6MB 覆盖成 8MB，总量 8MB < 10MB，放行')
ok(deny({ count: 2, bytes: 9 * MB }, 1 * MB, 3 * MB)?.status === 409, '换完是 11MB > 10MB，拒')

console.log(`\n全部通过 ✅  共 ${n} 项`)

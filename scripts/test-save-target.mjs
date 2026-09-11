/**
 * 存档落点的自检（src/services/saves.ts 的 getSaveTarget / effectiveSaveTarget）。
 *
 * 这块的要点只有一条：**没选过绝不默认云端**。
 * 原来的行为是「只要登录了就顺手上云」，玩家从没被问过 —— 这个测试就是防它回来。
 *
 * 用法：npm run test:save-target
 */
import assert from 'node:assert/strict'

// 这两个模块只在浏览器里跑，node 侧要先把它们用到的全局备好
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}



const saves = await import('../src/services/saveTarget.ts')
const { getSaveTarget, setSaveTarget } = saves

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

console.log('── 记住与忘掉 ──')
ok(getSaveTarget() === null, '没选过时是 null（界面据此弹选择框）')
setSaveTarget('local')
ok(getSaveTarget() === 'local', '选了本地就记住')
setSaveTarget('cloud')
ok(getSaveTarget() === 'cloud', '改成云端也记住')
setSaveTarget('download')
ok(getSaveTarget() === 'download', '下载也是一个可记住的选择')
setSaveTarget(null)
ok(getSaveTarget() === null, '传 null = 忘掉，下次重新问')

console.log('\n── 脏值不当数 ──')
store.set('8bitgo.save.target', 'CLOUD')
ok(getSaveTarget() === null, '大小写不对的值当没选过（不会歪打正着变成云端）')
store.set('8bitgo.save.target', 'nas')
ok(getSaveTarget() === null, '不认识的值当没选过')
store.delete('8bitgo.save.target')

console.log('\n── localStorage 不可用（无痕 / 禁了存储）──')
const real = globalThis.localStorage
globalThis.localStorage = {
  getItem() { throw new Error('denied') },
  setItem() { throw new Error('denied') },
  removeItem() { throw new Error('denied') },
}
ok(getSaveTarget() === null, '读不到不抛异常，当没选过（每次问一遍，总比替他猜强）')
let threw = false
try { setSaveTarget('cloud') } catch { threw = true }
ok(!threw, '写不进去也不抛异常')
globalThis.localStorage = real

console.log(`\n全部通过 ✅  共 ${n} 项`)

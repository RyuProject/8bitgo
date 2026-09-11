/**
 * 光盘平台（PS1 / PS2）上传守卫的回归测试。
 *
 * ── 为什么有这一套 ──────────────────────────────────────────
 * 2026-09-11 站长传《Gran Turismo》：手里是一个 zip，里面 `xxx.bin` + `xxx.cue`。
 * 整个 zip 传上去，玩家那边报 `Size is zero` —— 而进度条一路正常走到底。
 *
 * 这条链有三层，而错误信息只暴露了最后一层：
 *   1. 我们把整个 zip 当一份光盘镜像下下来，交给 EmulatorJS；
 *   2. 引擎按魔数认出 zip，交给 compression/extractzip.js —— 那是个很老的
 *      emscripten 构建，**压缩包和解出来的内容共用一块 2GB 上限的线性内存**；
 *   3. PS1 一张盘解出来几百 MB，分配失败之后它不报错，写出一个 **0 字节**的文件。
 *      核心顺着 .cue 找到 .bin，打开是 0 字节 → mednafen 报「Size is zero」。
 *
 * 错误指向「文件」，原因在「解压那一步的内存」，中间隔着三层 —— 谁也不会往那儿想。
 * 所以唯一有用的地方是**上传之前**。这套测试钉的就是那道门。
 *
 * 跑：npm run test:disc-upload
 */
import { fileURLToPath } from 'node:url'

/* window 桩：把弹窗记下来，顺便让脚本能决定用户点了什么 */
const asked = { alert: [], confirm: [] }
let confirmAnswer = true
globalThis.window = {
  alert: (text) => {
    asked.alert.push(String(text))
  },
  confirm: (text) => {
    asked.confirm.push(String(text))
    return confirmAnswer
  },
}
const reset = () => {
  asked.alert.length = 0
  asked.confirm.length = 0
  confirmAnswer = true
}

const { confirmDiscImage } = await import(fileURLToPath(new URL('../src/admin/uploadGuards.ts', import.meta.url)))

let n = 0
let failed = 0
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('✅ ' + msg)
    return
  }
  failed++
  console.log('❌ ' + msg)
}
process.on('exit', () => {
  if (failed) {
    console.log(`\n❌ ${failed} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})

/* ---------------- 造 zip ---------------- */

const te = new TextEncoder()

/**
 * 造一个「虚拟的大 zip」：只真的生成中央目录和 EOCD，前面那几百 MB 数据区不分配。
 *
 * 守卫（zipDirectorySummary）只读文件**末尾**的目录，所以这么造出来的东西
 * 在它眼里和一份真的 600MB 压缩包完全一样 —— 而测试进程不用真的吃掉 600MB。
 * 用的接口就三个：name / size / slice().arrayBuffer()。
 */
function hugeZipFile(name, virtualSize, entries) {
  const central = []
  for (const e of entries) {
    const nameBytes = te.encode(e.name)
    const cen = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint32(20, e.compressed ?? 0, true)
    cv.setUint32(24, e.uncompressed ?? 0, true)
    cv.setUint16(28, nameBytes.length, true)
    cen.set(nameBytes, 46)
    central.push(cen)
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const tailLen = centralSize + 22
  // 中央目录就从「文件末尾往前 tailLen」这个位置开始
  const centralOffset = virtualSize - tailLen
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralOffset, true)

  const tail = new Uint8Array(tailLen)
  let at = 0
  for (const c of central) {
    tail.set(c, at)
    at += c.length
  }
  tail.set(eocd, at)

  return {
    name,
    size: virtualSize,
    /** 虚拟坐标 → 真实字节。落在 tail 之前的一律当全 0（数据区，守卫不看） */
    slice(a, b = virtualSize) {
      const from = a < 0 ? Math.max(0, virtualSize + a) : a
      const to = Math.min(b, virtualSize)
      const out = new Uint8Array(Math.max(0, to - from))
      for (let i = 0; i < out.length; i++) {
        const v = from + i
        if (v >= centralOffset) out[i] = tail[v - centralOffset]
      }
      return { arrayBuffer: async () => out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) }
    },
  }
}

/** 一份只有 name / size 的文件：裸镜像那几条守卫压根不读内容 */
function fakeFile(name, size) {
  return { name, size, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }
}

/* ---------------- 一、不是光盘平台就别多嘴 ---------------- */

reset()
ok(
  (await confirmDiscImage('nes', fakeFile('mario.zip', 40 * 1024))) === true &&
    !asked.alert.length &&
    !asked.confirm.length,
  '卡带平台（NES）的 zip 一个字都不问 —— 那本来就是正确的上传方式',
)

/* ---------------- 二、.chd：唯一推荐的形态 ---------------- */

reset()
ok(
  (await confirmDiscImage('psx', fakeFile('gran-turismo.chd', 380 * 1024 * 1024))) === true &&
    !asked.alert.length &&
    !asked.confirm.length,
  '正常大小的 .chd 直接放行，不打扰管理员',
)

reset()
ok(await confirmDiscImage('psx', fakeFile('big.chd', 900 * 1024 * 1024)), '超大的 .chd 仍然放行（点了「仍要上传」）')
ok(asked.confirm.length === 1 && /玩家每次开局都要下/.test(asked.confirm[0]), '但会提醒体积 —— 这是玩家要等多久的问题，不是存储费')

/* ---------------- 三、压缩包：站长踩的那个坑 ---------------- */

{
  // 真实形状：Gran Turismo (USA) (Rev 1) —— zip 本体约 600MB，里面的 .bin 解出来约 700MB
  reset()
  const file = hugeZipFile('gran-turismo.zip', 600 * 1024 * 1024, [
    { name: 'Gran Turismo (USA) (Rev 1).cue', compressed: 120, uncompressed: 140 },
    { name: 'Gran Turismo (USA) (Rev 1).bin', compressed: 600 * 1024 * 1024, uncompressed: 700 * 1024 * 1024 },
  ])

  const allowed = await confirmDiscImage('psx', file)
  ok(allowed === false, 'PS1 的 bin+cue 压缩包被**硬拦**（600MB 包 + 700MB 解出来，超过 2GB 内存的安全线）')
  ok(asked.confirm.length === 0, '这一档不给「仍要上传」的选项 —— 它不是质量取舍，是一定跑不起来')
  ok(asked.alert.length === 1, '弹一次说明')
  const text = asked.alert[0]
  ok(/Size is zero/.test(text), '说明里点名了玩家会看到的那句报错，这样下次搜到这句话能对上')
  ok(/chdman createcd -i "Gran Turismo \(USA\) \(Rev 1\).cue" -o "gran-turismo.chd"/.test(text), '直接给出可以复制粘贴的 chdman 命令，cue 名字从包里读出来（带空格和括号也不怕）')
  ok(/Gran Turismo \(USA\) \(Rev 1\).bin/.test(text), '列出包里到底是什么，省掉管理员再解一遍确认')
  ok(/2GB/.test(text), '讲清楚是解压那一步的内存上限，不是「文件坏了」')
}

{
  // 小 homebrew 盘：确实能解开，所以只提醒、留一条路
  reset()
  const file = hugeZipFile('demo.zip', 12 * 1024 * 1024, [
    { name: 'demo.cue', compressed: 60, uncompressed: 70 },
    { name: 'demo.bin', compressed: 12 * 1024 * 1024, uncompressed: 20 * 1024 * 1024 },
  ])

  confirmAnswer = true
  ok((await confirmDiscImage('psx', file)) === true, '小体积的压缩包只提醒，管理员坚持就放行（它确实解得开）')
  ok(asked.alert.length === 0 && asked.confirm.length === 1, '走的是 confirm 不是 alert')
  ok(/chdman/.test(asked.confirm[0]), '照样把 .chd 的做法说一遍')

  reset()
  confirmAnswer = false
  ok((await confirmDiscImage('psx', file)) === false, '管理员点「取消」就不传')
}

{
  // .7z / .rar 读不出中央目录 —— 按「解出来大约是压缩包两倍」保守估
  reset()
  ok((await confirmDiscImage('psx', fakeFile('gt.7z', 600 * 1024 * 1024))) === false, '大的 .7z 同样硬拦（读不出目录时按两倍保守估）')
  reset()
  ok((await confirmDiscImage('psx', fakeFile('gt.rar', 600 * 1024 * 1024))) === false, '.rar 同理')
  reset()
  confirmAnswer = true
  ok((await confirmDiscImage('psx', fakeFile('tiny.7z', 10 * 1024 * 1024))) === true, '小的 .7z 只提醒')
}

/* ---------------- 四、裸镜像：原来就有的三条提醒不能丢 ---------------- */

reset()
confirmAnswer = true
await confirmDiscImage('psx', fakeFile('gt.cue', 200))
ok(/找不到轨道/.test(asked.confirm[0] ?? ''), '单传 .cue：说清楚数据在 .bin 里')

reset()
await confirmDiscImage('psx', fakeFile('gt.bin', 500 * 1024 * 1024))
ok(/分轨信息/.test(asked.confirm[0] ?? ''), '单传 .bin：说清楚丢了分轨信息')

reset()
await confirmDiscImage('psx', fakeFile('gt.iso', 400 * 1024 * 1024))
ok(/CDDA|BGM/.test(asked.confirm[0] ?? ''), 'PS1 的 .iso：说清楚会没有 BGM')

reset()
ok((await confirmDiscImage('ps2', fakeFile('game.iso', 400 * 1024 * 1024))) === true && !asked.confirm.length, 'PS2 的 .iso 是正常形态，不提醒')

console.log(`\n✅ ${n} 项通过`)

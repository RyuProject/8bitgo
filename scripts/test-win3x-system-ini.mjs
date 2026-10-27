/**
 * Win3.x 客体开机前改 SYSTEM.INI 的回归（src/emulator/win3xSystemIni.ts）。
 *
 * 背景：《经典食人花》一启动就播 MIDI，Win3.1 的 MCI 音序器弹「This file may not play
 * correctly with the default MIDI setup」，对话框被游戏主窗口压住，游戏卡在 MCI 调用里，
 * 玩家只看到一扇白窗口。修法是开机前在 SYSTEM.INI 写 `[mciseq.drv] disablewarning=true`。
 *
 * 这里现场合成一块「qcow2 → MBR → FAT16 → WINDOWS\SYSTEM.INI」的小盘，不依赖仓库外的镜像；
 * 本机有 sysimg.local/ 里的真镜像时再顺带验一遍。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  ensureIniSetting,
  patchWin3xSystemIni,
  replaceZipEntryStored,
  win3xPatchedSystemLayer,
} from '../src/emulator/win3xSystemIni.ts'
import { appendZipEntries, crc32, extractZipEntry, listZipEntries } from '../src/lib/unzip.ts'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed++
    console.error(`  ❌ ${name}\n     ${error?.stack ?? error}`)
  }
}

const SETTING = { section: 'mciseq.drv', key: 'disablewarning', value: 'true' }
const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const dec = (b) => String.fromCharCode(...b)

/* ---------- 合成一块最小的 FAT16 盘，再包成 qcow2 ---------- */
const SECTOR = 512
const PART = 512 // 分区从 LBA 1 开始
const FAT_SECTORS = 17
const ROOT_ENTRIES = 512
const CLUSTERS = 4200 // FAT16 的下限是 4085 簇
const FAT_AT = PART + SECTOR
const ROOT_AT = FAT_AT + 2 * FAT_SECTORS * SECTOR
const DATA_AT = ROOT_AT + (ROOT_ENTRIES * 32)
const TOTAL_SECTORS = (DATA_AT - PART) / SECTOR + CLUSTERS
const clusterAt = (n) => DATA_AT + (n - 2) * SECTOR

function dirEntry(name, ext, attr, cluster, size) {
  const e = new Uint8Array(32)
  e.set(enc(name.padEnd(8)), 0)
  e.set(enc(ext.padEnd(3)), 8)
  e[11] = attr
  const v = new DataView(e.buffer)
  v.setUint16(26, cluster, true)
  v.setUint32(28, size, true)
  return e
}

function makeRawDisk(ini) {
  const disk = new Uint8Array(PART + TOTAL_SECTORS * SECTOR)
  const v = new DataView(disk.buffer)
  // MBR：一个 FAT16 分区
  disk[446 + 4] = 0x06
  v.setUint32(446 + 8, PART / SECTOR, true)
  v.setUint32(446 + 12, TOTAL_SECTORS, true)
  disk[510] = 0x55
  disk[511] = 0xaa
  // BPB
  v.setUint16(PART + 11, SECTOR, true)
  disk[PART + 13] = 1
  v.setUint16(PART + 14, 1, true)
  disk[PART + 16] = 2
  v.setUint16(PART + 17, ROOT_ENTRIES, true)
  v.setUint16(PART + 19, TOTAL_SECTORS, true)
  v.setUint16(PART + 22, FAT_SECTORS, true)
  // FAT：2 号簇 = WINDOWS 目录，3 号簇 = SYSTEM.INI，都只有一簇
  for (const fat of [FAT_AT, FAT_AT + FAT_SECTORS * SECTOR]) {
    v.setUint16(fat + 2 * 2, 0xffff, true)
    v.setUint16(fat + 3 * 2, 0xffff, true)
  }
  disk.set(dirEntry('WINDOWS', '', 0x10, 2, 0), ROOT_AT)
  disk.set(dirEntry('SYSTEM', 'INI', 0x20, 3, ini.length), clusterAt(2))
  disk.set(ini, clusterAt(3))
  return disk
}

/** qcow2 v2，64KB 簇，全部分配；L2 表项故意带上 bit 63（COPIED）检验标志位屏蔽 */
function wrapQcow2(raw) {
  const CLUSTER = 65536
  const guestClusters = Math.ceil(raw.length / CLUSTER)
  const out = new Uint8Array((3 + guestClusters) * CLUSTER)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x514649fb)
  v.setUint32(4, 2)
  v.setUint32(20, 16) // cluster_bits
  v.setUint32(24, Math.floor(raw.length / 2 ** 32))
  v.setUint32(28, raw.length >>> 0)
  v.setUint32(36, 1) // l1_size
  v.setUint32(44, CLUSTER) // l1_table_offset
  v.setUint32(CLUSTER, 0x80000000) // L1[0]：COPIED
  v.setUint32(CLUSTER + 4, 2 * CLUSTER)
  for (let i = 0; i < guestClusters; i++) {
    const host = (3 + i) * CLUSTER
    v.setUint32(2 * CLUSTER + i * 8, 0x80000000 + Math.floor(host / 2 ** 32))
    v.setUint32(2 * CLUSTER + i * 8 + 4, host >>> 0)
    out.set(raw.subarray(i * CLUSTER, (i + 1) * CLUSTER), host)
  }
  return out
}

/** 从合成盘里把 SYSTEM.INI 读回来（直接按已知布局，不复用被测代码） */
function readIni(qcow2) {
  const host = (guest) => 3 * 65536 + guest // 布局是线性的
  const v = new DataView(qcow2.buffer, qcow2.byteOffset)
  const size = v.getUint32(host(clusterAt(2)) + 28, true)
  return dec(qcow2.subarray(host(clusterAt(3)), host(clusterAt(3)) + size))
}

const ORIGINAL = '[boot]\r\nshell=progman.exe\r\n\r\n; switched to standard VG'

console.log('一、INI 文本')

await check('没有这一节时追加在末尾，补齐 CRLF', () => {
  assert.equal(
    ensureIniSetting(ORIGINAL, SETTING),
    `${ORIGINAL}\r\n\r\n[mciseq.drv]\r\ndisablewarning=true\r\n`,
  )
})

await check('已有同值不改；已有异值只改那一行；节名大小写不敏感', () => {
  const same = '[mciseq.drv]\r\ndisablewarning=true\r\n'
  assert.equal(ensureIniSetting(same, SETTING), same)
  assert.equal(
    ensureIniSetting('[mciseq.drv]\r\ndisablewarning=false\r\n[x]\r\n', SETTING),
    '[mciseq.drv]\r\ndisablewarning=true\r\n[x]\r\n',
  )
  assert.equal(
    ensureIniSetting('[MCISEQ.DRV]\r\nfoo=1\r\n\r\n[x]\r\ny=2\r\n', SETTING),
    '[MCISEQ.DRV]\r\nfoo=1\r\ndisablewarning=true\r\n\r\n[x]\r\ny=2\r\n',
  )
})

console.log('二、qcow2 + FAT16 原地改写')

await check('⚠️ 改写后 SYSTEM.INI 带上 disablewarning，目录项大小同步，其它内容不动', () => {
  const qcow2 = wrapQcow2(makeRawDisk(enc(ORIGINAL)))
  assert.equal(patchWin3xSystemIni(qcow2), true)
  const after = readIni(qcow2)
  assert.ok(after.startsWith(ORIGINAL), '原有内容被改动了')
  assert.match(after, /\[mciseq\.drv\]\r\ndisablewarning=true\r\n$/)
  assert.equal(patchWin3xSystemIni(qcow2), false, '第二次应该什么都不改')
})

await check('现有簇链装不下时宁可不改，也不去分配新簇', () => {
  const full = enc('[boot]\r\n' + ';'.repeat(SECTOR - 10) + '\r\n')
  assert.equal(full.length, SECTOR)
  const qcow2 = wrapQcow2(makeRawDisk(full))
  assert.throws(() => patchWin3xSystemIni(qcow2), /装不下/)
})

await check('不是 qcow2 / 没有 FAT16 分区时报错（调用方据此放行）', () => {
  assert.throws(() => patchWin3xSystemIni(new Uint8Array(4096)), /qcow2/)
  const raw = makeRawDisk(enc(ORIGINAL))
  raw[446 + 4] = 0x0c // FAT32 LBA
  assert.throws(() => patchWin3xSystemIni(wrapQcow2(raw)), /FAT16/)
})

console.log('三、系统包替换')

const EMPTY_ZIP = (() => {
  const z = new Uint8Array(22)
  new DataView(z.buffer).setUint32(0, 0x06054b50, true)
  return z.buffer
})()

await check('⚠️ 系统包里的 qcow2 被换成改好的那份，其它成员原样保留，CRC 正确', async () => {
  const qcow2 = wrapQcow2(makeRawDisk(enc(ORIGINAL)))
  const bundle = appendZipEntries(EMPTY_ZIP, [
    { name: '.jsdos/', data: new Uint8Array(0) },
    { name: '.jsdos/dosbox.orig', data: enc('[autoexec]\r\nboot c:\r\n') },
    { name: 'system-win311-v1.qcow2', data: qcow2 },
  ])
  const before = bundle.slice()
  const out = await win3xPatchedSystemLayer(bundle)
  assert.ok(out, '应该产出新系统包')
  assert.deepEqual(bundle, before, '原系统包被原地改了 —— 它还可能被写进缓存')
  // 旧镜像是中央目录前最后一块：新包不应该再背着一整份旧数据
  assert.ok(out.length < bundle.length + 4096, `新包 ${out.length} 字节，旧包 ${bundle.length}`)
  const entries = listZipEntries(out.buffer)
  assert.deepEqual(entries.map((e) => e.name), ['.jsdos/dosbox.orig', 'system-win311-v1.qcow2'])
  const disk = entries.find((e) => e.name.endsWith('.qcow2'))
  const data = await extractZipEntry(out.buffer, disk)
  assert.equal(crc32(data), disk.crc32)
  assert.match(readIni(data), /disablewarning=true/)
  assert.equal(dec(await extractZipEntry(out.buffer, entries[0])), '[autoexec]\r\nboot c:\r\n')
  assert.equal(await win3xPatchedSystemLayer(out), null, '已改过的包不该再产出一份')
})

await check('替换不在末尾的成员时，其它成员的偏移仍然有效', async () => {
  const zip = appendZipEntries(EMPTY_ZIP, [
    { name: 'a.bin', data: enc('AAAA') },
    { name: 'b.bin', data: enc('BBBB') },
  ])
  const out = replaceZipEntryStored(zip, 'a.bin', enc('XYZ'))
  const entries = listZipEntries(out.buffer)
  const byName = Object.fromEntries(await Promise.all(entries.map(async (e) => [e.name, dec(await extractZipEntry(out.buffer, e))])))
  assert.deepEqual(byName, { 'a.bin': 'XYZ', 'b.bin': 'BBBB' })
})

await check('⚠️ 适配器只对 Win3.x 客体做这步，并且替换的是系统包本身（不是 initFs 的 file 层）', () => {
  const src = readFileSync('src/emulator/adapters/jsdos.ts', 'utf8')
  assert.match(src, /!dosSystemGuest && \(options\.dosWindowsVersion \?\? '9x'\) === '3x'\s*\n\s*\? await win3xPatchedSystemLayer\(hiddenSystemLayer\)/)
  assert.match(src, /const systemLayer = win3xSystemLayer \?\? hiddenSystemLayer/)
  // file 层会先写进 worker，随后被系统包里原版 qcow2 盖掉（2026-10-27 实测），别再改回那条路
  assert.doesNotMatch(src, /win3xSystemIniLayer/)
})

const LOCAL = 'sysimg.local/system-win311-vga-v1.jsdos'
if (existsSync(LOCAL)) {
  console.log('四、本机真镜像（sysimg.local，不进仓库）')
  await check('真 Win3.11 镜像：补上 disablewarning，且只补一次', async () => {
    const buf = readFileSync(LOCAL)
    const out = await win3xPatchedSystemLayer(new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)))
    assert.ok(out)
    const disk = listZipEntries(out.buffer).find((e) => e.name.endsWith('.qcow2'))
    const data = await extractZipEntry(out.buffer, disk)
    assert.equal(crc32(data), disk.crc32)
    assert.equal(patchWin3xSystemIni(data.slice()), false)
  })
}

console.log(failed === 0 ? '\nWin3.x SYSTEM.INI 预处理回归通过\n' : `\n失败 ${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)

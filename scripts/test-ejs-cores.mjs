/**
 * 守一条规矩：**后台下拉里出现的核心，必须真的发出去了。**
 *
 *   npm run test:ejs-cores      （也挂在 prebuild 上，构建时会跑）
 *
 * ── 为什么要这道闸 ──────────────────────────────────────────
 * 这条以前真的破了，而且破了很久：`config/emulators.ts` 的 CORE_OPTIONS 里挂着
 * `mame2003_plus` / `mame2003` / `mednafen_psx_hw` 三个选项，而
 * `public/emulatorjs/cores/` 里这三个核心的 .data **一个都没有**（2026-09-07 查出）。
 *
 * 后果是静默且指错方向的：本地找不到核心时 EmulatorJS 会回落到
 * `cdn.emulatorjs.org/<版本>/` 去拉 —— 引擎自己都在控制台喊那是 failsafe、
 * 不受支持，实测拉回来的东西初始化不出 EJS_Runtime。管理员看到的是某一款游戏
 * 「Error loading EmulatorJS runtime」，**完全看不出跟他刚选的核心有关**。
 *
 * 靠人记得「加下拉选项时别忘了 npm run ejscores」是不行的 —— 已经忘过一次。
 *
 * ── 核心别名表从引擎里现读，不在这儿抄一份 ──────────────────
 * EJS_core 收的可能是**平台别名**（`psx` → pcsx_rearmed、`nds` → melonds、
 * `arcade` → fbneo），也可能是具体核心名（`mednafen_psx_hw`）。这张对应表是
 * EmulatorJS 自己的（emulator.min.js 里那个 `const u={atari5200:["a5200"],…}`），
 * 我们**解析那个文件**而不是照抄一份：抄一份就多了一处会悄悄和引擎对不上的地方，
 * 而这个脚本存在的全部意义就是消灭「两处对不上还没人发现」。
 * 引擎是自托管、提交在仓库里的，所以这一步是离线、确定的。
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_OPTIONS } from '../src/config/emulators.ts'
import { platforms } from '../src/data/platforms.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const coresDir = join(root, 'public', 'emulatorjs', 'cores')
const enginePath = join(root, 'public', 'emulatorjs', 'emulator.min.js')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/**
 * 从引擎里读出「平台别名 → 核心列表」。
 *
 * 认的是那个对象字面量的**形状**（十条以上 `key:["a","b"]`），不认变量名 ——
 * 压缩后的变量名每次构建都会变，而这个形状在整个 bundle 里是独一份的。
 */
function engineCoreTable() {
  const src = readFileSync(enginePath, 'utf8')
  const shape = /\{(?:"?[A-Za-z0-9_.]+"?:\[(?:"[A-Za-z0-9_.]+",?)+\],?){10,}\}/
  const m = shape.exec(src)
  assert.ok(
    m,
    '在 public/emulatorjs/emulator.min.js 里找不到核心别名表。' +
      '引擎升级后压缩结果变了 —— 去 emulator.min.js 里搜 `nds:["melonds"`，' +
      '确认那张表还在、然后更新这里的形状正则。别把这个脚本改成跳过。',
  )
  const table = {}
  for (const entry of m[0].matchAll(/"?([A-Za-z0-9_.]+)"?:\[([^\]]+)\]/g)) {
    table[entry[1]] = entry[2].split(',').map((v) => v.replace(/"/g, '').trim()).filter(Boolean)
  }
  return table
}

const TABLE = engineCoreTable()
/** 引擎认识的全部核心名（别名的取值合起来） */
const KNOWN = new Set(Object.values(TABLE).flat())

/** EJS_core 的值 → 真正会去下载的核心文件名。照 EmulatorJS 的 getCore() */
const resolve = (id) => (TABLE[id] ? TABLE[id][0] : id)

/** 已经发出去的核心（按 <core>-wasm.data 认） */
const shipped = new Set(
  readdirSync(coresDir)
    .filter((f) => f.endsWith('-wasm.data') && !f.includes('-thread-'))
    .map((f) => f.replace(/-legacy-wasm\.data$|-wasm\.data$/, '')),
)

console.log('一、引擎的核心别名表读出来了')

check(`解析出 ${Object.keys(TABLE).length} 个平台别名`, () => {
  assert.ok(Object.keys(TABLE).length >= 20, `只读出 ${Object.keys(TABLE).length} 个，太少了，正则多半没匹配对`)
})
check('几个我们真用得上的别名对得上', () => {
  // 这几条是从 emulator.min.js 里实读到的，不是推测的
  assert.deepEqual(TABLE.nds, ['melonds', 'desmume', 'desmume2015'])
  assert.equal(resolve('nds'), 'melonds')
  assert.equal(resolve('psx'), 'pcsx_rearmed')
  assert.equal(resolve('arcade'), 'fbneo')
  // ⚠️ mame2003_plus 挂在 `mame` 别名底下，**不在** arcade 里；
  // 但它本身不是别名，所以原样透传 —— 这正是它能作为街机备选的原因
  assert.equal(resolve('mame2003_plus'), 'mame2003_plus')
  assert.ok(!TABLE.arcade.includes('mame2003_plus'))
})

console.log('\n二、我们会交给引擎的每一个核心，都得真的发了')

/** 所有可能出现在 EJS_core 上的值：平台默认 + 后台下拉的每一项 */
const wanted = []
for (const p of platforms) {
  if (p.runtime === 'emulatorjs' && p.core) wanted.push({ id: p.core, from: `platforms.ts / ${p.id} 的默认核心` })
}
for (const [platform, list] of Object.entries(CORE_OPTIONS)) {
  for (const opt of list) wanted.push({ id: opt.id, from: `CORE_OPTIONS.${platform} 的「${opt.label}」` })
}

check(`一共 ${wanted.length} 处引用，去重后 ${new Set(wanted.map((w) => w.id)).size} 个核心`, () => {
  assert.ok(wanted.length > 0, '一个都没收集到，说明 import 的两张表读空了')
})

const seen = new Set()
for (const { id, from } of wanted) {
  const core = resolve(id)
  if (seen.has(`${id}`)) continue
  seen.add(`${id}`)
  check(`${id}${core === id ? '' : ` → ${core}`}（${from}）`, () => {
    assert.ok(
      TABLE[id] || KNOWN.has(id),
      `引擎不认识 "${id}" —— 既不是平台别名，也不在任何别名的核心列表里。多半是拼错了。`,
    )
    for (const variant of [`${core}-wasm.data`, `${core}-legacy-wasm.data`]) {
      assert.ok(
        existsSync(join(coresDir, variant)),
        `public/emulatorjs/cores/${variant} 不存在。` +
          `后台会把这个核心发给引擎，而引擎在本地找不到就回落 CDN、初始化失败 —— ` +
          `玩家看到的是「Error loading EmulatorJS runtime」。` +
          `补法见 scripts/copy-ejs-cores.mjs 头注释里的 npm pack 那一段。`,
      )
    }
    /*
      reports/<core>.json 少了不会让游戏打不开，但**每次进游戏都会重新下核心**：
      引擎拿不到这份 build 报告就不敢用 IndexedDB 缓存。
      1MB 一次、每局一次，在慢网上就是十几秒白等，所以也当硬性要求。
    */
    assert.ok(
      existsSync(join(coresDir, 'reports', `${core}.json`)),
      `cores/reports/${core}.json 不存在 —— 核心还是能跑，但引擎会禁用它的 IndexedDB 缓存，每次进游戏重下一遍`,
    )
  })
}

console.log('\n三、下拉的键必须是真的平台 id')

const platformIds = new Set(platforms.map((p) => p.id))
for (const key of Object.keys(CORE_OPTIONS)) {
  check(`CORE_OPTIONS.${key} 是已知平台`, () => {
    assert.ok(platformIds.has(key), `"${key}" 不是 platforms.ts 里的平台 id —— 这一栏在后台永远不会出现`)
  })
}

console.log('\n四、发出去但没人用的核心（只提示，不算失败）')

const used = new Set(wanted.map((w) => resolve(w.id)))
const orphans = [...shipped].filter((c) => !used.has(c))
console.log(orphans.length ? `  ℹ️ ${orphans.join(', ')} —— 没有任何平台默认或下拉项指向它们` : '  ✅ 没有多余的核心')

/* ---------------- 致命判定不能误杀 ---------------- */

console.log('\n五、FATAL 判定（打通核心 stderr 之后的必要收紧）')
/*
  背景：引擎把 Emscripten 的 printErr 写成 `t=>{this.debug&&console.log(t)}`，而 this.debug
  来自从没设过的 EJS_DEBUG_XX —— 核心的 stderr 一个字都出不来，于是 adapters 里那套
  按关键词分流的 FATAL 判定整块是死代码（所以它当时写成一串宽泛单词也没出事）。

  09-11 在 patch-emulatorjs.mjs 里把 printErr 改成无条件 console.warn 打通之后，核心原文
  第一次真的流进来。而 **MAME 2003/2003-Plus 在「能跑但有缺件」时照样会打 NOT FOUND /
  INCORRECT CHECKSUM / WARNING: the game might not run correctly** —— 按老那张宽泛的表，
  这些会把本来能启动的游戏直接毙掉。

  所以两头都钉：补丁必须在位；判定必须收紧到认不出 MAME 的常规警告。
*/
{
  const engine = readFileSync(join(root, 'public', 'emulatorjs', 'emulator.min.js'), 'utf8')
  check('⭐ printErr 的补丁在位（没有它，三种完全不同的病都只报一句 Failed to start game）', () => {
    assert.ok(engine.includes('printErr:t=>{console.warn(t)}'), '跑一次 npm run ejspatch')
  })

  const adapter = readFileSync(join(root, 'src', 'emulator', 'adapters', 'emulatorjs.ts'), 'utf8')
  const from = adapter.indexOf('const FATAL_PHRASES')
  assert.ok(from > 0, '找不到 FATAL_PHRASES')
  const body = adapter.slice(from, adapter.indexOf('\n]', from))
  const phrases = [...body.matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1])
  const hits = (line) => phrases.some((p) => line.toLowerCase().includes(p))

  check(`致命短语表解析出来了（${phrases.length} 条）`, () => assert.ok(phrases.length >= 3))

  for (const line of [
    'NOT FOUND (NO GOOD DUMP KNOWN)',
    'WARNING: the game might not run correctly.',
    'INCORRECT CHECKSUM:',
    'romset kof97 not supported by this version',
    'Loading bios neogeo.zip',
    'warning: missing optional samples',
  ]) {
    check(`⭐ 不误杀：${line.slice(0, 44)}`, () => assert.ok(!hits(line), '这句在「游戏能跑」时也会出现'))
  }

  for (const line of ['Romset is unknown', 'FATAL ERROR: required files are missing', 'Error loading EmulatorJS runtime']) {
    check(`认得出致命：${line.slice(0, 44)}`, () => assert.ok(hits(line)))
  }
}

console.log(failed ? `\n${failed} 项失败` : `\n全部通过 ✅（${shipped.size} 个核心齐全）`)
process.exit(failed ? 1 : 0)

/**
 * 守住「模拟器实现不进主包」这条边界。
 *
 * 背景：`src/emulator/index.ts` 以前从各个重适配器里转导出常量、还导出 EmulatorPlayer，
 * 于是谁从 '@/emulator' 引入**任何一个符号**，整套引擎实现（EmulatorJS、js-dos、Ruffle、
 * J2ME、webretro、云联机、看直播）就跟着进主包 —— 房间列表页只想要两个布尔判断，
 * 首页和博客根本不跑游戏，一样得下载。
 *
 * 拆开之后这条边界**极容易被一行 import 悄悄破坏**，而且破坏了不会报错、
 * 只会让主包默默胖回去，除非有人恰好去看构建产物。所以拿测试钉住。
 *
 * 做法：从几个「一定在主包里」的入口出发，沿 import 做静态闭包，
 * 断言闭包里不出现 adapters/、EmulatorPlayer、runtimes.ts。
 * `import type` 不跟 —— 类型不产生运行时依赖，不进包。
 *
 * 跑：npm run test:bundle-split
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

const aliasOf = (spec) => (spec.startsWith('@/') ? path.join(SRC, spec.slice(2)) : null)

function resolveSpec(spec, fromFile) {
  let base = aliasOf(spec)
  if (!base) {
    if (!spec.startsWith('.')) return null // 三方包不跟
    base = path.resolve(path.dirname(fromFile), spec)
  }
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  return null
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g
/** `import type` / `export type` 只在类型层面存在，不进产物 */
const TYPE_ONLY = /(?:^|\n)\s*(?:import|export)\s+type\s/
/**
 * 动态 `import('...')`。
 *
 * ⚠️ 正向检查（主包里有没有模拟器）**故意不跟它** —— 动态引入正是分包点，
 * 跟下去就等于把懒加载的东西也算进主包，那这个测试永远不可能通过。
 * 只有反向检查（懒加载那条路还完不完整）才跟。
 */
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/** 从 entry 出发的运行时依赖闭包，附带「谁把它引进来的」用于报错 */
function closure(entry, { followDynamic = false } = {}) {
  const seen = new Set()
  const via = new Map()
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let src
    try {
      src = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const matches = [...src.matchAll(IMPORT_RE)].filter((m) => !TYPE_ONLY.test(m[0]))
    if (followDynamic) matches.push(...src.matchAll(DYNAMIC_RE))
    for (const m of matches) {
      const target = resolveSpec(m[1], file)
      if (!target || seen.has(target)) continue
      if (!via.has(target)) via.set(target, file)
      stack.push(target)
    }
  }
  return { seen, via }
}

const isHeavy = (f) =>
  f.includes(`${path.sep}emulator${path.sep}adapters${path.sep}`) ||
  f.endsWith(`${path.sep}emulator${path.sep}EmulatorPlayer.tsx`) ||
  f.endsWith(`${path.sep}emulator${path.sep}runtimes.ts`)

/** 这些入口都会被打进主包（静态路由 / 到处引用的服务） */
const MAIN_BUNDLE_ENTRIES = {
  'AppRoutes（静态路由，主包）': 'src/AppRoutes.tsx',
  'RoomsPage（只要两个布尔判断）': 'src/pages/RoomsPage.tsx',
  'GameDetailPage（详情页，播放器是懒加载的）': 'src/pages/GameDetailPage.tsx',
  'PlayLocalPage': 'src/pages/PlayLocalPage.tsx',
  'EmbedPage': 'src/pages/EmbedPage.tsx',
  'services/roms.ts（游戏库到处在用）': 'src/services/roms.ts',
  '@/emulator 入口本身': 'src/emulator/index.ts',
}

let n = 0
for (const [label, rel] of Object.entries(MAIN_BUNDLE_ENTRIES)) {
  const entry = path.join(ROOT, rel)
  assert.ok(fs.existsSync(entry), `入口不存在：${rel}（文件改名了？请更新本测试）`)
  const { seen, via } = closure(entry)
  const hits = [...seen].filter(isHeavy)
  if (hits.length) {
    const detail = hits
      .slice(0, 8)
      .map((h) => `    ${path.relative(ROOT, h)}\n      ← 被 ${path.relative(ROOT, via.get(h) ?? entry)} 引入`)
      .join('\n')
    assert.fail(
      `${label} 会把模拟器实现拉进主包：\n${detail}\n` +
        '  修法：只从 @/emulator 拿轻量的东西（registry / runtimeMeta / paths），\n' +
        '  播放器一律走 @/emulator/PlayerChunk 的懒加载版本。',
    )
  }
  n++
  console.log(`✅ ${label}`)
}

/* 反过来也要成立：懒加载那条路必须真的能到达全部适配器，别拆着拆着把谁拆丢了 */
const { seen: lazySeen } = closure(path.join(ROOT, 'src/emulator/PlayerChunk.tsx'), { followDynamic: true })
/**
 * ⚠️ 这张名单必须和 src/emulator/runtimes.ts 的 MOUNTS 一一对应。
 * 加了新适配器却忘了加进来的话，这条断言照样绿 —— 它只查「名单里的都到得了」，
 * 查不出「有个新的没进名单」。所以下面额外按目录清点一次。
 */
const ADAPTERS = ['emulatorjs', 'ruffle', 'html5', 'jsnes', 'j2me', 'jsdos', 'webretro', 'play', 'cloudgame', 'liveview']

// 目录里有几个适配器，名单里就该有几个 —— 这一条才真的挡得住「新加的忘了登记」
const onDisk = fs
  .readdirSync(path.join(SRC, 'emulator', 'adapters'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.replace(/\.ts$/, ''))
  .sort()
assert.deepEqual(
  [...ADAPTERS].sort(),
  onDisk,
  `adapters/ 目录和这张名单对不上。新加的适配器要同时登记到 runtimes.ts 和这里`,
)
for (const a of ADAPTERS) {
  const want = path.join(SRC, 'emulator', 'adapters', `${a}.ts`)
  assert.ok(lazySeen.has(want), `懒加载那条路没有引到适配器 ${a} —— runtimes.ts 里漏了？`)
}
n++
console.log(`✅ 懒加载链路仍然覆盖全部 ${ADAPTERS.length} 个适配器`)

console.log(`\n全部通过 ✅（${n} 项）`)

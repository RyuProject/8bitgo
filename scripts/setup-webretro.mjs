#!/usr/bin/env node
/**
 * 把 webretro（RetroArch 的 WebAssembly 移植，BinBashBanana/webretro，GPL-3.0）
 * 安装到 public/webretro/，供 src/emulator/adapters/webretro.ts 以 iframe 加载。
 *
 *   npm run webretro                              重新安装
 *   node scripts/setup-webretro.mjs --if-missing  已装则跳过（dev / build 前自动执行）
 *   node scripts/setup-webretro.mjs --cores=melonds,mgba   只装指定核心（默认全装）
 *   node scripts/setup-webretro.mjs --no-patch    不打下面那几个补丁（排查问题时用）
 *
 * 只做稀疏检出，不需要 emscripten —— 仓库里带的就是编译好的 .wasm。
 *
 * ── 为什么要打补丁 ────────────────────────────────────────────
 * webretro 原本是为「独立站点 + jsDelivr」设计的，直接搬过来有四个问题：
 *
 *   1. 运行时资源（bundle/，6.7MB 的 RetroArch 字体、着色器、手柄配置）写死从
 *      cdn.jsdelivr.net 拉。jsDelivr 在国内经常不通，不改的话玩家会卡在加载界面。
 *   2. rom= 参数只认 http(s):// 开头的地址，blob: 会被当成相对路径拼成 roms/blob:...。
 *      玩家「玩本地 ROM」用的正是 blob:，不改就没法跑本地文件。
 *   3. 文件名从 rom= 的末段截取，blob: URL 没有扩展名 —— 而 webretro 靠扩展名决定
 *      写进虚拟文件系统的 /rom/rom.<ext>，melonDS 拿到 rom.<一串uuid> 是不认的；
 *      存档也按这个名字进 IndexedDB，会变成一游戏一个乱码键。
 *   4. XHR 超时写死 8 秒。NDS ROM 动辄几十 MB，慢一点的网络必然超时。
 *
 * 另外 pwa.js 会注册 service worker 缓存整个 webretro —— 我们是嵌在自己站点的
 * iframe 里用，不需要 PWA，而且它会让重新部署后的玩家继续拿到旧版本。一并停掉。
 *
 * 每处补丁都断言「原文恰好出现 1 次」。上游哪天改了写法，这里会明确报错，
 * 而不是悄悄留下一个跑不起来的模拟器。
 *
 * ── 装完之后 ─────────────────────────────────────────────────
 *   .env 里设置 VITE_WEBRETRO_PATH=/webretro/
 *   没设这个变量时 webretro 运行时的 available() 为 false，NDS 会自动退回 EmulatorJS。
 *
 * 许可证：webretro 为 GPL-3.0，各 libretro 核心有各自的许可证。
 * 它在独立 iframe 里作为单独程序运行，仓库自带的 LICENSE 会一并复制过去。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const dest = path.join(root, 'public/webretro')
const tmp = path.join(root, '.webretro-tmp')
const REPO = 'https://github.com/BinBashBanana/webretro.git'

const argv = process.argv.slice(2)
const ifMissing = argv.includes('--if-missing')
const noPatch = argv.includes('--no-patch')
const coresArg = argv.find((a) => a.startsWith('--cores='))
/** 只装这几个核心；为空表示全装 */
const onlyCores = coresArg
  ? coresArg
      .slice('--cores='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : []

if (existsSync(path.join(dest, 'index.html'))) {
  if (ifMissing) {
    console.log('✅ public/webretro/ 已存在，跳过')
    process.exit(0)
  }
  console.log('ℹ️  public/webretro/ 已存在，将重新安装')
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'pipe' })
}

try {
  run('git', ['--version'])
} catch {
  console.error('❌ 需要 git。请先安装 git，或手动把 webretro 仓库内容复制到 public/webretro/')
  process.exit(1)
}

/* ---------------- 1. 稀疏检出 ---------------- */

// source/（构建说明）、utils/、embed/ 都用不上：embed 只是个 25 行的 iframe 包装，
// 我们自己的适配器已经在做同样的事，还多一层脚本要加载。
const SPARSE = ['/index.html', '/manifest.json', '/pwa.js', '/pwa-sw.js', '/LICENSE', '/assets/', '/bundle/', '/uauth/', '/info/']

rmSync(tmp, { recursive: true, force: true })

try {
  console.log('正在拉取 webretro（稀疏检出，跳过源码与构建脚本）…')
  run('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', REPO, tmp], root)

  const sparse = [...SPARSE]
  if (onlyCores.length) {
    for (const c of onlyCores) {
      sparse.push(`/cores/${c}_libretro.js`, `/cores/${c}_libretro.wasm`)
    }
  } else {
    sparse.push('/cores/')
  }
  // --no-cone：cone 模式只接受目录，而我们还要点名根目录下的单个文件
  run('git', ['sparse-checkout', 'set', '--no-cone', ...sparse], tmp)

  if (!existsSync(path.join(tmp, 'index.html'))) throw new Error('检出结果里没有 index.html')
  if (!existsSync(path.join(tmp, 'cores'))) throw new Error(`检出结果里没有 cores/（--cores 写错了？${onlyCores.join(',')}）`)

  rmSync(dest, { recursive: true, force: true })
  mkdirSync(path.dirname(dest), { recursive: true })
  cpSync(path.join(tmp), dest, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes('.git'),
  })

  /* ---------------- 2. 打补丁 ---------------- */

  /** 断言式替换：原文必须恰好出现一次，否则报错退出 */
  const patches = []
  function patch(file, needle, replacement, why) {
    const p = path.join(dest, file)
    const code = readFileSync(p, 'utf8')
    const times = code.split(needle).length - 1
    if (times !== 1) {
      throw new Error(
        `给 ${file} 打补丁失败：期望 1 处 ${JSON.stringify(needle.slice(0, 60))}，实际 ${times} 处。\n` +
          `  上游可能改了写法。可以先用 --no-patch 装上，再手工处理（补丁作用：${why}）。`,
      )
    }
    writeFileSync(p, code.replace(needle, replacement))
    patches.push(why)
  }

  if (!noPatch) {
    // bundle/ 与 info.json 改从本站取。留空字符串即可 —— grab() 用的是 XHR，
    // 相对地址会按 iframe 文档（<VITE_WEBRETRO_PATH>index.html）的 base 解析。
    patch(
      'assets/base.js',
      'var bundleCdn = "https://cdn.jsdelivr.net/gh/BinBashBanana/webretro@master/";',
      'var bundleCdn = ""; // 8bitgo: 改从本站 public/webretro/bundle/ 取，不依赖 jsDelivr',
      'bundle/ 资源改走本站',
    )
    patch(
      'assets/base.js',
      'var bundleCdnLatest = "https://cdn.jsdelivr.net/gh/BinBashBanana/webretro/";',
      'var bundleCdnLatest = ""; // 8bitgo: 同上',
      'bundle 索引改走本站',
    )
    patch(
      'assets/base.js',
      'var infoJsonUrl = "https://cdn.jsdelivr.net/gh/BinBashBanana/webretro/assets/info.json";',
      'var infoJsonUrl = "assets/info.json"; // 8bitgo: 本地已有这个文件',
      'info.json 改走本站',
    )
    // 让 rom= 认 blob:，玩家的本地 ROM 才能直接喂进去（同源 iframe 才读得到 blob:，
    // 这也是必须自托管、不能 iframe 官方站的原因之一）
    patch(
      'assets/base.js',
      'var romloc = (/^(https?:)?\\/\\//i).test(queries.rom)',
      'var romloc = (/^(https?:)?\\/\\/|^blob:/i).test(queries.rom) /* 8bitgo: 允许 blob: */',
      'rom= 支持 blob:（本地 ROM）',
    )
    // blob: URL 没有文件名，扩展名和存档键都要靠调用方另给
    patch(
      'assets/base.js',
      'var romFilename = queries.rom.split("/").slice(-1)[0];',
      'var romFilename = queries.romname || queries.rom.split("/").slice(-1)[0]; // 8bitgo: 允许显式指定文件名',
      '新增 romname= 参数',
    )
    // 8 秒对几十 MB 的 NDS ROM 完全不够
    patch(
      'assets/base.js',
      'req.timeout = 8000;',
      'req.timeout = 180000; // 8bitgo: NDS ROM 动辄几十 MB，8 秒会超时',
      'XHR 超时 8s → 180s',
    )
    // 停掉 PWA：我们嵌在自己站点里用，service worker 只会让重新部署后拿到旧版本。
    // 顺手反注册掉老访客浏览器里已经装上的那个。
    writeFileSync(
      path.join(dest, 'pwa.js'),
      [
        '// 8bitgo: 原文是 navigator.serviceWorker.register("pwa-sw.js")。',
        '// webretro 在我们这里是嵌进 iframe 用的，不需要 PWA；而且 service worker 会缓存整个',
        '// webretro，重新部署后老访客仍然拿到旧版本。这里改成反注册，把已经装上的也清掉。',
        'if ("serviceWorker" in navigator && location.protocol !== "file:") {',
        '  navigator.serviceWorker.getRegistrations?.().then(function (rs) {',
        '    rs.forEach(function (r) { if (r.scope.includes("webretro")) r.unregister() })',
        '  }).catch(function () {})',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    patches.push('停用 PWA service worker')
  }

  /* ---------------- 3. 汇总 ---------------- */

  let files = 0
  let bytes = 0
  const sizeOf = (dir) => {
    let n = 0
    for (const name of readdirSync(dir)) {
      const s = path.join(dir, name)
      const st = statSync(s)
      if (st.isDirectory()) n += sizeOf(s)
      else {
        n += st.size
        files++
      }
    }
    return n
  }
  bytes = sizeOf(dest)

  const coreList = readdirSync(path.join(dest, 'cores'))
    .filter((f) => f.endsWith('_libretro.wasm'))
    .map((f) => f.replace('_libretro.wasm', ''))

  console.log(`✅ 已安装到 public/webretro/ —— ${files} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`   核心 ${coreList.length} 个：${coreList.join(', ')}`)
  if (!coreList.includes('melonds')) {
    console.warn('   ⚠️ 没有 melonds 核心，NDS 跑不了（--cores 里加上 melonds）')
  }
  if (patches.length) console.log(`   已打补丁：${patches.join('；')}`)
  else console.log('   ⚠️ --no-patch：bundle 仍走 jsDelivr，本地 ROM 也用不了')
  console.log('   下一步：.env 里设置 VITE_WEBRETRO_PATH=/webretro/')
} catch (e) {
  console.error('❌ 安装失败：', e.message)
  console.error('   可以手动操作：git clone --depth 1 https://github.com/BinBashBanana/webretro.git')
  console.error('   然后把它的内容复制成 public/webretro/（补丁见本文件顶部注释）')
  process.exit(1)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

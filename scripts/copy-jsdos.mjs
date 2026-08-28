#!/usr/bin/env node
/**
 * 把 npm 包 js-dos（DOSBox 的浏览器移植，GPL-2.0）复制到 public/jsdos/，
 * 供 src/emulator/adapters/jsdos.ts 以 /jsdos/js-dos.js 加载。
 *
 *   npm run jsdos                              强制复制
 *   node scripts/copy-jsdos.mjs --if-missing   已有则跳过（dev / build 前自动执行）
 *   node scripts/copy-jsdos.mjs --with-dosbox-x  连 DOSBox-X 一起复制（多 15MB，跑 Win9x 才需要）
 *   node scripts/copy-jsdos.mjs --no-ipx-patch     不要去掉写死的 1900 端口（见下）
 *
 * 默认只复制经典 DOSBox 内核（wdosbox，1.4MB）—— DOSBox-X 两个 wasm 加起来 15MB，
 * 绝大多数 DOS 游戏用不上，全量复制会让 public/ 直接胖 20MB。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'node_modules', 'js-dos', 'dist')
const out = join(root, 'public', 'jsdos')
const ifMissing = process.argv.includes('--if-missing')
const withDosboxX = process.argv.includes('--with-dosbox-x')

/**
 * 把 js-dos.css 整个包进一个级联层（cascade layer）。
 *
 * 站点样式是 Tailwind v4，全部住在 @layer 里；js-dos.css 是 Tailwind v3 编译的、
 * **不带 layer** —— 而 CSS 规定不分层的样式压过所有分层样式，特异性再高也翻不了案。
 * 于是玩家一点「开始游戏」（js-dos.css 这时才挂进 <head>），它开头那套全局 reset
 * （a{color:inherit}、h1-h6{font-size:inherit}、.hidden{display:none}…）就把全站
 * 打回没有 CSS 的样子：按钮没底色、链接没颜色、布局塌成手机版。
 *
 * 包进 @layer jsdos 后它排进层序，而 src/index.css 的第一行把 jsdos 声明成
 * 优先级最低的层，站点样式就全压得住它；js-dos 自己的界面在层内级联不变。
 */
function wrapCssInLayer(file) {
  if (!existsSync(file)) return
  const css = readFileSync(file, 'utf8')
  if (css.startsWith('@layer jsdos{')) return
  writeFileSync(file, `@layer jsdos{${css}}`)
  console.log('✔ js-dos.css 已包进 @layer jsdos（防止它的全局 reset 压过站点样式）')
}

if (ifMissing && existsSync(join(out, 'js-dos.js'))) {
  // 已有的拷贝也要确保 css 包过层 —— 老拷贝正是没包的那种
  wrapCssInLayer(join(out, 'js-dos.css'))
  process.exit(0)
}

if (!existsSync(join(src, 'js-dos.js'))) {
  const msg = '未找到 node_modules/js-dos，请先 npm install'
  if (ifMissing) {
    console.warn(`⚠ ${msg}；DOS 游戏暂不可用`)
    process.exit(0)
  }
  console.error(`✖ ${msg}`)
  process.exit(1)
}

/** 用不上的东西：source map、调试符号，以及（默认情况下）DOSBox-X */
function skip(name) {
  if (name.endsWith('.map') || name.endsWith('.symbols')) return true
  if (!withDosboxX && name.includes('wdosbox-x')) return true
  return false
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

let count = 0
let bytes = 0
function copyDir(from, to) {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    if (skip(name)) continue
    const s = join(from, name)
    const d = join(to, name)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else {
      copyFileSync(s, d)
      bytes += statSync(d).size
      count++
    }
  }
}
copyDir(src, out)

/**
 * 去掉 IPX 联机里写死的 1900 端口。
 *
 * js-dos 连 IPX 服务器时拼的是 `<地址>:1900/ipx/<房间>`，这个端口号是硬编码的。
 * 1900 不在 Cloudflare 代理的端口列表里，照原样用就必须为它单开一个灰云子域名
 * 直连源站（暴露源站 IP）或者在源站另配一套 TLS。把这一处去掉之后，
 * IPX 就走主站同一个 443 端口的 /ipx/<房间>，橙云、现成证书、什么都不用改。
 *
 * 整个 js-dos.js 里这个字符串只出现一次；万一将来上游改了写法，这里会直接报错，
 * 而不是悄悄留下一个连不上的联机功能。
 */
if (!process.argv.includes('--no-ipx-patch')) {
  const file = join(out, 'js-dos.js')
  const code = readFileSync(file, 'utf8')
  const needle = '":1900/ipx/"'
  const times = code.split(needle).length - 1
  if (times === 1) {
    writeFileSync(file, code.replace(needle, '"/ipx/"'))
    console.log('✔ 已去掉 IPX 写死的 1900 端口 —— 中继可以和主站共用 443')
  } else {
    console.warn(`⚠ 没能给 IPX 打补丁：期望 1 处 ${needle}，实际找到 ${times} 处。`)
    console.warn('  js-dos 可能改了写法。IPX 联机会退回到需要 1900 端口的老方式，')
    console.warn('  服务端请改用 attachIpx({ port: 1900 })，详见 server/README.md。')
  }
}

wrapCssInLayer(join(out, 'js-dos.css'))

console.log(`✔ js-dos 已复制 ${count} 个文件（${(bytes / 1024 / 1024).toFixed(1)} MB）到 public/jsdos/`)
if (!withDosboxX) console.log('  （未包含 DOSBox-X；需要跑 Windows 9x 时加 --with-dosbox-x）')

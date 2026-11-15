/**
 * 给忽略提交的 FreeJ2ME 运行时打本站的低风险补丁。
 *
 * 上游运行时是构建时下载的，直接改 public/j2me 会在换机器或部署时丢失；
 * 因此补丁必须由 setup-j2me 在“已安装”和“刚安装”两条路径都执行。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { optOutRocketLoader } from '../shared/rocket-loader-optout.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const runtime = path.join(root, 'public/j2me')

function patchFile(relativePath, marker, removals) {
  const file = path.join(runtime, relativePath)
  let source = readFileSync(file, 'utf8')
  if (source.includes(marker)) return

  for (const snippet of removals) {
    if (!source.includes(snippet)) {
      throw new Error(`FreeJ2ME 上游源码结构变化，无法安全移除调试日志：${relativePath} / ${snippet}`)
    }
    source = source.replaceAll(snippet, '')
  }

  writeFileSync(file, `${marker}\n${source}`, 'utf8')
}

patchFile(
  'src/main.js',
  '/* 8BitGo patch: 高频输入和焦点回收不写控制台，避免游戏运行时制造主线程噪声。 */',
  ["console.log('queuin event');", "console.log('refocus');"],
)
patchFile(
  'libmidi/libmidi.js',
  '/* 8BitGo patch: MIDI 时长只供开发调试，不在玩家控制台输出。 */',
  ["console.log('duration', duration);"],
)

// 大陆加速入口的 Service Worker（scripts/j2me-web/edge-sw.js）。作用域就是 /j2me/，所以文件必须放在这个目录里。
copyFileSync(path.join(root, 'scripts/j2me-web/edge-sw.js'), path.join(runtime, 'edge-sw.js'))

/*
  run.html 的脚本不能交给 Cloudflare Rocket Loader（2026-11-14《仙剑奇侠传 2004》CN / Android Chrome 143）。
  区域开着 Rocket Loader：线上 run.html 里 loader.js 被改成 `type="<前缀>-text/javascript"`、main.js 改成 `-module`，
  要等 window load 之后才补执行。适配器在 iframe load 时看 cheerpjInit 判断「CheerpJ loader 没加载上」，
  于是每一局都误判（CDN 探测明明 ok），重载一次照旧，最后报「Java 运行时卡住了」。
  data-cfasync="false" 让这两个脚本按标准顺序执行。上游重装后由 setup-j2me 再打一遍，幂等。
*/
{
  const file = path.join(runtime, 'run.html')
  const source = readFileSync(file, 'utf8')
  const patched = optOutRocketLoader(source)
  if (!/<script data-cfasync="false" src="https:\/\/cjrtnc\.leaningtech\.com\//.test(patched)) {
    throw new Error('FreeJ2ME run.html 结构变化：没找到 CheerpJ loader.js 的 <script>，无法退出 Rocket Loader')
  }
  if (patched !== source) writeFileSync(file, patched, 'utf8')
}

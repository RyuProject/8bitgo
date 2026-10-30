/**
 * 给忽略提交的 FreeJ2ME 运行时打本站的低风险补丁。
 *
 * 上游运行时是构建时下载的，直接改 public/j2me 会在换机器或部署时丢失；
 * 因此补丁必须由 setup-j2me 在“已安装”和“刚安装”两条路径都执行。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

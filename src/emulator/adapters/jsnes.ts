/**
 * jsnes 运行时：只跑 NES (.nes)。
 *
 * jsnes 是纯 JavaScript 的 NES 模拟器（Apache-2.0），比 EmulatorJS 的 RetroArch 核心轻得多
 * —— 不用下载 WebAssembly 核心，打开就能玩。代价是 mapper 覆盖面较窄、精度略低，
 * 冷门卡带可能跑不起来；想换回 EmulatorJS 只要删掉 config/emulators.ts 里的 nes 那行。
 *
 * 这里用 jsnes 自带的高层 Browser 类：它负责 canvas、WebAudio、键盘与手柄，
 * 并提供 destroy() 做彻底清理，正好对上 Runtime.mount 的「返回销毁函数」约定。
 */
import type { MountOptions, Runtime } from '../types'
import { getT, fmt } from '@/services/i18n'

/** 把二进制转成 jsnes 需要的「binary string」（每个字符一个字节） */
function toBinaryString(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let out = ''
  // 分块拼接，避免超大 ROM 触发 apply 的参数上限
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return out
}

async function readRom(game: File | string): Promise<ArrayBuffer> {
  if (typeof game !== 'string') return game.arrayBuffer()
  const res = await fetch(game)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

function mount(container: HTMLElement, options: MountOptions): () => void {
  const rt = getT().runtime
  let destroyed = false
  let browser: { destroy: () => void; loadROM: (data: string) => void; fitInParent?: () => void } | null = null

  // 容器：jsnes 会把 canvas 塞进来
  const host = document.createElement('div')
  host.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000'
  container.appendChild(host)

  const onResize = () => browser?.fitInParent?.()

  void (async () => {
    try {
      const [{ Browser }, buf] = await Promise.all([import('jsnes'), readRom(options.game)])
      if (destroyed) return

      // ⚠️ 刻意不传 romData。
      // jsnes 的构造函数是「先把 document 级键盘监听挂上、启动手柄轮询，最后才 loadROM」，
      // 而 loadROM 会对非法 ROM 或不支持的 mapper 抛错。一旦在构造函数里抛出来，
      // 我们拿不到实例，也就调不到 destroy() —— 那三个 keydown/keyup/keypress 监听会永久
      // 留在 document 上，把全站的方向键和 Z/X/A/S 全部 preventDefault 掉：
      // 搜索框打不出字、页面没法用方向键滚动，只能刷新页面。
      // 分两步来，loadROM 抛错时实例已经在手上，可以正常清理干净。
      browser = new Browser({
        container: host,
        onError: (err: Error) => options.onError?.(fmt(rt.jsnesRunFailed, { msg: err.message })),
      }) as unknown as { destroy: () => void; loadROM: (data: string) => void; fitInParent?: () => void }

      try {
        browser.loadROM(toBinaryString(buf))
      } catch (e) {
        const inst = browser
        browser = null
        try {
          inst.destroy()
        } catch {
          /* 清理失败就算了，至少监听已经摘掉 */
        }
        throw e
      }

      window.addEventListener('resize', onResize)
      options.onReady?.()
      options.onStart?.()
    } catch (e) {
      if (destroyed) return
      const msg = e instanceof Error ? e.message : String(e)
      options.onError?.(fmt(rt.jsnesLoadFailed, { msg }))
    }
  })()

  return () => {
    destroyed = true
    window.removeEventListener('resize', onResize)
    try {
      browser?.destroy()
    } catch {
      /* 已经卸载过就忽略 */
    }
    host.remove()
  }
}

export const jsnesRuntime: Runtime = {
  id: 'jsnes',
  name: 'jsnes',
  get description() {
    return getT().runtime.jsnesDesc
  },
  extensions: ['nes'],
  // 比 EmulatorJS 高：命中 .nes 时优先用它
  priority: 20,
  available: () => true,
  supports: (platform) => platform === 'nes',
  engineLabel: () => 'jsnes',
  mount,
}

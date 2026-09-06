/**
 * id → 真正的挂载实现。**这是整个模块里唯一静态引入全部适配器的地方。**
 *
 * 所以它也是唯一「一被引用就会把整套模拟器拉进包里」的文件 ——
 * 请只让 EmulatorPlayer 引用它，而 EmulatorPlayer 由页面懒加载
 * （`lazyNamed(() => import('@/emulator/EmulatorPlayer'), …)`）。
 * 这样首页、博客、游戏库、房间列表这些**不跑游戏的页面**一个字节的引擎代码都不会下载。
 *
 * 判断「该用哪个引擎」不需要经过这里，走 registry.ts + runtimeMeta.ts 那条轻的路。
 */
import type { RuntimeId, RuntimeMount } from './types'
import { mount as emulatorjs } from './adapters/emulatorjs'
import { mount as ruffle } from './adapters/ruffle'
import { mount as html5 } from './adapters/html5'
import { mount as jsnes } from './adapters/jsnes'
import { mount as j2me } from './adapters/j2me'
import { mount as jsdos } from './adapters/jsdos'
import { mount as webretro } from './adapters/webretro'
import { mount as play } from './adapters/play'
import { mount as cloudgame } from './adapters/cloudgame'
import { mount as liveview } from './adapters/liveview'

const MOUNTS: Record<RuntimeId, RuntimeMount> = {
  emulatorjs,
  ruffle,
  html5,
  jsnes,
  j2me,
  jsdos,
  webretro,
  play,
  cloudgame,
  liveview,
}

/** 取某个运行时的挂载函数。id 来自 registry 解析出来的元数据 */
export function mountOf(id: RuntimeId): RuntimeMount {
  return MOUNTS[id]
}

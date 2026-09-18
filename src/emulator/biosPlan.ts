/**
 * 「这次开局要往虚拟文件系统里放哪几个 BIOS 包」的决策，单独一处、纯函数。
 *
 * ## 为什么值得单独成文件
 *
 * 街机这块有个绕不开的错配：**引擎只给一个 BIOS 槽位**（`EJS_biosUrl`），
 * 而一个街机平台底下其实是好几套硬件 —— Neo Geo 要 `neogeo.zip`，
 * IGS 的 PGM 板子要 `pgm.zip`（三国战纪、西游释厄传那一批）。
 * 于是「这款游戏额外要哪个」必须由我们自己写进文件系统根目录，
 * 而写不写、写哪个、什么时候干脆不写，有三条容易写错又不好在浏览器里复现的规则：
 *
 *   1. 没绑这个系统名的地址 → 不写，但要留下一条能查的日志（核心只会说「缺文件」）；
 *   2. 平台级那一份**正好就是这个系统名** → 不写，`EJS_biosUrl` 已经放进去了，
 *      再下一次是白白多花 1.5 MB 流量；
 *   3. 名字必须是核心要找的 set 名，落盘路径也就是 `/<set>.zip`。
 *
 * 抽出来的理由和 j2meUrl.ts 一样：这些判断在 iframe / 引擎启动流程里没法测，
 * 而它们恰恰是「改了看不出问题、线上少一个文件」的那类逻辑。
 * 回归：`npm run test:romdata`。
 */

/** 要写进虚拟文件系统的一个 BIOS 包 */
export interface BiosFilePlan {
  /** 绝对路径（Emscripten 虚拟文件系统里的路径），形如 `/pgm.zip` */
  path: string
  /** 下载地址 */
  url: string
}

export interface BiosPlan {
  files: BiosFilePlan[]
  /**
   * 要告诉管理员 / 排查者的一句话（没有就是 null）。
   * ⚠️ 这不是给玩家看的错误 —— 缺 BIOS 时该由核心自己报「缺哪个文件」，
   * 那条比我们编的准；这条只是让日志里有一句点名 bios:<名字> 的线索。
   */
  warning: string | null
}

/** 从地址里取出 BIOS 的 set 名（`/bios/neogeo.zip` → `neogeo`，取不到返回空串） */
export function biosNameOfUrl(url: string | undefined): string {
  if (!url) return ''
  const clean = String(url).split(/[?#]/)[0]
  const file = clean.slice(clean.lastIndexOf('/') + 1)
  return file.replace(/\.zip$/i, '').toLowerCase()
}

/**
 * 合法的系统名。和服务端 mappers.js 的 `arcadeBiosOf` 必须一致。
 *
 * ⚠️ **两处都要校验，不是重复劳动**：服务端那次管的是从库里读出来的值；
 * 而「玩本地 ROM」页的系统名是**浏览器里手输的**（本地文件在库里没有记录，没人替它校验），
 * 名字直接拿去拼虚拟文件系统的路径。填成 `../x` 这种就是往别的路径写文件 ——
 * 症状还是「文件写了、核心说找不到」，查起来毫无线索。
 */
const BIOS_NAME = /^[a-z0-9_]{1,32}$/

/**
 * @param biosUrl 平台级 BIOS 的地址（引擎会通过 EJS_biosUrl 自己下载它）
 * @param biosSet 这款游戏需要的系统包（名字 + 地址）；名字为空表示不需要 / 不知道
 */
export function planBiosFiles(
  biosUrl: string | undefined,
  biosSet: { name: string; url: string } | undefined,
): BiosPlan {
  const name = biosSet?.name?.trim().toLowerCase()
  if (!name) return { files: [], warning: null }

  if (!BIOS_NAME.test(name)) {
    return {
      files: [],
      warning:
        `[emulatorjs] BIOS 系统名「${name}」不合法：只能是字母、数字和下划线（例如 pgm、neogeo），不超过 32 个字符。` +
        '去游戏的「BIOS 包（系统名）」那一栏改正（「玩本地 ROM」页则是页面上那个输入框）。',
    }
  }

  /*
    平台级那一份的文件名**正好就是它** → 什么都不做：EJS_biosUrl 已经把这个文件放进
    虚拟文件系统了（核心就是在内容同目录按固定文件名找 BIOS 的），既不缺东西，
    也不用再下一遍白花流量。

    ⚠️ 这一条**必须**排在下面「没绑地址」那条判断**之前**：平台那格填的明明就是
    pgm.zip、核心也确实拿得到，只是没人另外绑一份 `bios:pgm` —— 顺序反了就会打出
    「后台没绑 bios:pgm 的地址」这句假警报，而它和「真没绑」的症状（核心报缺文件）
    一模一样，白查半天。后台面板按同一条规则显示（见 PlatformBiosPanel 的 coveredSet）。
  */
  if (biosNameOfUrl(biosUrl) === name) return { files: [], warning: null }

  if (!biosSet?.url) {
    return {
      files: [],
      warning:
        `[emulatorjs] 这款游戏需要 ${name} 的 BIOS，但后台没绑 bios:${name} 的地址 —— ` +
        '核心会报缺文件，去「ROM 存储 → 街机 BIOS 包」补一份。',
    }
  }

  return { files: [{ path: `/${name}.zip`, url: biosSet.url }], warning: null }
}

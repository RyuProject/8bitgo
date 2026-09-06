import type { Platform, PlatformId } from '@/types'

export const platforms: Platform[] = [
  {
    id: 'psx',
    name: 'PlayStation 1',
    shortName: 'PS1',
    nameZh: '索尼 PlayStation',
    manufacturer: 'Sony',
    year: 1994,
    runtime: 'emulatorjs',
    core: 'psx',
    romExtensions: ['.bin', '.cue', '.iso', '.img', '.pbp', '.chd', '.zip'],
    color: '#6d6dff',
    icon: '💿',
    description: '32 位时代的王者，3D 游戏的启蒙之地。铁拳、最终幻想、古惑狼都诞生于此。',
  },
  {
    id: 'ps2',
    name: 'PlayStation 2',
    shortName: 'PS2',
    nameZh: '索尼 PlayStation 2',
    manufacturer: 'Sony',
    year: 2000,
    /**
     * ⚠️ 唯一不走 EmulatorJS 的主机平台，而且是**实验性**的。
     *
     * EmulatorJS 的系统列表到 PSP 为止，没有 PS2 核心。浏览器里能跑 PS2 的只有
     * Play!（jpd002/Play- 的 Emscripten 构建），而它有两条**结构性**限制，
     * 是浏览器沙箱本身造成的、不是移植没做完：拿不到内存页写保护，
     * 于是 JIT cache 没法失效，在 EE 上动态加载模块的游戏会跑错；
     * 以及没法控制浮点舍入模式，一部分游戏的画面和物理会不对。
     * 作者自己的说法是 "only an experiment"。
     *
     * 所以这个平台在站上一律标注实验性，别按「和 PS1 一样能玩」来对待。
     * 想要真正的 PS2 兼容性，路只有一条：游戏跑在服务器上、画面串流（cloud-game）。
     */
    runtime: 'play',
    core: null,
    // .cso/.zso 是压缩 ISO，能省一半以上体积；.elf 是自制程序
    romExtensions: ['.iso', '.chd', '.cso', '.zso', '.isz', '.bin', '.elf'],
    color: '#1f3fa8',
    icon: '🎮',
    description: '双摇杆时代的霸主，史上销量最高的主机。战神、旺达与巨像、真三国无双都在这里。',
  },
  {
    id: 'flash',
    name: 'Flash / 网页游戏',
    shortName: 'FLASH',
    nameZh: 'Flash 网页游戏',
    manufacturer: 'Web',
    year: 2000,
    runtime: 'ruffle',
    core: null,
    romExtensions: ['.swf'],
    color: '#ff6a00',
    icon: '⚡',
    description: '课间十分钟的快乐源泉，塔防、跑酷、音乐节奏……浏览器里的黄金年代。',
  },
  {
    id: 'html5',
    name: 'HTML5 / WebAssembly',
    shortName: 'HTML5',
    nameZh: 'HTML5 网页游戏',
    manufacturer: 'Web',
    year: 2014,
    runtime: 'html5',
    core: null,
    romExtensions: ['.html', '.htm'],
    color: '#00a884',
    icon: '🌐',
    description: '原生运行在现代浏览器里的 HTML5 与 WebAssembly 游戏，无需额外模拟器。',
  },
  {
    id: 'arcade',
    name: 'Arcade 街机',
    shortName: 'ARCADE',
    nameZh: '街机',
    manufacturer: 'SNK / Capcom / Namco',
    year: 1978,
    runtime: 'emulatorjs',
    core: 'arcade',
    romExtensions: ['.zip'],
    color: '#ff2d78',
    icon: '🕹️',
    description: '投币、摇杆、连招。拳皇、合金弹头、街霸，游戏厅里的传奇今天仍在延续。',
  },
  {
    id: 'n64',
    name: 'Nintendo 64',
    shortName: 'N64',
    nameZh: '任天堂 64',
    manufacturer: 'Nintendo',
    year: 1996,
    runtime: 'emulatorjs',
    core: 'n64',
    romExtensions: ['.z64', '.n64', '.v64', '.zip'],
    color: '#2bb673',
    icon: '🎮',
    description: '四个手柄插槽定义了客厅派对：马力欧赛车、任天堂明星大乱斗、黄金眼 007。',
  },
  {
    id: 'nes',
    name: 'Famicom / NES',
    shortName: 'NES',
    nameZh: '红白机',
    manufacturer: 'Nintendo',
    year: 1983,
    runtime: 'emulatorjs',
    core: 'nes',
    romExtensions: ['.nes', '.unf', '.fds', '.zip'],
    color: '#e53935',
    icon: '🍄',
    image: '/ui/NES.svg',
    description: '8 位机的黄金标准。超级马力欧、魂斗罗、坦克大战——一切从这里开始。',
  },
  {
    id: 'snes',
    name: 'Super Famicom / SNES',
    shortName: 'SNES',
    nameZh: '超级任天堂',
    manufacturer: 'Nintendo',
    year: 1990,
    runtime: 'emulatorjs',
    core: 'snes',
    romExtensions: ['.sfc', '.smc', '.fig', '.zip'],
    color: '#8e7cc3',
    icon: '🌈',
    description: '16 位机的巅峰之作，Mode 7 与色彩爆炸的年代：超级马力欧世界、时空之轮、超级银河战士。',
  },
  {
    id: 'nds',
    name: 'Nintendo DS',
    shortName: 'NDS',
    nameZh: '任天堂 DS',
    manufacturer: 'Nintendo',
    year: 2004,
    runtime: 'emulatorjs',
    core: 'nds',
    romExtensions: ['.nds', '.srl', '.zip'],
    color: '#4fc3f7',
    icon: '📱',
    description: '双屏加触控，创意迸发的掌机。宝可梦白金、马力欧赛车 DS、应援团。',
  },
  {
    id: 'gba',
    name: 'Game Boy Advance',
    shortName: 'GBA',
    nameZh: 'GBA',
    manufacturer: 'Nintendo',
    year: 2001,
    runtime: 'emulatorjs',
    core: 'gba',
    romExtensions: ['.gba', '.zip'],
    color: '#7e57c2',
    icon: '🟣',
    description: '32 位掌机小钢炮。火焰之纹章、宝可梦绿宝石、恶魔城晓月圆舞曲，掌上 RPG 的黄金时代。',
  },
  {
    id: 'gb',
    name: 'Game Boy',
    shortName: 'GB',
    nameZh: 'Game Boy',
    manufacturer: 'Nintendo',
    year: 1989,
    runtime: 'emulatorjs',
    core: 'gb',
    romExtensions: ['.gb', '.zip'],
    color: '#9ccc65',
    icon: '🟩',
    description: '四色灰阶也挡不住的乐趣：宝可梦红绿、俄罗斯方块、织梦岛。',
  },
  {
    id: 'gbc',
    name: 'Game Boy Color',
    shortName: 'GBC',
    nameZh: 'Game Boy Color',
    manufacturer: 'Nintendo',
    year: 1998,
    runtime: 'emulatorjs',
    /**
     * 核心仍然填 'gb'：EmulatorJS 的核心别名表里**没有** gbc 这一项
     * （见它 emulator.js 的 getCores()，只有 gb → gambatte），而 gambatte 本来就同时
     * 跑 GB 和 GBC —— 卡带头里那个 CGB 标志会告诉它按哪种机器工作。
     * 这里填 'gbc' 的话 EmulatorJS 会拿它当核心文件名去下，直接 404。
     */
    core: 'gb',
    romExtensions: ['.gbc', '.zip'],
    color: '#00bcd4',
    icon: '🎨',
    description: '把掌机带进彩色时代：宝可梦金银、塞尔达传说 织梦岛 DX、瓦力欧乐园 3。',
  },
  {
    id: 'segaMD',
    name: 'Sega Genesis / Mega Drive',
    shortName: 'MD',
    nameZh: '世嘉 MD',
    manufacturer: 'Sega',
    year: 1988,
    runtime: 'emulatorjs',
    core: 'segaMD',
    romExtensions: ['.md', '.gen', '.bin', '.smd', '.zip'],
    color: '#1e88e5',
    icon: '🦔',
    description: '「Blast Processing」！索尼克、怒之铁拳、战斧，世嘉最硬核的 16 位主机。',
  },
  {
    id: 'dos',
    name: 'MS-DOS',
    shortName: 'DOS',
    nameZh: 'DOS 电脑游戏',
    manufacturer: 'PC',
    year: 1981,
    runtime: 'jsdos',
    core: 'dos',
    romExtensions: ['.zip', '.exe', '.com', '.jsdos'],
    color: '#546e7a',
    icon: '💾',
    description: '命令行时代的 PC 经典：毁灭战士、波斯王子、暗黑破坏神、沙丘 2。',
  },
  {
    id: 'ws',
    name: 'WonderSwan / Color',
    shortName: 'WSC',
    nameZh: '神奇天鹅',
    manufacturer: 'Bandai',
    year: 1999,
    runtime: 'emulatorjs',
    core: 'ws',
    romExtensions: ['.ws', '.wsc', '.zip'],
    color: '#ffb300',
    icon: '🦢',
    description: '横井军平的遗作，一节电池玩几十小时，收录了最终幻想与海贼王等佳作。',
  },
  {
    id: 'java',
    name: 'Java (J2ME)',
    shortName: 'JAVA',
    nameZh: 'Java 手机游戏',
    manufacturer: 'Mobile',
    year: 2001,
    runtime: null,
    core: null,
    romExtensions: ['.jar'],
    color: '#26a69a',
    icon: '☕',
    description: '功能机时代的回忆：狂野飙车 3、钻石狂潮、弹跳小球。',
  },
]

export const platformMap: Record<string, Platform> = Object.fromEntries(
  platforms.map((p) => [p.id, p]),
)

/**
 * 「能跑，但别当成正常平台」的平台。
 *
 * 目前只有 PS2：浏览器里唯一的 PS2 模拟器（Play!）有两条浏览器沙箱造成的结构性限制，
 * 大多数游戏跑不起来或画面不对，详见 src/emulator/adapters/play.ts 的文件头。
 *
 * 这不是「还没做完」的意思 —— 做完了也是这样，所以要长期挂着这个标记。
 * 有它的平台在平台卡和游戏详情页上都会显示实验性提示。
 */
export const EXPERIMENTAL_PLATFORMS = new Set<PlatformId>(['ps2'])

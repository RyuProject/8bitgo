/**
 * 加载进度的回归测试 —— 盯的是「一直卡在 80% 不动」那个用户报告。
 *
 * 80% 不是巧合，它是 `LOAD_PHASE_RANGE.rom` 的上界。事故链条是这样的：
 *
 *   1. EmulatorJS（站上绝大多数平台的运行时）和 J2ME **从来不报 `phase: 'starting'`**
 *   2. ROM 下完 → 整条进度正好 0.80，而进度时钟还停在 'rom'
 *   3. 播放器的视觉计时器按 'rom' 算，上限是 `0.8 - 0.01 = 0.79`
 *   4. 0.79 < 0.80，被 `Math.max(已显示, 计时值)` 原样吃掉
 *   5. 于是 WASM 编译 + 核心初始化那十几到几十秒里，条子**一个像素都不动**
 *
 * 修法是在播放器里定一条通用规矩：当前阶段跑满了就自己进下一阶段（不等适配器报）。
 * 这里把那条规矩和视觉计时器的公式一起复刻出来，验「有它」和「没它」的差别 ——
 * 公式本身在 EmulatorPlayer.tsx 里，是 React 组件的一部分，没法直接 import。
 *
 * 跑：npm run test:load-progress
 */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const {
  createOverallRatio,
  createSpeedMeter,
  liftRatio,
  LOAD_PHASE_RANGE,
  nextStartupMilestone,
  startingSegmentMs,
  STARTING_MILESTONE,
  STARTING_MILESTONE_CAP,
  windowsGuestStartupBudgetMs,
} = await import(fileURLToPath(new URL('../src/emulator/loadProgress.ts', import.meta.url)))
const { formatSpeed } = await import(fileURLToPath(new URL('../src/lib/emulator.ts', import.meta.url)))

/* ---- 播放器那套的最小复刻（逐字照抄 EmulatorPlayer.tsx 的公式与常量）---- */
const PHASE_ORDER = ['engine', 'assets', 'rom', 'starting']
const LOAD_PHASE_DURATION_MS = { engine: 20_000, assets: 45_000, rom: 45_000 }
const CEILING = 0.99

/** 逐字照抄 EmulatorPlayer.tsx 的 makeProgressClock */
function makeClock(phase, startup = 0, milestones = false, now = 0) {
  const [start, end] = LOAD_PHASE_RANGE[phase]
  const span = end - start
  const segmented = phase === 'starting' && milestones
  return {
    phase,
    startedAt: now,
    from: segmented ? start + span * startup : start,
    to: segmented ? start + span * nextStartupMilestone(startup) : end,
    startup: segmented ? startup : 0,
    milestones,
  }
}

function makePlayer({ autoAdvance, floor = 0, milestones = false, launchDelay = 24 }) {
  const overall = createOverallRatio(floor)
  let clock = makeClock('engine', 0, milestones, 0)
  let shown = floor

  const enterPhase = (phase, now) => {
    if (PHASE_ORDER.indexOf(phase) <= PHASE_ORDER.indexOf(clock.phase)) return
    clock = makeClock(phase, 0, milestones, now)
  }
  const enterMilestone = (startup, now) => {
    if (startup === undefined) return
    if (clock.phase !== 'starting' || startup <= clock.startup + 1e-6) return
    clock = makeClock('starting', Math.min(STARTING_MILESTONE_CAP, startup), true, now)
  }
  const advance = (now) => {
    if (clock.phase === 'starting') {
      if (!clock.milestones) return
      const next = nextStartupMilestone(clock.startup)
      if (next >= 1) return
      clock = makeClock('starting', next, true, now)
      return
    }
    const next = PHASE_ORDER[PHASE_ORDER.indexOf(clock.phase) + 1]
    if (next) clock = makeClock(next, 0, clock.milestones, now)
  }
  return {
    get shown() { return shown },
    get phase() { return clock.phase },
    get startup() { return clock.startup },
    onProgress(p, now) {
      enterPhase(p.phase, now)
      enterMilestone(p.startup, now)
      const actual = Math.min(CEILING, overall(p))
      shown = Math.max(shown, actual)
      if (autoAdvance && actual >= LOAD_PHASE_RANGE[clock.phase][1] - 1e-6) advance(now)
    },
    /** 250ms 那个视觉计时器的一拍 */
    tick(now) {
      const duration =
        clock.phase === 'starting'
          ? startingSegmentMs(clock.startup, clock.milestones, launchDelay)
          : LOAD_PHASE_DURATION_MS[clock.phase]
      const elapsed = now - clock.startedAt
      const visualStart = Math.max(0.01, clock.from)
      const visualEnd = Math.max(visualStart, Math.min(CEILING, clock.to - 0.01))
      shown = Math.max(
        shown,
        Math.min(CEILING, liftRatio(floor, visualStart + (visualEnd - visualStart) * Math.min(1, elapsed / duration))),
      )
      if (autoAdvance && elapsed >= duration) advance(now)
    },
  }
}

/**
 * 复刻 2026-09-11 实测到的那条 Windows 客体时间线（zeek-the-geek / Win3.11，热缓存）。
 * 时刻是实测值，不是拍脑袋：0.4s 下载完、0.5s 后 ci-ready、2.4s 桌面、
 * 改完之后约 12s 敲完命令。
 */
function runWindowsGuestLoad(player, t0 = 0) {
  player.onProgress({ phase: 'engine', ratio: 1 }, t0)
  player.onProgress({ phase: 'assets', loaded: 6_425_021, total: 6_425_021, ratio: 1 }, t0 + 300)
  player.onProgress({ phase: 'rom', loaded: 166_281, total: 166_281, ratio: 1 }, t0 + 400)
  player.onProgress({ phase: 'starting' }, t0 + 400)
  return t0 + 400
}

/** 复刻 EmulatorJS 的行为：报 engine / rom，**从不报 starting** */
function runEmulatorJsLoad(player, { t0 = 0 } = {}) {
  player.onProgress({ phase: 'engine', loaded: 2_000_000, total: 2_000_000, ratio: 1 }, t0)
  player.onProgress({ phase: 'rom', loaded: 500_000, total: 1_000_000, ratio: 0.5 }, t0 + 1000)
  player.onProgress({ phase: 'rom', loaded: 1_000_000, total: 1_000_000, ratio: 1 }, t0 + 2000)
  return t0 + 2000
}

let n = 0
let failedChecks = 0
/**
 * ⚠️ 断言失败**不再抛异常**，而是记一笔继续往下跑。
 *
 * 原来是 `assert.ok(cond, msg)` —— 第一条炸了整个进程就退出，后面的用例一条都不执行。
 * 2026-09-11 的教训：test:indexnow 从 09-08 起就红着，28 条里只跑到第 6 条，
 * 后面 22 条三天没被执行过，而没人知道，因为根本没人跑它（现在有 `npm test` 了）。
 * 一条小毛病不该把整套的价值清零。
 *
 * 退出码由下面那个 exit 钩子负责 —— 有失败就是非零，绝不会变成静默通过。
 */
const ok = (cond, msg) => {
  if (cond) {
    n++
    console.log('✅ ' + msg)
    return
  }
  failedChecks++
  console.log('❌ ' + msg)
}
process.on('exit', () => {
  if (failedChecks) {
    console.log(`\n❌ ${failedChecks} 项失败（上面带 ❌ 的那几条）`)
    process.exitCode = 1
  }
})

console.log('── 复现旧行为：确认 80% 真的会冻住 ──')
{
  const old = makePlayer({ autoAdvance: false })
  const t = runEmulatorJsLoad(old)
  ok(Math.abs(old.shown - 0.8) < 1e-9, `ROM 下完时正好停在 ${(old.shown * 100).toFixed(0)}%`)
  ok(old.phase === 'rom', '而进度时钟还停在 rom —— EmulatorJS 不报 starting')
  // 之后 30 秒一个进度事件都没有（WASM 在编译），只有视觉计时器在跑
  for (let i = 1; i <= 120; i++) old.tick(t + i * 250)
  ok(Math.abs(old.shown - 0.8) < 1e-9, '⭐ 30 秒过去，条子一个像素都没动 —— 这就是用户报的「卡在 80%」')
}

console.log('\n── 新行为：跑满就自己进下一阶段 ──')
{
  const p = makePlayer({ autoAdvance: true })
  const t = runEmulatorJsLoad(p)
  ok(p.phase === 'starting', '⭐ ROM 一下完就自动进了 starting，不等适配器报')
  p.tick(t + 5_000)
  ok(p.shown > 0.8, `5 秒后已经走到 ${(p.shown * 100).toFixed(0)}%，条子在动`)
  for (let i = 1; i <= 200; i++) p.tick(t + i * 250)
  ok(p.shown > 0.95 && p.shown <= CEILING, `一直爬到 ${(p.shown * 100).toFixed(0)}%，且不超过 99% 的天花板`)
}

console.log('\n── 拿不到 Content-Length 时也不能冻住 ──')
{
  /*
    没有 total 时 ratio 是 undefined，createOverallRatio 走渐近映射，
    **永远到不了阶段上界** —— 光靠「跑满了」那一条救不回来，还得靠「视觉预算耗光」那一条。
  */
  const p = makePlayer({ autoAdvance: true })
  p.onProgress({ phase: 'rom', loaded: 300_000 }, 0)
  const before = p.shown
  ok(p.shown < 0.8, `渐近映射到 ${(before * 100).toFixed(0)}%，够不到 80% 的上界`)
  for (let i = 1; i <= 200; i++) p.tick(i * 250)
  ok(p.phase === 'starting', '⭐ rom 阶段的视觉预算耗光后照样进了 starting')
  ok(p.shown > 0.8, `最终走到 ${(p.shown * 100).toFixed(0)}%，没有停在 79%`)
}

console.log('\n── 只进不退 ──')
{
  const p = makePlayer({ autoAdvance: true })
  p.onProgress({ phase: 'rom', loaded: 900_000, total: 1_000_000, ratio: 0.9 }, 0)
  const high = p.shown
  // 迟到的 engine 事件（引擎乱序报数）不能把条子拽回去
  p.onProgress({ phase: 'engine', loaded: 100, total: 1_000_000, ratio: 0.0001 }, 100)
  ok(p.shown >= high, '迟到的早期阶段事件不会让条子倒退')
}

console.log('\n── 复现旧行为：Windows 客体「80% 之后一动不动」──')
{
  /*
    旧公式：starting 那一格直接拿 windowsGuestStartupBudgetMs 当 duration。
    这里不用跑播放器，算一下就知道有多离谱。
  */
  const budget = windowsGuestStartupBudgetMs(24)
  ok(budget === 389_000, `旧的视觉预算是 ${budget / 1000} 秒（= 24 + 90 + 15 + 20 + 240）`)
  const at = (ms) => 0.8 + (0.99 - 0.8) * Math.min(1, ms / budget)
  const onePercent = (budget * 0.01) / 0.19
  ok(Math.round(onePercent / 100) / 10 === 20.5, `⭐ 按它铺 0.80→0.99，1% 要走 ${(onePercent / 1000).toFixed(1)} 秒`)
  ok(Math.round(at(39_000) * 100) === 82, `⭐ 游戏 39 秒就跑起来了，条子才走到 ${Math.round(at(39_000) * 100)}% —— 这就是用户报的「80% 之后特别慢」`)
}

console.log('\n── 新行为：Windows 客体按里程碑推进 ──')
{
  const p = makePlayer({ autoAdvance: true, milestones: true })
  let t = runWindowsGuestLoad(p)
  ok(Math.abs(p.shown - 0.8) < 1e-9, `下载完正好 ${(p.shown * 100).toFixed(0)}%`)
  ok(p.phase === 'starting', '进了 starting')

  p.onProgress({ phase: 'starting', startup: STARTING_MILESTONE.ci }, t + 500)
  ok(Math.round(p.shown * 100) === 86, `⭐ ci-ready（qcow2 建盘完成）→ ${Math.round(p.shown * 100)}%`)

  p.onProgress({ phase: 'starting', startup: STARTING_MILESTONE.desktop }, t + 2500)
  ok(Math.round(p.shown * 100) === 91, `⭐ 桌面画完了 → ${Math.round(p.shown * 100)}%`)

  // 盯画面 + 按键链那十来秒里没有任何事件，只有视觉计时器在跑
  for (let i = 1; i <= 40; i++) p.tick(t + 2500 + i * 250)
  const crawling = p.shown
  ok(crawling > 0.91 && crawling < 0.97, `按键链期间条子仍在爬（${(crawling * 100).toFixed(0)}%），且没越过下一个里程碑`)

  p.onProgress({ phase: 'starting', startup: STARTING_MILESTONE.launched }, t + 12_000)
  ok(Math.round(p.shown * 100) === 97, `⭐ 启动命令敲完 → ${Math.round(p.shown * 100)}%`)

  // 最后那一格永远留给 onReady
  for (let i = 1; i <= 400; i++) p.tick(t + 12_000 + i * 250)
  ok(p.shown <= CEILING + 1e-9, `视觉进度封顶在 ${(p.shown * 100).toFixed(0)}%，100% 只能由 onReady 画`)
}

console.log('\n── 里程碑只进不退、且封不到顶 ──')
{
  const overall = createOverallRatio()
  const high = overall({ phase: 'starting', startup: STARTING_MILESTONE.launched })
  const late = overall({ phase: 'starting', startup: STARTING_MILESTONE.ci })
  ok(late >= high, '迟到的早期里程碑（ci 排在 desktop 后面才跑）不会让条子倒退')

  const maxed = createOverallRatio()({ phase: 'starting', startup: 1 })
  ok(maxed <= 0.8 + 0.2 * STARTING_MILESTONE_CAP + 1e-9, `适配器就算报 startup: 1 也只到 ${(maxed * 100).toFixed(0)}%`)
  ok(maxed < 0.99, '⭐ 无论如何画不到 100% —— 那一步只能由 onReady 走')
}

console.log('\n── starting 阶段仍然不吃 ratio ──')
{
  /*
    ruffle / jsnes / webretro 都是资源一读完就报 `starting: 1`，那只表示「资源准备完了」。
    认了它条子会当场冲到 98% 再原地不动 —— 和「卡在 80%」是同一种病，只换了个数字。
  */
  const overall = createOverallRatio()
  ok(Math.abs(overall({ phase: 'starting', ratio: 1 }) - 0.8) < 1e-9, '⭐ `starting: 1` 仍然只算 80%')
}

console.log('\n── 别的运行时不能被分段拖慢 ──')
{
  /*
    里程碑只有 Windows 客体报得出来。给别的运行时也切成四小格的话，每格都要先耗光
    自己的预算才往下走，80→99% 会从 45 秒变成 180 秒 —— 那是把这次要修的 bug
    搬到别的平台上再犯一遍。
  */
  const p = makePlayer({ autoAdvance: true })
  const t = runEmulatorJsLoad(p)
  ok(p.phase === 'starting' && p.startup === 0, 'EmulatorJS 进了 starting，且没有里程碑')
  for (let i = 1; i <= 200; i++) p.tick(t + i * 250)
  ok(p.shown > 0.95, `⭐ 50 秒内照样爬到 ${(p.shown * 100).toFixed(0)}%，没被切段拖慢`)
}

console.log('\n── 分段预算本身 ──')
{
  ok(startingSegmentMs(0, false) === 45_000, '非客体：整段 45 秒，和以前一样')
  ok(startingSegmentMs(0, true) === 90_000, 'Dos() → ci-ready 给 90 秒（冷启动实测 ~72 秒）')
  ok(startingSegmentMs(STARTING_MILESTONE.ci, true) === 30_000, 'ci-ready → 桌面给 30 秒')
  ok(
    startingSegmentMs(STARTING_MILESTONE.desktop, true, 24) === 39_000,
    '桌面 → 敲完命令 = dosLaunchDelay 上限 24 秒 + 按键链 15 秒',
  )
  ok(startingSegmentMs(STARTING_MILESTONE.launched, true) === 20_000, '敲完 → 第一帧 = 那段画面确认的 20 秒')
  ok(nextStartupMilestone(STARTING_MILESTONE.launched) === 1, '最后一个里程碑之后就是终点')
}

console.log('\n── 速度表 ──')
{
  const m = createSpeedMeter(3000)
  m.push(0, 0)
  m.push(100_000, 1000)
  ok(Math.abs(m.read(1000) - 100_000) < 1, '1 秒下了 100KB → 100000 B/s')

  // 换文件：loaded 从头开始数，不能算成负数
  const m2 = createSpeedMeter(3000)
  m2.push(0, 0)
  m2.push(500_000, 1000)
  m2.push(200_000, 2000) // 新文件，从 0 数到 200KB
  const v = m2.read(2000)
  ok(v > 0, `⭐ 换文件（loaded 回退）之后速度仍是正数：${Math.round(v)} B/s，不是负数`)
  ok(Math.abs(v - 350_000) < 1000, '两秒共 700KB，窗口内均速约 350KB/s')

  // 下载停了要衰减到 0 —— WASM 编译那几十秒必须停止显示速度
  const m3 = createSpeedMeter(3000)
  m3.push(0, 0)
  m3.push(1_000_000, 1000)
  ok(m3.read(1000) > 0, '刚下完时有速度')
  ok(m3.read(2500) > 0, '窗口内还没走完，仍有读数')
  ok(m3.read(10_000) === 0, '⭐ 停了 9 秒后衰减到 0 —— 界面据此把速度那一格藏掉，不挂着旧读数骗人')

  // 边界
  const m4 = createSpeedMeter(3000)
  ok(m4.read(0) === 0, '一个样本都没有时是 0，不是 NaN')
  m4.push(undefined, 0)
  m4.push(undefined, 1000)
  ok(m4.read(1000) === 0, '只有阶段、没有字节数（loaded 为空）时是 0')
  const m5 = createSpeedMeter(3000)
  m5.push(0, 5000)
  m5.push(100, 5000) // 同一毫秒
  ok(Number.isFinite(m5.read(5000)), '同一时刻的两个样本不会除出 Infinity')
}

console.log('\n── 自动重试 / 换引擎：保留百分比就必须抬 floor ──')
{
  /*
    ⚠️ 这一组盯的是「修好一个 80%，又造出一个 60%」。

    自动重试属于同一次开始游戏，播放器**刻意保留**玩家已经看到的百分比（不保留的话
    慢网上下到 60% 断一次，条子会当着他的面跳回 0%）。但第二轮的进度是从 0 重算的，
    显示取 `Math.max(已显示, 新算的)` —— engine 段最高 0.19、assets 0.39、rom 0.79
    全都输给那个 0.60，条子在整个第二次下载期间纹丝不动。
  */

  {
    // 复刻旧行为：保留了 0.60（Math.max 的另一半），但新一轮 floor=0 从头算
    const p = makePlayer({ autoAdvance: true, floor: 0 })
    p.onProgress({ phase: 'engine', ratio: 0.5 }, 0)
    p.tick(10_000)
    // 走完 engine 和 assets 两段的视觉预算，看它能爬到哪
    p.tick(30_000)
    p.tick(60_000)
    const badShown = Math.max(0.6, p.shown)
    ok(Math.abs(badShown - 0.6) < 1e-9, '⭐ 旧行为：重试整轮都卡在 60%，一个像素不动')
  }

  // 新行为：floor = 保留下来的百分比，第二轮压进 [0.6, 1]
  const good = makePlayer({ autoAdvance: true, floor: 0.6 })
  ok(Math.abs(good.shown - 0.6) < 1e-9, '起点就是保留下来的 60%')
  good.onProgress({ phase: 'engine', ratio: 0.5 }, 0)
  ok(good.shown > 0.6, '⭐ 第二轮一有进度条子就往前走，不再冻住')
  good.tick(10_000)
  ok(good.shown > 0.63, '视觉计时器也走在 floor 之上')
  // 一路跑完仍然不越天花板、也不倒退
  let last = good.shown
  for (const [phase, ratio] of [['engine', 1], ['assets', 1], ['rom', 1]]) {
    good.onProgress({ phase, ratio }, 20_000)
    ok(good.shown >= last, `${phase} 之后只进不退`)
    last = good.shown
  }
  for (let t = 20_000; t <= 80_000; t += 5_000) good.tick(t)
  ok(good.shown <= CEILING + 1e-9, '仍然不超过 99% 的天花板')
  ok(good.shown > 0.9, '最终爬到 90% 以上')

  // floor 为 0 的全新一局不受影响
  const fresh = makePlayer({ autoAdvance: true })
  ok(fresh.shown === 0, '玩家主动开的新一局仍然从 0 开始')

  // liftRatio 的边界
  ok(liftRatio(0, 0.5) === 0.5, 'floor=0 时是恒等映射')
  ok(liftRatio(0.6, 0) === 0.6, 'floor 就是新一轮的 0')
  ok(liftRatio(0.6, 1) === 1, '新一轮的 1 仍然是 1')
}

console.log('\n── 速度文案 ──')
{
  ok(formatSpeed(0) === '', '0 不显示（调用方据此整格不画）')
  ok(formatSpeed(-5) === '', '负数不显示')
  ok(formatSpeed(NaN) === '', 'NaN 不显示')
  ok(formatSpeed(512) === '512 B/s', '1KB 以下给 B/s')
  ok(formatSpeed(102_400) === '100 KB/s', '100KB/s')
  ok(formatSpeed(1024 * 1024 * 2.5) === '2.5 MB/s', '1MB 以上给一位小数的 MB/s')
  ok(formatSpeed(1024 * 1023) === '1023 KB/s', '刚好不到 1MB 仍用 KB/s，慢网络下看得出在变')
}

console.log(`\n✅ 加载进度测试通过（${n} 项）`)

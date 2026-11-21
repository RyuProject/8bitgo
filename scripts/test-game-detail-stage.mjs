#!/usr/bin/env node
/**
 * 游戏详情页舞台比例的回归测试。跑：npm run test:game-detail-stage
 *
 * 2026-11-18 详情页改版时，`aspect-ratio: 3/1` 直接挂在 `[data-testid="emulator-stage"]` 上，
 * 而播放器一直带着 `game-detail-player-mode`，于是开局后舞台仍是 3:1：
 *   - 1440×900 桌面上红白机画面只剩约 504×378（16:9 时约 850×638），沉浸模式也被压扁；
 *   - 触屏的游玩布局是 `fixed inset-0`，套上 3:1 后变成 740×246 的一条，
 *     下面的页面露出来还能点（横屏手机 / 平板，宽度 ≥640 才命中那条媒体查询）。
 * 这些都不会报错，只是「画面变小」或「铺不满」，所以用源码形状钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

/** 把 CSS 拆成 { selectors, body }，媒体查询里的规则也展开（只做本文件够用的简单解析） */
function cssRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(src))) {
    const head = m[1].trim()
    if (head.startsWith('@')) continue
    rules.push({ selectors: head.replace(/^@media[^{]*$/, '').split(',').map((s) => s.trim()).filter(Boolean), body: m[2] })
  }
  return rules
}

console.log('游戏详情页舞台比例')

check('⚠️ 3:1 只作用于待机舞台，不碰运行中的舞台', () => {
  const rules = cssRules(read('src/components/game/game-detail.css'))
  const threeToOne = rules.filter((r) => /aspect-ratio:\s*3\s*\/\s*1/.test(r.body))
  assert.ok(threeToOne.length > 0, '找不到 3:1 规则（改名了的话同步这条测试）')
  for (const { selectors } of threeToOne) {
    for (const sel of selectors) {
      assert.ok(
        /game-detail-player-mode--standby/.test(sel) || /game-detail-stage-ratio/.test(sel),
        `「${sel}」不是待机专用的选择器 —— 开局后舞台会被压成 3:1`,
      )
      assert.match(sel, /:not\(\.game-detail-layout--session\)/, `「${sel}」没排除直播 / 联机布局`)
      assert.match(sel, /:not\(\.game-detail-layout--immersive\)/, `「${sel}」没排除沉浸模式（触屏的游玩布局是 fixed 铺满视口）`)
    }
  }
})

check('⚠️ 不许再有规则直接给 emulator-stage 定比例（除了待机那条）', () => {
  const rules = cssRules(read('src/components/game/game-detail.css'))
  for (const { selectors, body } of rules) {
    if (!/aspect-ratio/.test(body)) continue
    for (const sel of selectors) {
      if (!/emulator-stage/.test(sel)) continue
      assert.match(sel, /game-detail-player-mode--standby/, `「${sel}」会在开局后继续改舞台比例`)
    }
  }
})

check('⚠️ 播放器只在「还没开始、不在全屏 / 游玩布局」时挂 --standby', () => {
  const src = stripJs(read('src/emulator/EmulatorPlayer.tsx'))
  const def = src.match(/const pageStageCompact = ([^\n]+)/)
  assert.ok(def, '找不到 pageStageCompact')
  const cond = def[1]
  assert.match(cond, /pagePresentation/, '不是详情页也挂了待机类')
  assert.match(cond, /status === 'idle'/, '待机类没限定在 idle —— loading / running / error 时舞台还是 3:1')
  assert.match(cond, /!fullscreen/, '全屏时也挂了待机类')
  assert.match(cond, /!playMode/, '触屏游玩布局（fixed inset-0）时也挂了待机类')
  const uses = [...src.matchAll(/'game-detail-player-mode--standby'/g)]
  assert.equal(uses.length, 1, '--standby 类出现了不止一处')
  assert.match(src, /pageStageCompact && 'game-detail-player-mode--standby'/, '--standby 类没有走 pageStageCompact')
})

check('⚠️ 加载占位和待机舞台同一比例（不在 chunk 到达时跳一下）', () => {
  const src = stripJs(read('src/emulator/PlayerChunk.tsx'))
  assert.match(src, /pagePresentation && 'game-detail-stage-ratio'/, '加载占位没用 game-detail-stage-ratio')
  assert.doesNotMatch(src, /sm:aspect-\[(?!16\/9)[^\]]+\]/, '加载占位又写死了一个和待机舞台不同的比例')
})

if (failed) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过 ✅')

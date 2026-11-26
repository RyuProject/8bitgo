#!/usr/bin/env node
/**
 * 定时开局巡检（deploy/smoke-watch/8bitgo-smoke-watch.sh）的行为回归。跑：npm run test:smoke-watch
 *
 * 用一个假仓库跑真脚本：游戏与 SEO 巡检分别按预设状态返回，server/scripts/notify-lark.mjs
 * 把收到的参数记下来，flock 用桩（macOS 没有 flock；这里只测脚本自己的判断，不测内核加锁）。
 * 锁住：失败先复核再报警、复核通过不报、持续故障按 key 去重、恢复发一条并清去重、游戏与抓取入口状态独立、
 * 巡检跑不起来单独报、部署占着锁时跳过、Chrome 等子进程不继承部署锁。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'deploy/smoke-watch/8bitgo-smoke-watch.sh')
const source = readFileSync(script, 'utf8')

assert.equal(spawnSync('bash', ['-n', script]).status, 0, '脚本语法错误')
assert.match(source, /> "\$RUN_OUT" 2>&1 9>&-/, 'Chrome 等子进程不能继承部署锁')
assert.match(source, /LOCK_FILE="\$\{DEPLOY_LOCK_FILE:-\/run\/lock\/8bitgo-deploy\.lock\}"/, '与 redeploy.sh 共用同一把锁')
const redeploy = readFileSync(join(root, 'deploy/redeploy.sh'), 'utf8')
assert.match(redeploy, /DEPLOY_LOCK_FILE:-\/run\/lock\/8bitgo-deploy\.lock/, 'redeploy.sh 也要拿这把锁，否则巡检会在部署中途误报')
const unit = readFileSync(join(root, 'deploy/smoke-watch/8bitgo-smoke-watch.service'), 'utf8')
assert.match(unit, /ExecStart=\/var\/www\/8bitgo\/deploy\/smoke-watch\/8bitgo-smoke-watch\.sh/)
assert.match(readFileSync(join(root, 'deploy/smoke-watch/8bitgo-smoke-watch.timer'), 'utf8'), /OnUnitActiveSec=15min/)

// 看门狗（deploy/watchdog/8bitgo-watchdog.sh）的告警接线：每分钟跑一次，必须去重、--dry-run / --status 不发
{
  const watchdogPath = join(root, 'deploy/watchdog/8bitgo-watchdog.sh')
  assert.equal(spawnSync('bash', ['-n', watchdogPath]).status, 0, '看门狗脚本语法错误')
  const wd = readFileSync(watchdogPath, 'utf8')
  assert.match(wd, /NOTIFY_SCRIPT="\$\{NOTIFY_SCRIPT:-\/var\/www\/8bitgo\/server\/scripts\/notify-lark\.mjs\}"/)
  const fn = wd.slice(wd.indexOf('notify() {'), wd.indexOf('\n}\n', wd.indexOf('notify() {')))
  assert.match(fn, /\[ "\$DRY_RUN" = 1 \] && return 0/, '--dry-run / --status 不能发告警')
  assert.match(fn, /--dedupe "watchdog-\$1" --cooldown "\$2"/, '看门狗每分钟一跑，告警必须去重')
  assert.match(fn, /\|\| true/, '告警失败不能让看门狗失败')
  assert.ok(wd.indexOf('notify() {') > wd.indexOf('log() {'), 'notify 用到 log，要定义在它之后')
  for (const key of ['backend-recovered', 'backend-down', 'front-recovered', 'front-down', 'front-nginx-t', '$layer-maxed']) {
    assert.ok(wd.includes(`notify ${key.startsWith('$') ? '"' + key + '"' : key} `), `看门狗缺少告警：${key}`)
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-watch-'))
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  for (const d of [join(repo, 'scripts'), join(repo, 'server/scripts'), bin, join(dir, 'state')]) mkdirSync(d, { recursive: true })
  // 假冒烟：每次调用从序列文件里取下一个退出码
  writeFileSync(join(repo, 'scripts/smoke-start.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs'
    const f = ${JSON.stringify(join(dir, 'seq'))}
    const seq = readFileSync(f, 'utf8').trim().split(',')
    const code = Number(seq.shift() ?? 0)
    writeFileSync(f, seq.join(','))
    console.log(code === 0 ? '✔ super-mario-bros：first_frame（10 秒）' : '✖ super-mario-bros：failed（3 秒）')
    if (code === 1) console.log('    EmulatorJS 引擎加载失败')
    process.exit(code)
  `)
  writeFileSync(join(repo, 'scripts/smoke-seo-crawl.mjs'), `
    import { appendFileSync } from 'node:fs'
    appendFileSync(${JSON.stringify(join(dir, 'seo-runs'))}, 'run\\n')
    console.log(Number(process.env.FAKE_SEO_SMOKE_RC ?? 0) === 0 ? '✔ robots.txt / sitemap' : '✖ sitemap HTTP 500')
    process.exit(Number(process.env.FAKE_SEO_SMOKE_RC ?? 0))
  `)
  // 假通知：记下参数；--dedupe 冷却与 --clear 按真脚本的语义模拟
  writeFileSync(join(repo, 'server/scripts/notify-lark.mjs'), `
    import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
    const a = process.argv.slice(2)
    const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : '' }
    const state = ${JSON.stringify(join(dir, 'state'))}
    if (opt('--clear')) { rmSync(state + '/' + opt('--clear'), { force: true }); appendFileSync(${JSON.stringify(join(dir, 'notify.log'))}, JSON.stringify({ clear: opt('--clear') }) + '\\n'); process.exit(0) }
    const key = opt('--dedupe')
    if (key && existsSync(state + '/' + key)) process.exit(0)
    if (key) writeFileSync(state + '/' + key, '1')
    appendFileSync(${JSON.stringify(join(dir, 'notify.log'))}, JSON.stringify({ title: opt('--title'), text: opt('--text'), key }) + '\\n')
  `)
  const flock = join(bin, 'flock')
  writeFileSync(flock, '#!/usr/bin/env bash\n[ "${FAKE_LOCK_BUSY:-0}" = "1" ] && exit 1\nexit 0\n')
  chmodSync(flock, 0o755)
  const run = (seq, extra = {}) => {
    writeFileSync(join(dir, 'seq'), seq)
    const r = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO_DIR: repo,
        SMOKE_WATCH_STATE_DIR: join(dir, 'watch'),
        SMOKE_WATCH_LOG: join(dir, 'watch.log'),
        DEPLOY_LOCK_FILE: join(dir, 'deploy.lock'),
        SMOKE_WATCH_RECHECK_SEC: '0',
        ...extra,
      },
    })
    assert.equal(r.status, 0, r.stderr)
    let notes = []
    try { notes = readFileSync(join(dir, 'notify.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { notes = [] }
    rmSync(join(dir, 'notify.log'), { force: true })
    const status = (() => { try { return readFileSync(join(dir, 'watch/status'), 'utf8').trim() } catch { return '' } })()
    const seoStatus = (() => { try { return readFileSync(join(dir, 'watch/seo-status'), 'utf8').trim() } catch { return '' } })()
    const seoRuns = (() => { try { return readFileSync(join(dir, 'seo-runs'), 'utf8').trim().split('\n').length } catch { return 0 } })()
    return { notes, status, seoStatus, seoRuns, left: readFileSync(join(dir, 'seq'), 'utf8') }
  }
  return { dir, run }
}

const { dir, run } = setup()
try {
  // 一切正常：不发任何消息
  let r = run('0')
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.notes, [])

  // 第一次失败、复核通过：瞬时抖动，不报
  r = run('1,0')
  assert.equal(r.left, '', '失败后要复核一次')
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.notes, [], '复核通过不能报警')

  // 两次都失败：报警，带上失败详情
  r = run('1,1')
  assert.equal(r.status, 'down')
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0].title, /开局巡检失败/)
  assert.equal(r.notes[0].key, 'smoke-down')
  assert.match(r.notes[0].text, /✖ super-mario-bros/)
  assert.match(r.notes[0].text, /EmulatorJS 引擎加载失败/)
  assert.match(r.notes[0].text, /admin\/diagnostics/)

  // 故障持续：按 key 去重，不刷屏
  r = run('1,1')
  assert.deepEqual(r.notes, [], '冷却期内不重复报')

  // 恢复：发一条已恢复，并清掉去重 key（下次故障立刻报）
  r = run('0')
  assert.equal(r.status, 'ok')
  assert.equal(r.notes.length, 2)
  assert.match(r.notes[0].title, /已恢复/)
  assert.deepEqual(r.notes[1], { clear: 'smoke-down' })
  r = run('0')
  assert.deepEqual(r.notes, [], '持续正常不再发恢复')

  // 巡检自己跑不起来（没有 Chrome）：单独报，不改 ok/down 状态
  r = run('2')
  assert.equal(r.status, 'ok')
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0].title, /没能运行/)
  assert.equal(r.notes[0].key, 'smoke-env')

  // SEO 抓取入口有独立状态，玩家开局通过不能掩盖 sitemap 故障
  r = run('0', { FAKE_SEO_SMOKE_RC: '1' })
  assert.equal(r.status, 'ok', 'SEO 入口故障不能污染游戏开局状态')
  assert.equal(r.seoStatus, 'down')
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0].title, /搜索抓取入口异常/)
  assert.equal(r.notes[0].key, 'seo-crawl-down')
  r = run('0', { FAKE_SEO_SMOKE_RC: '1' })
  assert.deepEqual(r.notes, [], '持续 sitemap 故障按独立 key 去重')
  r = run('0')
  assert.equal(r.seoStatus, 'ok')
  assert.equal(r.notes.length, 2)
  assert.match(r.notes[0].title, /搜索抓取入口正常/)
  assert.deepEqual(r.notes[1], { clear: 'seo-crawl-down' })

  // 部署占着锁：这一轮直接跳过，冒烟一次都不跑
  r = run('1,1', { FAKE_LOCK_BUSY: '1' })
  assert.equal(r.left, '1,1', '部署中不能跑冒烟')
  assert.equal(r.seoRuns, 10, '部署中不能跑 SEO 抓取检查')
  assert.deepEqual(r.notes, [])
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('✔ 开局与 SEO 抓取巡检：两类状态独立、持续故障去重、恢复通知并清去重、部署中跳过；看门狗告警接线')

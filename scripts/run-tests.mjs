/**
 * 一次把所有测试跑完，最后给一张汇总表。`npm test` 就是它。
 *
 * ── 为什么要有这个 ──────────────────────────────────────────
 * 这个仓库有 **90 多套**测试，而在此之前只有 `test:ejs-cores` 一套挂在 `prebuild` 上，
 * 没有 CI、没有 `npm test` —— 其余全部只有人**手动敲名字**才会跑。
 *
 * 后果在 2026-09-11 兑现了：`test:indexnow` 从 09-08 加语言门控那天起就一直是红的
 * （fixture 漏改，被门控正确地滤成了空 sitemap），**三天没人发现**。而它的 check()
 * 第一条炸了就整个退出，28 条里只跑到第 6 条，后面 22 条一条都没执行；
 * 另有 3 条变成了「空 sitemap 上自动成立」的假绿。
 *
 * 红了不要紧，**红了没人知道**才要命。这个文件解决的就是后者。
 *
 * 用法：
 *   npm test                  跑全部（跳过要外部服务的那几套）
 *   npm test -- --jobs 1      串行（排查互相干扰时用）
 *   npm test -- --only live   只跑名字里带 live 的
 *   npm test -- --all         连要数据库 / SMTP 的也跑
 *   npm test -- --list        只列出要跑哪些，不真跑
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 要真实外部服务才能跑的，默认跳过（--all 可以强跑） */
const NEEDS_SERVICE = {
  'server:test:db': '要连上数据库（本机是 SSH 隧道）',
  'server:test:search:db': '同上',
  'server:test:mail': '要真实 SMTP / Resend 凭据',
}

/** 是别的套件的聚合，跑了等于重复 */
const AGGREGATES = new Set(['server:test:netplay:all'])

/**
 * 绑**固定端口**的套件，必须串行。
 * ⚠️ test-host-failover 和 test-spectator 都绑 9931 —— 并行会互相撞死，
 * 而症状是随机的连接错误，查起来极费劲。新增固定端口的测试记得加进来。
 */
const SERIAL = new Set([
  'server:test:netplay', // 9921
  'server:test:host-failover', // 9931
  'server:test:spectator', // 9931 —— 和上面同一个端口
  'server:test:saves', // 9941
  'server:test:netplay:failover',
  'server:test:netplay:spectator',
])

/** 只在特定平台能跑的 */
const PLATFORM_ONLY = {
  'test:roms': {
    ok: () => process.platform === 'darwin',
    why: '要 esbuild 的原生二进制，而 node_modules 是 macOS 装的（Linux 侧跑不了）',
  },
}

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] ?? String(fallback)) : String(fallback)
}
const has = (name) => args.includes(`--${name}`)

const jobs = Math.max(1, Number(flag('jobs', 4)) || 4)
const only = args.includes('--only') ? flag('only', '') : ''
const timeoutMs = Math.max(5000, Number(flag('timeout', 120000)) || 120000)

const scriptsOf = (pkg) => Object.keys(JSON.parse(readFileSync(join(root, pkg), 'utf8')).scripts ?? {})

/** 全部候选：前端的 test:*，加上服务端的（带 server: 前缀区分） */
const all = [
  ...scriptsOf('package.json')
    .filter((k) => k.startsWith('test:'))
    .map((k) => ({ id: k, script: k, cwd: root, label: k })),
  ...scriptsOf('server/package.json')
    .filter((k) => k.startsWith('test:'))
    .map((k) => ({ id: `server:${k}`, script: k, cwd: join(root, 'server'), label: `server ${k}` })),
]

const skipped = []
const queue = []
for (const t of all) {
  if (AGGREGATES.has(t.id)) {
    skipped.push({ ...t, why: '是别的套件的聚合' })
    continue
  }
  if (!has('all') && NEEDS_SERVICE[t.id]) {
    skipped.push({ ...t, why: NEEDS_SERVICE[t.id] })
    continue
  }
  const p = PLATFORM_ONLY[t.id]
  if (p && !p.ok()) {
    skipped.push({ ...t, why: p.why })
    continue
  }
  if (only && !t.id.includes(only)) continue
  queue.push(t)
}

if (has('list')) {
  for (const t of queue) console.log(`${SERIAL.has(t.id) ? '串行' : '并行'}  ${t.label}`)
  for (const t of skipped) console.log(`跳过  ${t.label}  —— ${t.why}`)
  process.exit(0)
}

const run = (t) =>
  new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('npm', ['run', '--silent', t.script], {
      cwd: t.cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const killer = setTimeout(() => {
      out += `\n[run-tests] 超过 ${Math.round(timeoutMs / 1000)}s，强制结束`
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({ ...t, code, ms: Date.now() - started, out })
    })
  })

/** 并行跑一批，最多 n 个同时在跑 */
async function pool(items, n) {
  const results = []
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const idx = i++
        if (idx >= items.length) return
        const r = await run(items[idx])
        results.push(r)
        process.stdout.write(r.code === 0 ? '.' : 'F')
      }
    }),
  )
  return results
}

const parallel = queue.filter((t) => !SERIAL.has(t.id))
const serial = queue.filter((t) => SERIAL.has(t.id))

console.log(`跑 ${queue.length} 套（并行 ${parallel.length} / 串行 ${serial.length}，并发 ${jobs}），跳过 ${skipped.length} 套\n`)
const t0 = Date.now()
const results = [...(await pool(parallel, jobs)), ...(await pool(serial, 1))]
process.stdout.write('\n\n')

const failed = results.filter((r) => r.code !== 0).sort((a, b) => a.label.localeCompare(b.label))
const passed = results.length - failed.length

for (const r of failed) {
  console.log(`❌ ${r.label}`)
  // 只摘要：整段输出太长，想看全的自己单跑那一套
  const lines = r.out.split('\n').filter((l) => l.trim() && !l.startsWith('npm error'))
  const gist = lines.filter((l) => /AssertionError|Error:|❌|✖|not match|expected/i.test(l)).slice(0, 3)
  for (const l of (gist.length ? gist : lines.slice(-3))) console.log(`     ${l.trim().slice(0, 150)}`)
  console.log(`     ↳ 单跑看全文：npm run ${r.script}${r.cwd === root ? '' : '（在 server/ 下）'}`)
}

if (skipped.length) {
  console.log(`\n跳过 ${skipped.length} 套：`)
  for (const t of skipped) console.log(`   ${t.label} —— ${t.why}`)
}

const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3)
console.log(`\n最慢：${slow.map((r) => `${r.label} ${(r.ms / 1000).toFixed(1)}s`).join('  ')}`)
console.log(
  `\n${failed.length ? '❌' : '✅'} ${passed}/${results.length} 通过，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`,
)
process.exit(failed.length ? 1 : 0)

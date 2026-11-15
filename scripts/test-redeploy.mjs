/**
 * deploy/redeploy.sh 的「lock 未变就跳过 npm ci」（2026-11-15 系统优化）。跑：npm run test:redeploy
 *
 * 用一个假的 npm（只记调用次数、按需失败）在临时目录里真跑 deploy/lib/npm-ci-if-changed.sh，
 * 守住：第一次装、lock 未变跳过、lock 变了重装、node_modules 没了重装、FORCE_NPM_CI 重装、
 * 安装失败不留戳。另外 bash -n 检查 redeploy.sh 语法，并确认它在步骤 3 之前载入了这份判据。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'deploy/lib/npm-ci-if-changed.sh')
const redeploy = join(root, 'deploy/redeploy.sh')

const syntax = spawnSync('bash', ['-n', redeploy], { encoding: 'utf8' })
assert.equal(syntax.status, 0, `redeploy.sh 语法错误：${syntax.stderr}`)
const source = readFileSync(redeploy, 'utf8')
const sourcedAt = source.indexOf('lib/npm-ci-if-changed.sh')
const step3 = source.indexOf('npm_ci_if_changed "$REPO_DIR"')
assert.ok(sourcedAt > 0 && step3 > sourcedAt, 'redeploy.sh 必须先载入判据再调用 npm_ci_if_changed')
assert.ok(source.indexOf('npm_ci_if_changed "$SERVER_DIR"') > step3, 'server 目录也走同一判据')
assert.doesNotMatch(source, /\(\s*cd "\$REPO_DIR"\s*&&\s*npm ci\s*\)/, '不再无条件 npm ci')

// 备份拆两半（2026-11-15 #5）：本地 dump 同步、失败中止；R2 上传转后台，退出前一定等它
const step1 = source.indexOf('步骤 1/7')
const step2 = source.indexOf('步骤 2/7')
assert.ok(step1 > 0 && step2 > step1)
assert.match(source, /"\$BACKUP_SCRIPT" --local-only\)" \|\| die/, '本地备份失败必须中止部署')
assert.match(source, /"\$BACKUP_SCRIPT" --upload-file "\$BACKUP_FILE" [^\n]*&\n/, 'R2 上传在后台跑')
assert.match(source, /trap finish_backup_upload EXIT/, '任何退出路径都要等后台上传，否则 systemd 会把它杀掉')
assert.ok(source.indexOf('trap finish_backup_upload EXIT') < source.indexOf('--upload-file'), 'trap 要在启动后台上传之前装好')
assert.match(source, /BACKUP_ASYNC_UPLOAD:-1/, '保留退回同步上传的开关')
assert.ok(source.indexOf('--local-only') < step2, '本地备份必须在拉代码之前完成')

const tmp = mkdtempSync(join(tmpdir(), '8bitgo-redeploy-'))
try {
  const bin = join(tmp, 'bin')
  const app = join(tmp, 'app')
  const log = join(tmp, 'npm-calls.log')
  mkdirSync(bin)
  mkdirSync(app)
  // 假 npm：记一笔调用；FAKE_NPM_FAIL=1 时先建出 node_modules 再失败（模拟半装失败）
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash
echo "$PWD $*" >> "${log}"
mkdir -p node_modules
[ "\${FAKE_NPM_FAIL:-0}" = "1" ] && exit 3
exit 0
`)
  chmodSync(join(bin, 'npm'), 0o755)

  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0)
  const run = (env = {}) => spawnSync('bash', ['-c', `. "${lib}"; npm_ci_if_changed "${app}"`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FORCE_NPM_CI: '0', FAKE_NPM_FAIL: '0', ...env },
  })

  writeFileSync(join(app, 'package-lock.json'), '{"lockfileVersion":3,"v":1}\n')
  let r = run()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(calls(), 1, '第一次必须装')
  assert.ok(existsSync(join(app, 'node_modules/.8bitgo-lock-sha256')), '装成功后写戳')

  r = run()
  assert.equal(r.status, 0)
  assert.equal(calls(), 1, 'lock 未变应跳过')
  assert.match(r.stdout, /跳过/)

  writeFileSync(join(app, 'package-lock.json'), '{"lockfileVersion":3,"v":2}\n')
  run()
  assert.equal(calls(), 2, 'lock 变了要重装')

  run({ FORCE_NPM_CI: '1' })
  assert.equal(calls(), 3, 'FORCE_NPM_CI=1 一律重装')

  rmSync(join(app, 'node_modules'), { recursive: true, force: true })
  run()
  assert.equal(calls(), 4, 'node_modules 没了（戳跟着没了）要重装')

  // 安装失败：返回非零，且不能留下「看起来装好了」的戳
  writeFileSync(join(app, 'package-lock.json'), '{"lockfileVersion":3,"v":3}\n')
  rmSync(join(app, 'node_modules'), { recursive: true, force: true })
  r = run({ FAKE_NPM_FAIL: '1' })
  assert.notEqual(r.status, 0, '安装失败要报错')
  assert.ok(!existsSync(join(app, 'node_modules/.8bitgo-lock-sha256')), '失败的安装不写戳')
  run()
  assert.equal(calls(), 6, '失败之后下一次照样重装')

  // 没有 lock 文件：照常 npm ci（让 npm 自己报错），也不写戳
  rmSync(join(app, 'package-lock.json'))
  rmSync(join(app, 'node_modules'), { recursive: true, force: true })
  run()
  assert.equal(calls(), 7)
  assert.ok(!existsSync(join(app, 'node_modules/.8bitgo-lock-sha256')))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('✔ redeploy：lock 未变跳过 npm ci，变了 / 强制 / 失败后都重装')

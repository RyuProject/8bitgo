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
const buildLib = join(root, 'deploy/lib/build-with-diagnostics.sh')
const redeploy = join(root, 'deploy/redeploy.sh')

const syntax = spawnSync('bash', ['-n', redeploy], { encoding: 'utf8' })
assert.equal(syntax.status, 0, `redeploy.sh 语法错误：${syntax.stderr}`)
const source = readFileSync(redeploy, 'utf8')
const sourcedAt = source.indexOf('lib/npm-ci-if-changed.sh')
const step3 = source.indexOf('npm_ci_if_changed "$REPO_DIR"')
assert.ok(sourcedAt > 0 && step3 > sourcedAt, 'redeploy.sh 必须先载入判据再调用 npm_ci_if_changed')
assert.ok(source.indexOf('npm_ci_if_changed "$SERVER_DIR"') > step3, 'server 目录也走同一判据')
assert.doesNotMatch(source, /\(\s*cd "\$REPO_DIR"\s*&&\s*npm ci\s*\)/, '不再无条件 npm ci')
assert.match(source, /lib\/build-with-diagnostics\.sh/, '发布脚本必须载入构建失败诊断助手')
assert.match(source, /build_with_diagnostics "\$REPO_DIR" "\$LOG" "\$LOG_DIR"/, '新版本和回滚构建都必须记录诊断输出')

// 备份拆两半（2026-11-15 #5）：本地 dump 同步、失败中止；R2 上传转后台，退出前一定等它
const step1 = source.indexOf('步骤 1/7')
const step2 = source.indexOf('步骤 2/7')
assert.ok(step1 > 0 && step2 > step1)
assert.match(source, /"\$BACKUP_SCRIPT" --local-only\)" \|\| BACKUP_STATUS=\$\?/, '首份本地备份必须先同步完成')
assert.match(source, /\[ "\$BACKUP_STATUS" -eq 42 \]/, '只有体量骤降的专用退出码才允许独立复验')
assert.match(source, /"\$BACKUP_SCRIPT" --local-only --confirm-size-drop/, '复验必须重新导出完整快照，不能直接放行第一次异常文件')
assert.match(source, /\[ "\$BACKUP_STATUS" -eq 0 \] \|\| die "备份失败，整个流程中止/, '复验失败或其它备份错误仍必须中止部署')
assert.match(source, /"\$BACKUP_SCRIPT" --upload-file "\$BACKUP_FILE" [^\n]*&\n/, 'R2 上传在后台跑')
assert.match(source, /trap finish_backup_upload EXIT/, '任何退出路径都要等后台上传，否则 systemd 会把它杀掉')
assert.ok(source.indexOf('trap finish_backup_upload EXIT') < source.indexOf('--upload-file'), 'trap 要在启动后台上传之前装好')
assert.match(source, /BACKUP_ASYNC_UPLOAD:-1/, '保留退回同步上传的开关')
assert.ok(source.indexOf('--local-only') < step2, '本地备份必须在拉代码之前完成')

// 2026-11-17 全站 EmulatorJS 事故后的部署加固
assert.match(source, /BRANCH="\$\{BRANCH:-\$\(git -C "\$REPO_DIR" symbolic-ref --short -q HEAD/, '分支名不能取 abbrev-ref：游离 HEAD 时会得到字面量 HEAD')
{
  const rollbackFn = source.slice(source.indexOf('rollback() {'), source.indexOf('# ───────────── 记录起点'))
  assert.match(rollbackFn, /git reset --hard --quiet "\$BEFORE_COMMIT"/, '回滚要留在分支上（reset），不能 checkout 成游离 HEAD')
  assert.doesNotMatch(rollbackFn, /git checkout --quiet "\$BEFORE_COMMIT"/)
}
{
  const step5 = source.slice(source.indexOf('步骤 5/7'), source.indexOf('步骤 6/7'))
  assert.match(step5, /BUILD_MARK="\$\(mktemp\)"/, '构建前打时间戳')
  assert.match(step5, /find "\$REPO_DIR\/dist" -type f -newer "\$BUILD_MARK"/, '构建失败时要看 dist 是否已被部分改写')
  assert.match(step5, /rollback\n\s*exit 1/, 'dist 已被改写的构建失败必须回滚，不能只 die（线上正在发半新文件）')
}
{
  const smoke = source.slice(source.indexOf('# 开局冒烟：'), source.indexOf('log "✅ 部署完成'))
  assert.match(smoke, /SMOKE_TEST:-1/, '开局冒烟默认打开')
  assert.match(smoke, /smoke_once; SMOKE_RC=\$\?\n\s*if \[ "\$SMOKE_RC" = "1" \]; then[\s\S]*?smoke_once; SMOKE_RC=\$\?/, '失败先重试一次')
  assert.match(smoke, /SMOKE_ROLLBACK:-1[\s\S]*?rollback\n\s*exit 1/, '两次失败默认回滚')
  assert.match(smoke, /2\)\n\s*log "⚠️⚠️ 开局冒烟没有运行[^\n]*\n\s*notify "⚠️ 部署完成，但开局冒烟没能运行"/, '没有 Chrome 时必须响亮地告警（日志 + 飞书），而不是悄悄跳过')
  assert.ok(source.indexOf('# 开局冒烟：') > source.indexOf('health_ok && ps2_headers_ok'), '冒烟在重启 + 健康检查之后')
}
{
  // 2026-11-18：故障要能主动通知到人（飞书），部署与定时巡检互斥
  assert.match(source, /notify\(\) \{[\s\S]*?notify-lark\.mjs[\s\S]*?\|\| true\n\}/, '通知失败绝不能让部署脚本失败')
  assert.match(source, /die\(\)  \{ log "❌ \$\*"; notify "❌ 部署中止"/, '部署中止要通知')
  const rollbackFn = source.slice(source.indexOf('rollback() {'), source.indexOf('# ───────────── 记录起点'))
  for (const title of ['⚠️ 部署失败，已自动回滚', '🔴 回滚后线上仍不健康', '🔴 回滚失败，需人工介入']) {
    assert.ok(rollbackFn.includes(title), `回滚结局「${title}」要通知`)
  }
  for (const reason of ['构建失败，且线上 dist 已被部分改写', '开局冒烟两次失败', '重启后健康检查或 PS2 隔离响应头未通过']) {
    assert.ok(source.includes(`ROLLBACK_REASON="${reason}`), `回滚原因要带进通知：${reason}`)
  }
  assert.match(source, /flock -w 900 8 \|\| die/, '部署要拿部署锁（等定时巡检跑完）')
  assert.ok(source.indexOf('flock -w 900 8') < source.indexOf('步骤 1/7'), '拿锁要在任何改动之前')
  assert.match(source, /smoke-start\.mjs[^\n]*\) 2>&1 8>&- \|/, '冒烟的 Chrome 不能继承部署锁')
}

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

  // 回滚构建曾只留下通用告警；失败输出必须持久化并附到主发布日志。
  const buildBin = join(tmp, 'build-bin')
  const buildApp = join(tmp, 'build-app')
  const deployLog = join(tmp, 'deploy.log')
  mkdirSync(buildBin)
  mkdirSync(buildApp)
  const fakeNpm = join(buildBin, 'npm')
  writeFileSync(fakeNpm, `#!/usr/bin/env bash
printf '%s\\n' "FAKE_BUILD_DIAGNOSTIC_LINE"
exit "\${FAKE_BUILD_EXIT:-0}"
`)
  chmodSync(fakeNpm, 0o755)

  const runBuild = (exitCode) => spawnSync('bash', ['-c', `
    . "$1"
    build_with_diagnostics "$2" "$3" "$4"
    build_rc=$?
    printf '__BUILD_RC__=%s\\n__BUILD_FAILURE_LOG__=%s\\n' "$build_rc" "$BUILD_FAILURE_LOG"
  `, 'test', buildLib, buildApp, deployLog, tmp], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${buildBin}:${process.env.PATH}`, FAKE_BUILD_EXIT: String(exitCode) },
  })

  r = runBuild(17)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /__BUILD_RC__=17/)
  const failureLog = r.stdout.match(/__BUILD_FAILURE_LOG__=(.+)/)?.[1]
  assert.ok(failureLog && existsSync(failureLog), '失败构建必须留下完整日志文件')
  assert.match(readFileSync(failureLog, 'utf8'), /FAKE_BUILD_DIAGNOSTIC_LINE/)
  assert.match(readFileSync(deployLog, 'utf8'), /完整输出：/, '发布总日志必须给出失败输出文件路径')
  assert.match(readFileSync(deployLog, 'utf8'), /FAKE_BUILD_DIAGNOSTIC_LINE/, '发布总日志必须包含错误尾部')

  r = runBuild(0)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /__BUILD_RC__=0/)
  assert.match(r.stdout, /__BUILD_FAILURE_LOG__=\s*$/m, '成功构建不应残留失败日志路径')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log('✔ redeploy：依赖安装判据与失败构建诊断均通过')

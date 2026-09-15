/**
 * `deploy/backup/8bitgo-backup.sh` 的自检。**不碰真数据库、不碰真 R2** ——
 * 用桩程序（假的 mysqldump / rclone）放在 PATH 最前面，逼出各种失败路径。
 *
 * ## 为什么要测一个备份脚本
 *
 * 备份脚本最贵的 bug 不是「跑不起来」，而是**「失败了却退出码 0」**：
 * 你会得到一个看起来正常的 .gz，它还会把昨天那份好的挤掉，
 * 而你要到真的需要恢复的那天才发现。那时候已经晚了。
 *
 * 所以这里每一条都在问同一个问题：**这种情况下它敢不敢说自己成功了。**
 *
 * 用法：cd server && npm run test:backup
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../deploy/backup/8bitgo-backup.sh', import.meta.url))

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${name}\n     ${e.message}`)
  }
}

/**
 * 造一套隔离环境：假的 mysqldump / rclone / 一份 .env / 空的备份目录。
 * @param {object} o
 * @param {string} o.dump      假 mysqldump 的 shell 主体（往 stdout 写 dump）
 * @param {boolean} [o.rclone] 要不要提供 rclone 桩
 * @param {string} [o.rcloneSize] rclone size 回报的字节数（不给就回真实大小）
 */
function env({ dump, rclone = true, rcloneSize = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'))
  const bin = join(dir, 'bin')
  const backups = join(dir, 'backups')
  const remote = join(dir, 'remote')
  const tmp = join(dir, 'tmp')
  mkdirSync(bin), mkdirSync(backups), mkdirSync(remote), mkdirSync(tmp)

  writeFileSync(join(dir, '.env'), [
    'DB_HOST=127.0.0.1', 'DB_PORT=3306', 'DB_USER=tester',
    "DB_PASSWORD='pw'", 'DB_NAME=testdb', 'JWT_SECRET=x',
  ].join('\n') + '\n')

  const stub = (name, body) => {
    const p = join(bin, name)
    writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(p, 0o755)
  }
  stub('mysqldump', dump)
  if (rclone) {
    // copy -> 复制到 remote 目录；size -> 回 JSON；delete -> 忽略
    stub('rclone', `
case "$1" in
  copy)  cp "$2" "${remote}/" ;;
  size)  f="${remote}/$(basename "\${2}")"
         n=${rcloneSize === null ? '"$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0)"' : `"${rcloneSize}"`}
         echo "{\\"count\\":1,\\"bytes\\":$n}" ;;
  delete) : ;;
esac
exit 0`)
  }
  return { dir, bin, backups, remote, tmp, envFile: join(dir, '.env') }
}

function run(e, args = []) {
  /*
    ⚠️ 用 spawnSync 而不是 execFileSync：脚本的 log() 全写在 **stderr**
    （`tee -a "$LOG" >&2`），而 execFileSync **成功时只返回 stdout** ——
    于是所有断言拿到的都是空串，「没找到这段话」会被当成脚本的问题，
    而真相是测试根本没看见输出。第一版就是这么误报了 4 条。
  */
  const r = spawnSync('bash', [SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: `${e.bin}:${process.env.PATH}`,
      ENV_FILE: e.envFile,
      BACKUP_DIR: e.backups,
      LOG: join(e.dir, 'log'),
      R2_REMOTE: 'r2', R2_BUCKET: 'b', R2_PREFIX: 'p',
      // ⚠️ 固定 TMPDIR：mktemp 用的是它，不是写死的 /tmp。
      //    第一版没设，于是「口令临时文件有没有清掉」那条扫的是 /tmp、
      //    而文件建在了别处 —— 永远扫不到东西，断言恒真。
      TMPDIR: e.tmp,
    },
    encoding: 'utf8',
  })
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` }
}

const kept = (e) => readdirSync(e.backups).filter((f) => f.endsWith('.sql.gz'))
const partials = (e) => readdirSync(e.backups).filter((f) => f.endsWith('.partial'))

/**
 * 一份「正常」的 dump：mysqldump 成功时末尾一定有这一行。
 *
 * ⚠️ 内容要**不可压缩**（这里用 /dev/urandom 的 base64）。
 * 第一版用的是 200 行同样的 CREATE TABLE，gzip 压到几十字节 ——
 * 于是「新备份不到上一份一半」那条永远触发不了，测试误报成脚本的 bug。
 */
const GOOD_DUMP = `head -c 20000 /dev/urandom | base64; echo "-- Dump completed on $(date)"`
/** 体量骤降的那一份：合法、但内容少得多 */
const TINY_DUMP = `head -c 200 /dev/urandom | base64; echo "-- Dump completed"`

console.log('\n备份脚本：失败的时候敢不敢说自己失败')

check('正常情况：本地留一份、上传一份、退出 0', () => {
  const e = env({ dump: GOOD_DUMP })
  const r = run(e)
  assert.equal(r.code, 0, r.out)
  assert.equal(kept(e).length, 1, '本地没留下备份')
  assert.equal(readdirSync(e.remote).length, 1, '没上传到 R2')
  assert.match(r.out, /已上传/)
})

check('⚠️⚠️ mysqldump 失败（权限不够）-> 必须非 0，且绝不留下半截文件', () => {
  /*
    这是 pipefail 那一条守的东西。`mysqldump | gzip > f` 的退出码默认是 gzip 的，
    而 gzip 对着空输入照样成功 —— 没有 pipefail 就会「成功」产出一个空备份。
  */
  const e = env({ dump: `echo "mysqldump: Access denied; you need the PROCESS privilege" >&2; exit 2` })
  const r = run(e)
  assert.notEqual(r.code, 0, `失败的 dump 却退出 0：\n${r.out}`)
  assert.deepEqual(kept(e), [], '失败却留下了一份备份文件')
  assert.deepEqual(partials(e), [], '留下了 .partial 垃圾')
})

check('⚠️ dump 中途断掉（没有 Dump completed）-> 拒绝，不上传', () => {
  // 连接掉 / 磁盘满的形状：内容有，但没写完。gz 本身是好的，骗得过 gzip -t
  const e = env({ dump: `printf 'CREATE TABLE a (id int);\\n%.0s' {1..200}` })
  const r = run(e)
  assert.notEqual(r.code, 0, '截断的 dump 被当成了成功')
  assert.match(r.out, /Dump completed/, '没说清为什么拒绝')
  assert.equal(readdirSync(e.remote).length, 0, '把截断的备份传上去了')
  assert.deepEqual(kept(e), [], '截断的备份被留下了')
})

check('⚠️ 新备份比上一份小一半以上 -> 拒绝轮转（多半是连错了空库）', () => {
  const e = env({ dump: GOOD_DUMP })
  assert.equal(run(e).code, 0)
  // 第二次只吐一点点内容，但格式完全合法
  writeFileSync(join(e.bin, 'mysqldump'), `#!/usr/bin/env bash\n${TINY_DUMP}\n`)
  chmodSync(join(e.bin, 'mysqldump'), 0o755)
  const r = run(e)
  assert.notEqual(r.code, 0, '体量骤降却照常轮转了')
  assert.match(r.out, /不到上一份/)
  assert.equal(kept(e).length, 1, '旧的那份好备份被挤掉了')
})

check('同一秒重试也保留两份已验过的备份，不覆盖旧文件', () => {
  const e = env({ dump: GOOD_DUMP })
  const fakeDate = join(e.bin, 'date')
  writeFileSync(fakeDate, '#!/usr/bin/env bash\nif [ "$1" = "+%Y%m%d-%H%M%S" ]; then echo 20260915-000000; else /bin/date "$@"; fi\n')
  chmodSync(fakeDate, 0o755)
  assert.equal(run(e).code, 0)
  const first = kept(e)[0]
  const original = readFileSync(join(e.backups, first))
  assert.equal(run(e).code, 0)
  assert.equal(kept(e).length, 2, '同秒的新备份覆盖了第一份')
  assert.deepEqual(readFileSync(join(e.backups, first)), original, '第一份的内容被改写了')
  assert.equal(readdirSync(e.remote).length, 2, 'R2 上的同秒备份也被覆盖了')
})

check('⚠️⚠️ 上传后大小对不上 -> 报错（「以为传上去了」是最贵的错）', () => {
  const e = env({ dump: GOOD_DUMP, rcloneSize: '11' })
  const r = run(e)
  assert.notEqual(r.code, 0, 'R2 上是个残缺文件，脚本却说成功')
  assert.match(r.out, /大小对不上/)
})

check('⚠️ 验不过时不执行轮转（宁可今天没新备份，也别删掉好的）', () => {
  const e = env({ dump: GOOD_DUMP })
  assert.equal(run(e).code, 0)
  const first = kept(e)[0]
  writeFileSync(join(e.bin, 'mysqldump'), `#!/usr/bin/env bash\nexit 3\n`)
  chmodSync(join(e.bin, 'mysqldump'), 0o755)
  run(e)
  assert.ok(kept(e).includes(first), '这次失败了，却把上次那份好的删了')
})

check('⚠️ 口令不进命令行（ps 里看得见就等于泄露给同机所有用户）', () => {
  const e = env({ dump: `echo "ARGS=$*" >&2; ${GOOD_DUMP}` })
  const r = run(e)
  assert.equal(r.code, 0, r.out)
  const args = (r.out.match(/ARGS=.*/) || [''])[0]
  assert.ok(!args.includes('pw'), `口令出现在了 mysqldump 的参数里：${args}`)
  assert.match(args, /--defaults-extra-file=/, '没走 defaults-extra-file')
})

check('⚠️ --no-tablespaces 在（MySQL 8 下没有 PROCESS 权限就靠它）', () => {
  const e = env({ dump: `echo "ARGS=$*" >&2; ${GOOD_DUMP}` })
  const r = run(e)
  assert.match(r.out, /--no-tablespaces/,
    '缺了它，8bitgo 那个只有库级权限的账号会直接 Access denied')
  assert.match(r.out, /--single-transaction/, '缺了它备份会锁表，站上所有写操作卡住')
})

check('⚠️ 口令临时文件跑完一定清掉（成功和失败两条路都要清）', () => {
  for (const [label, dump] of [['成功', GOOD_DUMP], ['失败', 'exit 7']]) {
    const e = env({ dump })
    run(e)
    const leftovers = readdirSync(e.tmp).filter((f) => {
      try { return readFileSync(join(e.tmp, f), 'utf8').includes('password=') } catch { return false }
    })
    assert.deepEqual(leftovers, [], `${label}那条路留下了口令文件：${leftovers.join(', ')}`)
  }
  // 反证：确认这个目录里**本来会**出现东西，否则上面那条是恒真的
  const e2 = env({ dump: GOOD_DUMP })
  writeFileSync(join(e2.bin, 'mktemp'), `#!/usr/bin/env bash\nf="$TMPDIR/kept.$$"; : > "$f"; chmod 600 "$f"; echo "$f"\n`)
  chmodSync(join(e2.bin, 'mktemp'), 0o755)
  run(e2)
  // 桩 mktemp 建的文件如果没被 cleanup 删掉，说明 trap 根本没生效
  assert.deepEqual(readdirSync(e2.tmp), [], 'trap 没清掉 mktemp 建的文件')
})

check('--local-only 不碰 R2；--dry-run 不上传也不轮转', () => {
  const e1 = env({ dump: GOOD_DUMP })
  assert.equal(run(e1, ['--local-only']).code, 0)
  assert.equal(readdirSync(e1.remote).length, 0, '--local-only 还是传了')
  assert.equal(kept(e1).length, 1)

  const e2 = env({ dump: GOOD_DUMP })
  assert.equal(run(e2, ['--dry-run']).code, 0)
  assert.equal(readdirSync(e2.remote).length, 0, '--dry-run 还是传了')
})

check('没装 rclone 时降级成「只留本地」，而不是整个失败', () => {
  const e = env({ dump: GOOD_DUMP, rclone: false })
  const r = run(e)
  assert.equal(r.code, 0, `没有 rclone 就整个失败了：\n${r.out}`)
  assert.equal(kept(e).length, 1, '本地那份也没留下')
  assert.match(r.out, /没装 rclone/)
})

check('.env 读不到 -> 明确报错，不是静默跑空', () => {
  const e = env({ dump: GOOD_DUMP })
  rmSync(e.envFile)
  const r = run(e)
  assert.notEqual(r.code, 0)
  assert.match(r.out, /读不到/)
})

console.log(failed ? `\n❌ ${failed} 条失败` : '\n全部通过')
process.exit(failed ? 1 : 0)

/**
 * 把 freej2me-web 安装到 public/j2me/。
 *
 * 用法：
 *   npm run j2me              重新安装（已存在会先备份提示）
 *   npm run j2me -- --if-missing   已安装则跳过（构建前自动调用可用这个）
 *
 * 说明：
 *  - freej2me-web 仓库里已经带了构建好的 web/freej2me-web.jar，
 *    所以这里只做「稀疏检出 web/ 目录」，不需要 Docker，也不需要跑 ant。
 *  - 装完会建好 jar/ 与 apps/ 两个空目录：
 *      jar/   放 .jar 游戏，用 run.html?jar=<文件名> 加载
 *      apps/  放预打包的 <app_id>.zip，用 run.html?app=<app_id> 加载
 *  - 产物不进 git（.gitignore 已忽略 public/j2me），换机器重新跑一次即可。
 *
 * 许可证：FreeJ2ME 为 GPL-3.0（另含 ObjectWeb ASM）。它在独立 iframe 里作为
 * 单独程序运行，仓库自带的 LICENSE 会一并复制过去。
 */
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const dest = path.join(root, 'public/j2me')
const REPO = 'https://github.com/zb3/freej2me-web.git'

const ifMissing = process.argv.includes('--if-missing')

if (existsSync(path.join(dest, 'run.html'))) {
  if (ifMissing) {
    console.log('✅ public/j2me/ 已存在，跳过')
    process.exit(0)
  }
  console.log('ℹ️  public/j2me/ 已存在，将重新安装')
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'pipe' })
}

try {
  run('git', ['--version'])
} catch {
  console.error('❌ 需要 git。请先安装 git，或手动把 freej2me-web 的 web/ 目录复制到 public/j2me/')
  process.exit(1)
}

const tmp = path.join(root, '.j2me-tmp')
rmSync(tmp, { recursive: true, force: true })

try {
  console.log('正在拉取 freej2me-web（只取 web/ 目录）…')
  // 稀疏检出：只要 web/ 和 LICENSE，省掉几十 MB 的源码与资源
  run('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', REPO, tmp], root)
  // --no-cone：cone 模式只接受目录，而我们还需要根目录下的 LICENSE 文件
  run('git', ['sparse-checkout', 'set', '--no-cone', '/web/', '/LICENSE'], tmp)

  const src = path.join(tmp, 'web')
  if (!existsSync(path.join(src, 'run.html'))) throw new Error('检出结果里没有 web/run.html')

  rmSync(dest, { recursive: true, force: true })
  mkdirSync(path.dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })

  // 保留上游许可证
  const lic = path.join(tmp, 'LICENSE')
  if (existsSync(lic)) cpSync(lic, path.join(dest, 'LICENSE'))

  // 游戏目录
  mkdirSync(path.join(dest, 'jar'), { recursive: true })
  mkdirSync(path.join(dest, 'apps'), { recursive: true })
  writeFileSync(
    path.join(dest, 'jar', 'README.txt'),
    '把 .jar 游戏放在这个目录，然后用 run.html?jar=<文件名> 加载。\n',
    'utf8',
  )
  writeFileSync(
    path.join(dest, 'apps', 'README.txt'),
    '把预打包的 <app_id>.zip 放在这个目录，然后用 run.html?app=<app_id> 加载。\n',
    'utf8',
  )

  console.log('✅ 已安装到 public/j2me/')
  console.log('   下一步：.env 里设置 VITE_J2ME_PATH=/j2me/')
  console.log('   ⚠️ freej2me-web 依赖 CheerpJ（从 leaningtech 的 CDN 加载），离线环境无法运行')
} catch (e) {
  console.error('❌ 安装失败：', e.message)
  console.error('   可以手动操作：git clone https://github.com/zb3/freej2me-web.git')
  console.error('   然后把它的 web/ 目录复制成 public/j2me/')
  process.exit(1)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

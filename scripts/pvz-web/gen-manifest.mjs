// 扫描本地 PvZ 资源目录，生成 pvz-manifest.json（供自动加载片段按清单拉原始文件）。
//
// 用法：
//   node scripts/pvz-web/gen-manifest.mjs <资源目录> [输出路径]
//
// 约定（与引擎一致）：
//   - 引擎要 FS 根下的 /main.pak，以及一批「散在文件系统根」的资源目录，
//     实测至少包含 /reanim/*（动画 XML + 贴图，main.pak 里没有，缺了会 CppException）。
//   - main.pak 在清单里 fs 永远写 "main.pak"。
//   - 其它资源目录（reanim、images、sounds…）每个文件 r2 === fs === "<目录>/<相对路径>"。
//   - properties/ 下是可选覆盖配置（default.xml 等），有就带上。
//
// PVZ_MAIN_PAK_R2 是相对于页面 PVZ_DATA_BASE 的路径，不是相对于 bucket 根。
// 若 DATA_BASE 指向 bucket 上级、而 main.pak 在 properties/ 子目录，才这样写：
//   PVZ_MAIN_PAK_R2=properties/main.pak node scripts/pvz-web/gen-manifest.mjs <资源目录>
import { createHash } from 'node:crypto'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RES = process.argv[2] || process.env.PVZ_RESOURCE_DIR
if (!RES || !existsSync(RES)) {
  console.error('用法: node scripts/pvz-web/gen-manifest.mjs <资源目录> [输出路径]')
  process.exit(1)
}
const OUT = process.argv[3] || 'pvz-manifest.json'
// R2 里 main.pak 的真实相对路径（默认目录根；被塞进 properties/ 时改这个）
const MAIN_R2 = process.env.PVZ_MAIN_PAK_R2 || 'main.pak'

// 顶层只收这些游戏资源；其余（exe/dll/用户存档 userdata/ 等）忽略，避免进清单。
const TOP_ALLOW = new Set([
  'main.pak', 'properties', 'reanim', 'images', 'sounds', 'music', 'particles', 'props', 'waves',
])
function isJunk(name) {
  return name === '.DS_Store' || name.startsWith('._')
}
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const entries = []
let foundMain = false

function walkProps(dir, rel) {
  for (const name of readdirSync(dir)) {
    if (isJunk(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    const r = rel + '/' + name
    if (st.isDirectory()) walkProps(full, r)
    // 跳过 properties/ 里可能混进来的 main.pak（它属于根，不在 properties/ 下）
    else if (name === 'main.pak') continue
    // size 供加载器算总字节与进度；缺失时它会退化成按文件计数，不会出错
    else entries.push({ r2: r, fs: r, size: st.size, sha256: sha256(full) })
  }
}

function walk(dir, rel) {
  for (const name of readdirSync(dir)) {
    if (isJunk(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    const r = rel ? rel + '/' + name : name
    if (st.isDirectory()) {
      // 顶层只收白名单里的资源目录，其余（exe/dll/userdata 等）直接跳过
      if (!rel && !TOP_ALLOW.has(name)) continue
      if (name === 'properties' && !rel) walkProps(full, 'properties')
      else walk(full, r)
    } else if (name === 'main.pak' && !foundMain) {
      entries.push({ r2: MAIN_R2, fs: 'main.pak', size: st.size, sha256: sha256(full) })
      foundMain = true
    } else if (rel && name !== 'main.pak') {
      // 其它资源文件（reanim/images/sounds…）：r2 === fs，原样写进 FS 根
      // 顶层（rel 为空）只收 main.pak，其余顶层杂文件（exe/dll 等）忽略
      entries.push({ r2: r, fs: r, size: st.size, sha256: sha256(full) })
    }
  }
}

walk(RES, '')
if (!foundMain) {
  console.error('未在资源目录中找到 main.pak（检查 PVZ_MAIN_PAK_R2 是否应改为 properties/main.pak）')
  process.exit(1)
}

entries.sort((a, b) => (a.fs < b.fs ? -1 : a.fs > b.fs ? 1 : 0))
const json = JSON.stringify(entries, null, 2)
writeFileSync(OUT, json)

const propCount = entries.filter((e) => e.fs.startsWith('properties/')).length
const reanimCount = entries.filter((e) => e.fs.startsWith('reanim/')).length
const totalBytes = entries.reduce((n, e) => n + (e.size || 0), 0)
console.log('已写入 ' + OUT)
console.log('  文件总数: ' + entries.length + '（main.pak 1' + (reanimCount ? ' + reanim/ ' + reanimCount : '') + (propCount ? ' + properties/ ' + propCount : '') + '）')
console.log('  总体积: ' + (totalBytes / 1048576).toFixed(1) + ' MB')
console.log('  main.pak 的 R2 路径: ' + MAIN_R2)
// 清单路径没变但内容换了一版时，靠 PVZ_DATA_VERSION 让浏览器整组失效旧缓存
console.log('  提示：若是「换了一版资源但路径不变」，记得把页面里的 PVZ_DATA_VERSION +1')
console.log('')
console.log('下一步：把 main.pak、reanim/ 等整个资源目录、以及本 pvz-manifest.json')
console.log('都上传到页面 PVZ_DATA_BASE 指向的目录；清单 r2 会直接追加在这个基址后。')
console.log('若数据与页面跨源，R2 还必须允许页面来源的 CORS GET/HEAD。')

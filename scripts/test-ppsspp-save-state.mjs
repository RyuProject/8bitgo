import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pathsSource = readFileSync(path.join(root, 'src/emulator/paths.ts'), 'utf8')
const version = /PPSSPP_VERSION\s*=\s*'([^']+)'/.exec(pathsSource)?.[1]
const generation = /PPSSPP_RUNTIME_GENERATION\s*=\s*'(v\d+)'/.exec(pathsSource)?.[1]
assert.ok(version && generation, '无法从 paths.ts 读取 PPSSPP 运行时代次')

const host = readFileSync(path.join(root, 'public/ppsspp', `v${version}`, generation, 'host.js'), 'utf8')
const helpersStart = host.indexOf('  const walkFiles = (root) => {')
const helpersEnd = host.indexOf('  const start = async ({ requestId, file, remote, stateId }) => {', helpersStart)
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, '无法定位 PPSSPP 存档桥接函数')
const helpersSource = host.slice(helpersStart, helpersEnd)

const STATE_MAGIC = '8BGPSP1\n'
const STATE_FORMAT = '8bitgo-ppsspp-state'
const MAX_STATE_BYTES = 96 * 1024 * 1024
const SAVE_ROOT = '/home/web_user/.config/ppsspp'
const SAVE_PATH = `${SAVE_ROOT}/UCUS98711_0.ppst`

function makeHarness(game, { initialState = [1, 2, 3], liveState = [7, 8, 9] } = {}) {
  let stamp = 1
  let failLoad = false
  let synced = 0
  let loaded = null
  const commands = []
  const files = new Map([[SAVE_PATH, Uint8Array.from(initialState)]])
  const FS = {
    readdir(directory) {
      assert.equal(directory, SAVE_ROOT)
      return ['.', '..', 'UCUS98711_0.ppst']
    },
    stat(file) {
      const data = files.get(file)
      assert.ok(data, `测试夹具缺少 ${file}`)
      return { size: data.byteLength, mtime: stamp }
    },
    isDir() {
      return false
    },
    readFile(file) {
      const data = files.get(file)
      assert.ok(data, `测试夹具缺少 ${file}`)
      return data.slice()
    },
    writeFile(file, data) {
      files.set(file, Uint8Array.from(data))
      stamp++
    },
  }

  const nativeCommand = async (command) => {
    commands.push(command)
    if (command === 1) FS.writeFile(SAVE_PATH, Uint8Array.from(liveState))
    if (command === 2) {
      if (failLoad) throw new Error('模拟核心读档失败')
      loaded = FS.readFile(SAVE_PATH)
    }
  }
  const globals = {
    FS,
    SAVE_ROOT,
    STATE_MAGIC,
    STATE_FORMAT,
    MAX_STATE_BYTES,
    saveIdentity: game,
    nativeCommand,
    syncSaves: () => { synced++; return Promise.resolve() },
    ArrayBuffer,
    DataView,
    Date,
    Error,
    JSON,
    Promise,
    TextDecoder,
    TextEncoder,
    Uint8Array,
  }
  const api = vm.runInNewContext(
    `(() => { ${helpersSource}\n return { exportState, importState, encodeState, decodeState } })()`,
    globals,
    { filename: 'ppsspp-state-bridge.js' },
  )

  return {
    ...api,
    commands,
    failNextLoad() { failLoad = true },
    getFile() { return FS.readFile(SAVE_PATH) },
    getLoaded() { return loaded },
    getSynced() { return synced },
  }
}

const gameA = makeHarness('game-a')
const exported = await gameA.exportState()
assert.deepEqual([...gameA.decodeState(exported)], [7, 8, 9], '即时存档导出必须保留核心生成的状态字节')
assert.equal(gameA.getSynced(), 1, '成功导出后必须请求持久化记忆棒')

const gameB = makeHarness('game-b')
const otherGameArchive = gameB.encodeState('/home/web_user/.config/ppsspp/UCUS98711_0.ppst', Uint8Array.from([4, 5, 6]))
await assert.rejects(() => gameA.importState(otherGameArchive), /属于另一款游戏/)
assert.deepEqual(gameA.commands, [1], '游戏身份不匹配必须在碰核心或写文件前拒绝')

const loadHarness = makeHarness('game-a', { liveState: [10, 11, 12] })
await loadHarness.importState(exported)
assert.deepEqual([...loadHarness.getLoaded()], [7, 8, 9], '合法存档必须交给当前 PSP 核心读入')
assert.deepEqual([...loadHarness.getFile()], [7, 8, 9], '成功读档后记忆棒里的即时槽必须同步为导入内容')
assert.equal(loadHarness.getSynced(), 1, '成功读档后必须同步持久化记忆棒')

const rollbackHarness = makeHarness('game-a', { initialState: [20, 21, 22], liveState: [30, 31, 32] })
rollbackHarness.failNextLoad()
await assert.rejects(() => rollbackHarness.importState(exported), /模拟核心读档失败/)
assert.deepEqual([...rollbackHarness.getFile()], [30, 31, 32], '核心拒绝读档时必须还原覆盖前的即时槽')
assert.equal(rollbackHarness.getSynced(), 0, '读档失败不能把未应用的状态同步为持久进度')

assert.throws(() => gameA.decodeState(new Uint8Array()), /无效或过大/)
const malformed = gameA.encodeState('/home/web_user/.config/ppsspp/not-a-state.bin', Uint8Array.from([1]))
assert.throws(() => gameA.decodeState(malformed), /内容损坏/)

console.log('✔ PPSSPP 即时存档：导出/读回、跨游戏拒绝、坏头拒绝、核心失败回滚与 IDBFS 同步')

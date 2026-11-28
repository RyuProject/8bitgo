/** 网络异常的文案即使带“8BG / ROM 包”也不能跳过同地址重试。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isDeterministicStartupFailure } from '../src/emulator/startupRetryPolicy.ts'

assert.equal(isDeterministicStartupFailure('network', '8BG 文件头预检超时'), false,
  '8BG Range 预检超时属于网络故障，保留同地址自动重试')
assert.equal(isDeterministicStartupFailure('network', 'ROM 包下载连接长时间没有数据'), false,
  'ROM 包传输失速不能被文字关键字改判成内容损坏')
assert.equal(isDeterministicStartupFailure('content', 'ROM 包第 2 块解密失败：文件损坏'), true,
  '明确的内容错误可以跳过无意义的同地址重试')
assert.equal(isDeterministicStartupFailure('deterministic', 'romset is unknown'), true,
  '确定性格式错误仍直接寻找内容备用源')
assert.equal(isDeterministicStartupFailure('runtime', '8BG ROM 包加载器未初始化'), false,
  '运行时设施故障不能污染 ROM 候选链')

const player = readFileSync(new URL('../src/emulator/EmulatorPlayer.tsx', import.meta.url), 'utf8')
assert.match(player, /isDeterministicStartupFailure\(errorScope, message\)/,
  '启动错误分流必须调用受 scope 约束的纯策略')
console.log('✔ 启动重试策略：网络 scope 优先于 8BG / ROM 文案，坏内容与运行时故障分流正确')

import assert from 'node:assert/strict'
import { observeNdsPerformanceRecovery } from '../src/emulator/ndsPerformanceRecovery.ts'

assert.deepEqual(observeNdsPerformanceRecovery(60, 0, false), { healthyWindows: 0, recovered: false }, '没有低帧警告时不创建恢复状态')
assert.deepEqual(observeNdsPerformanceRecovery(60, 0, true), { healthyWindows: 1, recovered: false }, '首个健康窗口不能清提示')
assert.deepEqual(observeNdsPerformanceRecovery(60, 1, true), { healthyWindows: 2, recovered: false }, '第二个健康窗口仍保留提示')
assert.deepEqual(observeNdsPerformanceRecovery(60, 2, true), { healthyWindows: 0, recovered: true }, '连续三个健康窗口清除已恢复的性能提示')
assert.deepEqual(observeNdsPerformanceRecovery(50, 0, true), { healthyWindows: 1, recovered: false }, '50Hz 游戏达到健康阈值，不会被误判仍在掉帧')
assert.deepEqual(observeNdsPerformanceRecovery(47, 2, true), { healthyWindows: 0, recovered: false }, '一次低帧窗口会打断恢复连续计数')
assert.deepEqual(observeNdsPerformanceRecovery(Number.NaN, 2, true), { healthyWindows: 0, recovered: false }, '无效帧率不能清除告警')

console.log('NDS 性能提示只在连续恢复后清除；低帧与无效采样会重置恢复窗口')

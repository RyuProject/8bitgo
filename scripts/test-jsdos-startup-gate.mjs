import assert from 'node:assert/strict'
import { createJsdosResourceFailureGate } from '../src/emulator/jsdosStartupGate.ts'

const makeDeferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const engine = makeDeferred()
const resourceGate = createJsdosResourceFailureGate()
const earlyFailure = new Error('ROM 资源不可读')
const started = resourceGate.race(engine.promise)
resourceGate.fail(earlyFailure)
resourceGate.fail(new Error('后续失败不能覆盖第一个原因'))
await assert.rejects(started, (error) => error === earlyFailure)
console.log('✔ ROM 等资源早于 js-dos 入口超时失败时，启动立即返回首个原因')
// race 已拒绝，入口稍后报错也必须已被处理，不能产生未处理 Promise rejection。
engine.resolve(() => {})

const readyGate = createJsdosResourceFailureGate()
const readyEngine = Promise.resolve('Dos')
assert.equal(await readyGate.race(readyEngine), 'Dos')
readyGate.fail(new Error('引擎就绪后的资源错误由原启动流程处理'))
console.log('✔ 引擎先就绪时保留原有资源检查顺序')

const engineError = new Error('js-dos script failed')
await assert.rejects(createJsdosResourceFailureGate().race(Promise.reject(engineError)), (error) => error === engineError)
console.log('✔ js-dos 入口自身失败仍原样传递')

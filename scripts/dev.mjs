#!/usr/bin/env node

/**
 * 本地全栈开发入口。
 *
 * CS1.6 的服务器目录、IP 验证与临时房间都在 8788 后端；过去根目录的 `npm run dev`
 * 只启动 Vite，页面本身能打开，却会把所有 `/api/cs16/*` 请求代理到一个不存在的进程，
 * 最终只剩下浏览器的 `TypeError: Failed to fetch`。这里把两个进程绑成同一条生命周期，
 * 同时允许已经手工启动的后端继续复用，避免端口冲突。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ROOT = path.join(ROOT, 'server')
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const LOCAL_CS16_STATUS = 'http://127.0.0.1:8788/api/cs16/status'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function localCs16BackendReady(fetchImpl = fetch, timeoutMs = 800) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(LOCAL_CS16_STATUS, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) return false
    const status = await response.json()
    return Boolean(
      typeof status?.enabled === 'boolean' && status?.connections && typeof status.connections === 'object',
    )
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitForBackend(child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`本地后端启动失败（退出码 ${child.exitCode ?? child.signalCode}）`)
    }
    if (await localCs16BackendReady()) return
    await delay(100)
  }
  throw new Error('本地后端 8 秒内没有就绪')
}

function start(label, command, args, options) {
  const child = spawn(command, args, { stdio: 'inherit', ...options })
  child.on('error', (error) => console.error(`[dev] ${label} 无法启动：${error.message}`))
  return child
}

export async function main(args = process.argv.slice(2)) {
  const children = []
  let ownedBackend = null
  let stopping = false

  const stop = (signal = 'SIGTERM') => {
    if (stopping) return
    stopping = true
    for (const child of children) {
      if (child.exitCode == null && child.signalCode == null) child.kill(signal)
    }
  }

  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))

  try {
    if (process.env.BACKEND_URL) {
      console.log(`[dev] 使用 BACKEND_URL=${process.env.BACKEND_URL}，不再启动本机 8788 后端`)
    } else if (await localCs16BackendReady()) {
      console.log('[dev] 已发现可用的 8788 后端，继续复用')
    } else {
      ownedBackend = start('后端', process.execPath, ['src/index.js'], {
        cwd: SERVER_ROOT,
        env: process.env,
      })
      children.push(ownedBackend)
      await waitForBackend(ownedBackend)
      console.log('[dev] 联机目录、IP 连接与房间码后端已就绪')
    }

    const web = start('前端', process.execPath, [VITE_CLI, ...args], {
      cwd: ROOT,
      env: process.env,
    })
    children.push(web)

    const result = await new Promise((resolve) => {
      for (const child of children) {
        child.once('exit', (code, signal) => resolve({ child, code, signal }))
      }
    })
    const backendCrashed = !stopping && result.child === ownedBackend
    if (backendCrashed) {
      console.error(`[dev] 后端意外退出（${result.code ?? result.signal}），前端同步停止，避免出现半可用页面`)
    }
    stop()
    process.exitCode = backendCrashed ? 1 : result.code && result.code !== 0 ? result.code : 0
  } catch (error) {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`)
    stop()
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}

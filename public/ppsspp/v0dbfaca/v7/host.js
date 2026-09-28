/*
 * 8BitGo ↔ PPSSPP 桥。
 *
 * 远程游戏只把 URL 作为 argv 交给打过补丁的核心。这里故意没有“整盘请求后转内存”逻辑：
 * 一旦有人把整盘下载逻辑加回来，scripts/test-ppsspp-range.mjs 会直接失败。
 */
(() => {
  'use strict'

  const SOURCE = '8bitgo-ppsspp-bridge'
  const VERSION = 1
  // Cloudflare 对这组资源的缓存键忽略查询串，旧 data 曾在 `?r=17` 下继续返回 r16。
  // 因此 v7 实体目录才是原子换代边界；目录内所有文件必须来自同一次发布。
  const RUNTIME_SCRIPT = 'PPSSPPSDL.js'
  const AUDIO_WORKLET_SCRIPT = 'audio-worklet.js'
  const SAVE_ROOT = '/home/web_user/.config/ppsspp'
  const MEMSTICK_DIRS = ['PSP', 'PSP/SYSTEM', 'PSP/SAVEDATA', 'PSP/PPSSPP_STATE', 'PSP/GAME']
  const MEMSTICK_SEED_FILES = ['PSP/SYSTEM/controls.ini']
  const PERFORMANCE_CONFIG_PATH = '/8bitgo-performance.ini'
  const STATE_MAGIC = '8BGPSP1\n'
  const STATE_FORMAT = '8bitgo-ppsspp-state'
  const MAX_STATE_BYTES = 96 * 1024 * 1024
  const NATIVE_TIMEOUT_MS = 30_000
  const BOOTED_LOG_PATTERN = /\bBooted\s+.+\.\.\./
  const canvas = document.getElementById('canvas')
  const status = document.getElementById('status')
  let started = false
  let syncTimer = 0
  let syncRunning = false
  let syncQueued = false
  let saveSyncEnabled = false
  let saveIdentity = ''
  let nativePending = null

  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))

  const fetchCoreData = async (url, expectedSize) => {
    const attempts = 3
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController()
      let stallTimer = 0
      const armStallTimer = () => {
        window.clearTimeout(stallTimer)
        stallTimer = window.setTimeout(() => controller.abort('30 秒没有收到核心资源数据'), 30_000)
      }
      try {
        armStallTimer()
        const response = await fetch(url, {
          signal: controller.signal,
          cache: 'force-cache',
          credentials: 'same-origin',
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const reader = response.body?.getReader()
        if (!reader) {
          const bytes = await response.arrayBuffer()
          if (expectedSize > 0 && bytes.byteLength !== expectedSize) throw new Error('核心资源长度不正确')
          window.clearTimeout(stallTimer)
          return bytes
        }
        const output = expectedSize > 0 ? new Uint8Array(expectedSize) : null
        const chunks = output ? null : []
        let loaded = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value?.byteLength) continue
          armStallTimer()
          if (output) {
            if (loaded + value.byteLength > output.byteLength) throw new Error('核心资源长度超过清单值')
            output.set(value, loaded)
          } else {
            chunks.push(value)
          }
          loaded += value.byteLength
          const total = expectedSize > 0 ? expectedSize : loaded
          setStatus(`正在下载 PSP 核心资源… ${Math.min(99, Math.round((loaded / total) * 100))}%`)
        }
        if (expectedSize > 0 && loaded !== expectedSize) {
          throw new Error(`核心资源长度不正确（${loaded}/${expectedSize}）`)
        }
        window.clearTimeout(stallTimer)
        if (output) return output.buffer
        const joined = new Uint8Array(loaded)
        let offset = 0
        for (const chunk of chunks) {
          joined.set(chunk, offset)
          offset += chunk.byteLength
        }
        return joined.buffer
      } catch (error) {
        window.clearTimeout(stallTimer)
        lastError = error
        if (attempt >= attempts) break
        console.warn(`[ppsspp] 核心资源下载失败，第 ${attempt + 1}/${attempts} 次重试`, error)
        setStatus(`PSP 核心资源下载中断，正在重试（${attempt + 1}/${attempts}）…`)
        await wait(500 * (2 ** (attempt - 1)))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || '核心资源下载失败'))
  }

  const performanceProfile = () => {
    const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 4)
    const memory = Math.max(0, Number(navigator.deviceMemory) || 0)
    const saveData = navigator.connection?.saveData === true
    // PPSSPP 的游戏内部仍按 PSP 分辨率整数倍渲染；画布只负责最终呈现。此前画布跟着
    // Retina 屏达到约 2K，代理 WebGL 每帧白白多复制 4 倍像素。按设备能力限制最终
    // 后备缓冲，既不改变游戏逻辑，也能同时降低直播编码器的输入尺寸。
    if (saveData || cores <= 2 || (memory > 0 && memory <= 2)) {
      return { id: 'performance', width: 480, height: 272, separateSasThread: false }
    }
    if (cores <= 4 || (memory > 0 && memory <= 4)) {
      return { id: 'balanced', width: 720, height: 408, separateSasThread: false }
    }
    return { id: 'quality', width: 960, height: 544, separateSasThread: true }
  }

  const performanceConfig = (profile) => `# 8BitGo browser compatibility profile: buffered-native-v1
[CPU]
FastMemoryAccess = True
SeparateSASThread = ${profile.separateSasThread ? 'True' : 'False'}
IOTimingMethod = 0

[Graphics]
# PSP 原生分辨率是最可靠的公共基线。部分游戏把 565/8888 framebuffer 交错复用，2x 会把
# 本应精确别名的缓冲区拆成不同渲染目标；这里统一 1x，最终画布尺寸仍由设备档位控制。
InternalResolution = 1
FrameSkip = 0
AutoFrameSkip = False
HardwareTransform = True
SoftwareSkinning = True
AnisotropyLevel = 0
MultiSampleLevel = 0
TexScalingLevel = 1
TexDeposterize = False
TexHardwareScaling = False
TextureShader = Off
VerticalSync = False
LowLatencyPresent = False
InflightFrames = 2
RenderDuplicateFrames = False
# 这些选项不允许被老访客的单游戏配置重新打开。它们是通用正确性基线，不是只给某一款游戏
# 的补丁：跳过缓冲效果、GPU 回读或深度精度会让依赖后处理/跨帧复制的游戏花屏、黑屏或丢特效。
SkipBufferEffects = False
SkipGPUReadbackMode = 0
HighQualityDepth = True
DisableRangeCulling = False
TextureBackoffCache = False
BloomHack = 0
`

  const post = (type, payload = {}) => {
    if (window.parent === window) return
    window.parent.postMessage({ source: SOURCE, version: VERSION, type, ...payload }, location.origin)
  }

  const setStatus = (message, tone = 'info') => {
    status.hidden = !message
    status.textContent = message || ''
    status.dataset.tone = tone
  }

  const respond = (requestId, ok, payload = undefined, error = undefined, transfer = []) => {
    if (window.parent === window) return
    window.parent.postMessage(
      { source: SOURCE, version: VERSION, type: 'response', requestId, ok, payload, error },
      location.origin,
      transfer,
    )
  }

  const syncSaves = () => {
    if (!saveSyncEnabled) return
    if (syncRunning) {
      syncQueued = true
      return
    }
    try {
      if (typeof FS === 'undefined') return
      syncRunning = true
      FS.syncfs(false, (error) => {
        syncRunning = false
        if (error) console.warn('[ppsspp] 存档写入 IndexedDB 失败', error)
        if (syncQueued) {
          syncQueued = false
          syncSaves()
        }
      })
    } catch (error) {
      syncRunning = false
      console.warn('[ppsspp] 无法同步存档', error)
    }
  }

  const safeName = (name) => {
    const tail = String(name || 'game.iso').split(/[\\/]/).pop() || 'game.iso'
    return tail.replace(/[\u0000-\u001f]/g, '_')
  }

  const nativeCommand = (command) => new Promise((resolve, reject) => {
    if (nativePending) {
      reject(new Error('PPSSPP 正在处理另一个存档操作'))
      return
    }
    const enqueue = window.Module?.__ppssppBridgeSetCommand
    if (typeof enqueue !== 'function') {
      reject(new Error('PPSSPP 核心没有加载存档/改键桥'))
      return
    }
    const timer = window.setTimeout(() => {
      if (!nativePending) return
      nativePending = null
      reject(new Error('PPSSPP 存档操作超时'))
    }, NATIVE_TIMEOUT_MS)
    nativePending = {
      finish(status) {
        window.clearTimeout(timer)
        nativePending = null
        if (status > 0) resolve()
        else reject(new Error(status === -2 ? 'PPSSPP 正在处理另一个存档操作' : 'PPSSPP 存档操作失败'))
      },
    }
    if (!enqueue(command)) {
      window.clearTimeout(timer)
      nativePending = null
      reject(new Error('PPSSPP 命令队列正忙'))
    }
  })

  const walkFiles = (root) => {
    const out = []
    const visit = (path) => {
      for (const name of FS.readdir(path)) {
        if (name === '.' || name === '..') continue
        const child = `${path}/${name}`
        const stat = FS.stat(child)
        if (FS.isDir(stat.mode)) visit(child)
        else out.push({ path: child, size: Number(stat.size) || 0, mtime: Number(stat.mtime?.getTime?.() || stat.mtime || 0) })
      }
    }
    visit(root)
    return out
  }

  const currentStateFile = () => {
    const files = walkFiles(SAVE_ROOT)
      .filter((entry) => /\/[^/]+_0\.ppst$/i.test(entry.path) && entry.size > 0)
      .sort((a, b) => b.mtime - a.mtime)
    return files[0] || null
  }

  const encodeState = (path, bytes) => {
    const headerBytes = new TextEncoder().encode(JSON.stringify({
      format: STATE_FORMAT,
      version: 1,
      game: saveIdentity,
      file: path.split('/').pop(),
      size: bytes.byteLength,
      savedAt: new Date().toISOString(),
    }))
    const magic = new TextEncoder().encode(STATE_MAGIC)
    const out = new Uint8Array(magic.byteLength + 4 + headerBytes.byteLength + bytes.byteLength)
    out.set(magic, 0)
    new DataView(out.buffer).setUint32(magic.byteLength, headerBytes.byteLength, true)
    out.set(headerBytes, magic.byteLength + 4)
    out.set(bytes, magic.byteLength + 4 + headerBytes.byteLength)
    return out
  }

  const decodeState = (value) => {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null
    const magic = new TextEncoder().encode(STATE_MAGIC)
    if (!bytes || bytes.byteLength < magic.byteLength + 4 || bytes.byteLength > MAX_STATE_BYTES + 64 * 1024) {
      throw new Error('PSP 存档文件无效或过大')
    }
    for (let i = 0; i < magic.byteLength; i++) {
      if (bytes[i] !== magic[i]) throw new Error('这不是 8BitGo 的 PSP 即时存档')
    }
    const headerSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(magic.byteLength, true)
    if (headerSize <= 0 || headerSize > 64 * 1024 || magic.byteLength + 4 + headerSize > bytes.byteLength) {
      throw new Error('PSP 存档头损坏')
    }
    let header
    try {
      header = JSON.parse(new TextDecoder().decode(bytes.subarray(magic.byteLength + 4, magic.byteLength + 4 + headerSize)))
    } catch {
      throw new Error('PSP 存档头损坏')
    }
    const state = bytes.slice(magic.byteLength + 4 + headerSize)
    if (
      header?.format !== STATE_FORMAT ||
      header?.version !== 1 ||
      header?.game !== saveIdentity ||
      !/^[^/\\]+_0\.ppst$/i.test(String(header?.file || '')) ||
      Number(header?.size) !== state.byteLength ||
      state.byteLength <= 0 ||
      state.byteLength > MAX_STATE_BYTES
    ) {
      throw new Error(header?.game !== saveIdentity ? '这份 PSP 存档属于另一款游戏' : 'PSP 存档内容损坏')
    }
    return state
  }

  const exportState = async () => {
    await nativeCommand(1)
    const entry = currentStateFile()
    if (!entry) throw new Error('PPSSPP 没有生成即时存档文件')
    const state = FS.readFile(entry.path)
    if (!(state instanceof Uint8Array) || state.byteLength === 0 || state.byteLength > MAX_STATE_BYTES) {
      throw new Error('PPSSPP 生成的即时存档无效或过大')
    }
    syncSaves()
    return encodeState(entry.path, state)
  }

  const importState = async (data) => {
    const state = decodeState(data)
    // 先让当前游戏自己生成 0 号槽路径。游戏 ID 来自盘内 PARAM.SFO，不能相信导入文件里的
    // 文件名去猜；否则不同地区版会把状态写到另一个游戏的槽位里，读档按钮却仍提示成功。
    await nativeCommand(1)
    const entry = currentStateFile()
    if (!entry) throw new Error('无法确定当前 PSP 游戏的即时存档槽位')
    const previous = FS.readFile(entry.path)
    FS.writeFile(entry.path, state)
    try {
      await nativeCommand(2)
    } catch (error) {
      // 读入失败要把刚覆盖的状态还回去；否则一次坏文件会连 PPSSPP 自己原来的 0 号槽也毁掉。
      FS.writeFile(entry.path, previous)
      throw error
    }
    syncSaves()
  }

  const start = ({ requestId, file, remote, stateId }) => {
    if (started) {
      respond(requestId, false, undefined, '同一个 PPSSPP 页面只能启动一款游戏')
      return
    }
    started = true
    saveIdentity = String(stateId || safeName(file?.name || remote?.name || 'psp-game'))
    setStatus('正在启动 PPSSPP…')
    let runtimeInitialized = false
    let canvasStarted = false
    let gameBootConfirmed = false
    let requestSettled = false
    let fatal = false
    let canvasPoll = 0

    const isLocal = file instanceof File
    const gamePath = isLocal ? `/game/${safeName(file.name)}` : String(remote?.url || '')
    const profile = performanceProfile()
    if (!isLocal && (!remote || !/^https?:\/\//i.test(gamePath) || !Number.isFinite(remote.size) || remote.size <= 0)) {
      started = false
      respond(requestId, false, undefined, '远程 PSP 镜像描述无效')
      return
    }

    const stopReadyChecks = () => {
      window.cancelAnimationFrame(canvasPoll)
    }

    const finishStart = () => {
      if (requestSettled || fatal || !runtimeInitialized || !canvasStarted) return
      // Range 回调从 PPSSPP 的 pthread 回到页面主线程，在部分浏览器里可能晚到或完全丢失；它适合
      // 报进度和错误，不适合作为唯一的启动闸门。远程盘必须等核心自己的稳定 `Booted` 日志，既能
      // 证明镜像已经打开，也不会把 SDL 刚清出的黑画布误报成游戏运行中。
      if (!isLocal && !gameBootConfirmed) return
      requestSettled = true
      stopReadyChecks()
      setStatus('')
      syncTimer = window.setInterval(syncSaves, 30_000)
      respond(requestId, true, { mode: isLocal ? 'local' : 'range' })
      canvas.focus()
    }

    const fail = (message) => {
      if (fatal) return
      fatal = true
      stopReadyChecks()
      window.clearInterval(syncTimer)
      setStatus(message, 'error')
      if (!requestSettled) {
        requestSettled = true
        respond(requestId, false, undefined, message)
      } else {
        post('runtime-error', { error: message })
      }
    }

    const observeCoreLog = (text) => {
      // PPSSPP 的普通日志在不同 Emscripten/浏览器组合中可能走 stdout，也可能走 stderr；两路都
      // 必须观察。核心固定写成 `Booted <path>...`，允许前面带时间戳或 ANSI 颜色前缀。
      if (!isLocal && BOOTED_LOG_PATTERN.test(String(text))) {
        gameBootConfirmed = true
        finishStart()
      }
    }

    const watchCanvas = () => {
      // 没有 width/height 属性时画布固有尺寸是 300×150；SDL 真正建好窗口后会改成 PSP
      // 的渲染尺寸。连续两帧看到新尺寸，排除初始化过程中一闪而过的中间状态。
      let stableFrames = 0
      const check = () => {
        if (fatal || requestSettled) return
        if (canvas.width !== 300 || canvas.height !== 150) stableFrames++
        else stableFrames = 0
        if (stableFrames >= 2) {
          canvasStarted = true
          finishStart()
          return
        }
        canvasPoll = window.requestAnimationFrame(check)
      }
      canvasPoll = window.requestAnimationFrame(check)
    }

    // C++ Range loader 每完成一块会调用它；数值表示本局实际从网络取回的累计字节，
    // 不是光盘顺序位置，所以随机寻道时允许超过镜像总大小。
    window.__ppssppRangeProgress = (loaded, total) => {
      const safeLoaded = Number(loaded) || 0
      const safeTotal = Number(total) || Number(remote?.size) || 0
      if (!isLocal && safeTotal !== Number(remote.size)) {
        fail(`远程 PSP 镜像在启动期间发生变化：探测为 ${remote.size} 字节，读取为 ${safeTotal} 字节`)
        return
      }
      if (!requestSettled && safeLoaded > 0) {
        const progress = safeTotal > 0 ? ` ${Math.min(99, Math.max(1, Math.round((safeLoaded / safeTotal) * 100)))}%` : ''
        setStatus(`正在流式读取游戏…${progress}`)
      }
      post('stream-progress', { loaded: safeLoaded, total: safeTotal })
      finishStart()
    }
    window.__ppssppRangeError = (message) => {
      fail(`PPSSPP 流式读盘失败：${String(message || '未知错误')}`)
    }
    window.__ppssppAudioMode = (mode) => {
      console.info(`[ppsspp] 音频输出：${mode === 'worklet' ? 'AudioWorklet' : 'ScriptProcessor 兼容模式'}`)
    }
    window.__ppssppAudioStats = (stats) => {
      const underflows = Number(stats?.underflows) || 0
      if (underflows > 0) console.warn(`[ppsspp] 音频线程过去 5 秒欠载 ${underflows} 次`)
    }
    window.__ppssppPerformance = (sample) => {
      console.info('[ppsspp] 性能采样', sample)
      post('performance', { sample: { ...sample, profile: `${profile.id}+buffered-native-v1` } })
    }

    window.Module = {
      canvas,
      // 浏览器里的“全屏”只应该由外层播放器控制。强制 windowed 并给出明确的后备缓冲
      // 尺寸，可阻止 PPSSPP 读取旧配置后把 iframe 误扩到整块 Retina 屏。
      // appendconfig 在 PPSSPP 读完全局配置和单游戏配置后再次合并；只改默认值不够，老访客
      // IDBFS 里的跳帧/跳缓冲设置仍会重新制造花屏。两帧队列比最低延迟的单帧模式多一点
      // 输入延迟，但会给浏览器代理呈现留出余量；完整缓冲和 0 跳帧优先保证所有游戏正确。
      arguments: [
        '--windowed',
        '--xres', String(profile.width),
        '--yres', String(profile.height),
        // 远程 URL 和本地 /game 镜像必须永远待在记忆棒之外。显式参数既模拟实体 UMD 的布局，
        // 也防止以后 PPSSPP Web 默认路径变化后把光盘误暴露在 ms0:/ 的 PSP 目录旁边。
        // PPSSPP 的长参数必须用等号；拆成两个 argv 会把 SAVE_ROOT 当作第二个待启动文件，
        // 随后的远程 URL 就触发 `Can only boot one file`，页面只能等到外层超时。
        `--memstick=${SAVE_ROOT}`,
        `--appendconfig=${PERFORMANCE_CONFIG_PATH}`,
        gamePath,
      ],
      __ppssppAudioWorkletUrl: new URL(AUDIO_WORKLET_SCRIPT, location.href).href,
      locateFile(path) {
        return new URL(path, location.href).href
      },
      // Emscripten 的默认 preload fetch 一次网络抖动就永久终止启动。返回 Promise 接管同一份
      // 数据下载，在 30 秒无进度时中止当前连接并自动重试；已知长度时直接写入单一缓冲区，
      // 避免“分片数组 + 合并数组”让移动端在解包前瞬间多占一整份 data。force-cache 会复用 v7 实体目录。
      getPreloadedPackage(packageName, packageSize) {
        return fetchCoreData(packageName, Number(packageSize) || 0)
      },
      print(text) {
        const message = String(text)
        console.log('[ppsspp]', message)
        observeCoreLog(message)
      },
      printErr(text) {
        const message = String(text)
        console.error('[ppsspp]', message)
        observeCoreLog(message)
        // 第一批已发布核心只能把 Range 致命错误写到 stderr，没有 JS 回调。先识别它，
        // 让玩家得到明确错误并让外层结束加载，而不是首帧后继续停在黑屏。
        if (/Range request failed|Remote disc changed size|Range block was shorter|HTTP Range read reached|Server did not provide a valid 206/i.test(message)) {
          fail(`PPSSPP 流式读盘失败：${message}`)
        }
      },
      setStatus(text) {
        if (text) setStatus(String(text))
      },
      preRun: [() => {
        // 文件只存在于本局的 Wasm 文件系统，不写进 IDBFS；每次启动都按当前硬件重新选档，
        // 但 PPSSPP 仍会把实际采用值保存进自己的配置，设置页显示和运行状态保持一致。
        FS.writeFile(PERFORMANCE_CONFIG_PATH, new TextEncoder().encode(performanceConfig(profile)))

        // PSP/SAVEDATA、即时存档与配置都放进 IDBFS。先把旧内容拉进来再放行 main，
        // 否则 PPSSPP 会在空目录上启动，稍后同步时反而把已有存档覆盖掉。
        // Emscripten 5 把可挂载后端收进 FS.filesystems，不再把 IDBFS / WORKERFS
        // 暴露成全局变量；直接引用全局名会在真正读盘前抛 ReferenceError。
        const idbfs = FS.filesystems?.IDBFS
        if (!idbfs) throw new Error('PPSSPP 核心缺少 IDBFS，无法安全加载和保存进度')
        FS.mkdirTree(SAVE_ROOT)
        FS.mount(idbfs, {}, SAVE_ROOT)
        addRunDependency('8bitgo-ppsspp-idbfs')
        FS.syncfs(true, (error) => {
          try {
            if (error) {
              // 读失败时仍允许游戏启动，但本局绝不能再往同一 IDBFS 回写空目录，否则会把
              // 原有存档覆盖掉。玩家本局的存档只保留在内存，下一次正常读取后再恢复同步。
              saveSyncEnabled = false
              console.warn('[ppsspp] 读取本地存档失败，本局已禁用持久化以保护旧存档', error)
            } else {
              saveSyncEnabled = true
            }
            // 仅创建挂载根目录还不够：PPSSPP 在主函数最早阶段就会写 SYSTEM/ppsspp.ini 和
            // controls.ini，等核心自己补目录已经太晚。标准记忆棒树必须在移除 run dependency
            // 之前就绪；这些目录不含镜像，仍满足 DJMAX 一类游戏的反盗版隔离要求。
            for (const directory of MEMSTICK_DIRS) FS.mkdirTree(`${SAVE_ROOT}/${directory}`)
            // 控制器配置的保存路径比普通 ini 更苛刻：它会先读取旧文件再写回，首次安装时文件不存在
            // 就直接放弃保存。只补空文件且绝不覆盖已有配置，让第一次改键也能正常持久化。
            for (const relative of MEMSTICK_SEED_FILES) {
              const path = `${SAVE_ROOT}/${relative}`
              try {
                FS.stat(path)
              } catch {
                FS.writeFile(path, new Uint8Array())
              }
            }
          } catch (directoryError) {
            saveSyncEnabled = false
            console.warn('[ppsspp] 无法准备记忆棒目录，本局已禁用持久化', directoryError)
          } finally {
            removeRunDependency('8bitgo-ppsspp-idbfs')
          }
        })

        if (isLocal) {
          const workerfs = FS.filesystems?.WORKERFS
          if (!workerfs) throw new Error('PPSSPP 核心缺少 WORKERFS，无法打开本地镜像')
          FS.mkdirTree('/game')
          FS.mount(workerfs, { files: [file] }, '/game')
        }
      }],
      onRuntimeInitialized() {
        // 这个回调发生在 callMain 之前，只代表 WASM 装载完成。旧实现此处直接报成功，
        // 后面的 ISO 读取即使失败，外层也已经丢掉请求。必须再等真实读盘和首帧。
        runtimeInitialized = true
        setStatus(isLocal ? '正在打开本地游戏…' : '正在流式读取游戏…')
        watchCanvas()
        finishStart()
      },
      onAbort(reason) {
        fail(`PPSSPP 已中止：${String(reason || '未知原因')}`)
      },
    }
    window.Module.__ppssppNativeResult = (status) => nativePending?.finish(Number(status) || -1)

    const script = document.createElement('script')
    script.src = RUNTIME_SCRIPT
    script.async = true
    script.onerror = () => {
      const message = 'PPSSPP 核心文件未部署或版本不完整。请运行 npm run ppsspp:build 后重新构建站点。'
      fail(message)
    }
    document.head.appendChild(script)
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== location.origin) return
    const message = event.data
    if (!message || message.source !== SOURCE || message.version !== VERSION) return
    if (message.type === 'mount-local') start({ requestId: message.requestId, file: message.file, stateId: message.stateId })
    if (message.type === 'mount-remote') start({ requestId: message.requestId, remote: message.remote, stateId: message.stateId })
    if (message.type === 'save-state') {
      void exportState()
        .then((bytes) => respond(message.requestId, true, { data: bytes.buffer }, undefined, [bytes.buffer]))
        .catch((error) => respond(message.requestId, false, undefined, error instanceof Error ? error.message : String(error)))
    }
    if (message.type === 'load-state') {
      void importState(message.data)
        .then(() => respond(message.requestId, true))
        .catch((error) => respond(message.requestId, false, undefined, error instanceof Error ? error.message : String(error)))
    }
    if (message.type === 'open-controls') {
      const enqueue = window.Module?.__ppssppBridgeSetCommand
      if (typeof enqueue !== 'function' || !enqueue(3)) console.warn('[ppsspp] 原生改键页暂时无法打开')
    }
  })

  window.addEventListener('pagehide', () => {
    window.clearInterval(syncTimer)
    syncSaves()
  })

  window.addEventListener('error', (event) => {
    if (started && window.__ppssppRangeError) {
      window.__ppssppRangeError(event.error?.message || event.message || '运行时脚本异常')
    }
  })
  window.addEventListener('unhandledrejection', (event) => {
    if (started && window.__ppssppRangeError) {
      window.__ppssppRangeError(event.reason?.message || event.reason || '运行时 Promise 异常')
    }
  })

  post('host-ready')
})()

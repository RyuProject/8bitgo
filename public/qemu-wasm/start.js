/**
 * Alpine Linux 的 QEMU.wasm 启动器。
 *
 * 上游演示把网络栈交给 mockServiceWorker.js，但 GitHub Pages 上这份文件已经 404，
 * 演示页因此停在黑屏。这里按上游同一组内核 / 根文件系统参数启动离线客体，
 * 省掉失效的代理和额外的 Service Worker，也不让客体访问站点的登录态。
 */
const base = '/qemu-wasm/'
const $ = (id) => document.getElementById(id)
const startButton = $('start')
const status = $('status')
const terminalElement = $('terminal')

const messages = {
  'zh-Hans': { back: '← 返回游戏平台', title: 'Linux 模拟器', intro: '在浏览器里启动一台真正的 Alpine Linux 虚拟机。所有计算都在你的设备上完成。', start: '启动 Linux', starting: '正在启动…', restart: '重新启动', idle: '尚未启动', loading: '正在下载启动资源…', booting: 'Linux 正在开机…', running: 'Linux 已就绪', failed: '启动失败', isolation: '浏览器未开启跨源隔离，请通过本站 /linux 页面访问。', placeholder: '点击「启动 Linux」打开终端', loginTitle: '登录', loginNote: '看到 login: 后输入 root 并按回车。首次启动需下载约 140 MB，可能需要几分钟。', storageTitle: '临时环境', storageNote: '这是体验用虚拟机。刷新或关闭页面后，虚拟机里的更改不会保存。', networkTitle: '网络', networkNote: '当前镜像以离线模式运行；命令行与预装工具可用，虚拟机内不能联网。' },
  en: { back: '← Back to platforms', title: 'Linux emulator', intro: 'Boot a real Alpine Linux virtual machine in your browser. All computation runs on your device.', start: 'Start Linux', starting: 'Starting…', restart: 'Restart', idle: 'Not started', loading: 'Downloading boot files…', booting: 'Linux is booting…', running: 'Linux is ready', failed: 'Startup failed', isolation: 'Cross-origin isolation is unavailable. Open this page through /linux on 8BitGo.', placeholder: 'Select “Start Linux” to open the terminal', loginTitle: 'Sign in', loginNote: 'At the login: prompt, enter root and press Enter. The first boot downloads about 140 MB and may take several minutes.', storageTitle: 'Temporary environment', storageNote: 'This is a demo VM. Changes inside Linux are lost when you refresh or close this page.', networkTitle: 'Network', networkNote: 'This image runs offline. The shell and preinstalled tools work, but the VM has no network access.' },
}

const queryLang = new URLSearchParams(location.search).get('lang')
const lang = !queryLang || queryLang === 'zh-Hans' || queryLang === 'zh-Hant' ? 'zh-Hans' : 'en'
const m = messages[lang]
document.documentElement.lang = lang
document.title = `${m.title} · 8BitGo`
$('back').textContent = m.back
$('back').href = queryLang && queryLang !== 'zh-Hans' ? `/${encodeURIComponent(queryLang)}/platforms` : '/platforms'
for (const [id, key] of Object.entries({ title: 'title', intro: 'intro', start: 'start', status: 'idle', 'login-title': 'loginTitle', 'login-note': 'loginNote', 'storage-title': 'storageTitle', 'storage-note': 'storageNote', 'network-title': 'networkTitle', 'network-note': 'networkNote' })) {
  $(id).textContent = m[key]
}
$('placeholder').lastElementChild.textContent = m.placeholder
if (lang === 'en') {
  $('credit-qemu').textContent = 'Emulator based on '
  $('credit-image').textContent = '; Linux image based on the '
  $('demo-link').textContent = 'upstream Alpine demo'
  $('credit-end').textContent = '. '
  $('source-link').textContent = 'Source and licenses'
}

function loadScript(file) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = base + file
    script.onload = resolve
    script.onerror = () => reject(new Error(`无法加载 ${file}`))
    document.head.appendChild(script)
  })
}

let booting = false
let coreStarted = false
startButton.addEventListener('click', async () => {
  if (coreStarted) {
    location.reload()
    return
  }
  if (booting) return
  booting = true
  startButton.disabled = true
  startButton.textContent = m.starting
  status.textContent = m.loading

  try {
    // pthread / PTY 共用 SharedArrayBuffer；少了顶层 COOP + COEP 会在加载 WASM 后才隐晦地报错。
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error(m.isolation)

    await loadScript('xterm.js')
    await loadScript('xterm-pty.js')

    const term = new globalThis.Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 14, cols: 82, rows: 29, scrollback: 1500, theme: { background: '#050607', foreground: '#e5e7eb' } })
    terminalElement.replaceChildren()
    term.open(terminalElement)
    term.focus()
    const { master, slave } = globalThis.openpty()
    term.loadAddon(master)

    // 只有客体真正打印登录提示符才算可用；WASM 初始化完成时 Linux 仍在开机。
    let guestReady = false
    term.onWriteParsed(() => {
      if (guestReady) return
      const buffer = term.buffer.active
      const tail = Array.from({ length: Math.min(8, buffer.length) }, (_, index) => buffer.getLine(buffer.length - 1 - index)?.translateToString() || '').join('\n')
      if (/Kernel panic - not syncing/.test(tail)) {
        guestReady = true
        status.textContent = m.failed + ': kernel panic'
        status.classList.add('error')
      } else if (/login:\s*(?:\n|$)/.test(tail)) {
        guestReady = true
        status.textContent = m.running
      }
      if (guestReady) {
        startButton.disabled = false
        startButton.textContent = m.restart
      }
    })

    const Module = {
      arguments: [
        '-nographic', '-M', 'pc', '-m', '512M', '-accel', 'tcg,tb-size=500',
        '-L', '/pack-rom/', '-nic', 'none',
        '-kernel', '/pack-kernel/vmlinuz-virt',
        '-initrd', '/pack-initramfs/initramfs-virt',
        // 这版上游内核在 QEMU.wasm 的虚拟 IO-APIC 定时器检测中会 panic；跳过检测保留设备中断。
        '-append', 'console=ttyS0 root=/dev/vda noautodetect no_timer_check hostname=8bitgo',
        '-drive', 'id=root,file=/pack-rootfs/disk-rootfs.img,format=raw,if=none',
        '-device', 'virtio-blk-pci,drive=root',
      ],
      // Worker 单独换缓存键：曾经缓存过「缺 COEP 头」的脚本时，普通刷新仍会命中旧响应。
      locateFile: (file) => base + file + (file.endsWith('.worker.js') ? '?v=1' : ''),
      mainScriptUrlOrBlob: base + 'out.js',
      pty: slave,
      setStatus: (text) => { if (!coreStarted) status.textContent = text || m.loading },
      monitorRunDependencies: (left) => { if (!coreStarted && left > 0) status.textContent = `${m.loading} (${left})` },
      onRuntimeInitialized: () => { if (!coreStarted) status.textContent = m.starting },
      printErr: (message) => { console.error('[qemu-wasm]', message) },
      onAbort: (reason) => { status.textContent = `${m.failed}: ${reason}`; status.classList.add('error'); console.error('[qemu-wasm] abort:', reason) },
    }
    // Emscripten 的打包脚本在模块初始化前挂 preRun 钩子并并行拉取四份镜像；
    // 顺序颠倒会让虚拟文件系统缺盘，QEMU 只报模糊的 boot failure。
    globalThis.Module = Module
    for (const file of ['load-rootfs.js', 'load-kernel.js', 'load-initramfs.js', 'load-rom.js']) await loadScript(file)
    status.textContent = m.starting
    console.info('[qemu-wasm] 镜像加载脚本就绪，开始初始化核心')
    const { default: initQemu } = await import('./out.js')
    console.info('[qemu-wasm] 核心脚本就绪，等待 WebAssembly 初始化')
    await initQemu(Module)
    console.info('[qemu-wasm] 核心已启动')
    // 上游在初始化后修正 PTY 的 poll：没有键盘输入时直接返回可写状态，避免 QEMU 主循环卡住。
    const previousPoll = Module.TTY.stream_ops.poll
    Module.TTY.stream_ops.poll = function (stream, timeout) {
      if (!slave.readable) return (slave.readable ? 1 : 0) | (slave.writable ? 4 : 0)
      return previousPoll.call(stream, timeout)
    }
    coreStarted = true
    if (!guestReady) status.textContent = m.booting
  } catch (error) {
    status.textContent = `${m.failed}: ${error instanceof Error ? error.message : String(error)}`
    status.classList.add('error')
    startButton.disabled = false
    startButton.textContent = m.start
    booting = false
    console.error('[qemu-wasm]', error)
  }
})

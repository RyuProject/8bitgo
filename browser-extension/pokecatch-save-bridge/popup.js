const button = document.querySelector('#sync')
const status = document.querySelector('#status')
const extensionApi = globalThis.browser ?? globalThis.chrome

const validSave = (raw) => {
  try {
    const save = JSON.parse(raw)
    return save && Number.isInteger(save.v) && save.v > 0 && Array.isArray(save.mons) && save.mons.length <= 151
  } catch {
    return false
  }
}

button.addEventListener('click', async () => {
  button.disabled = true
  status.textContent = '正在读取 Pokecatch 游戏标签页…'
  try {
    const reply = await extensionApi.runtime.sendMessage({ type: 'pokecatch-read-embedded' })
    if (!reply?.ok) throw new Error(reply?.error || '读取游戏存档失败。')
    const raw = reply.raw
    if (!validSave(raw)) throw new Error('游戏存档格式无法识别。')
    const bytes = new TextEncoder().encode(raw)
    const url = new URL('/pokecatch-save-sync', reply.origin)
    if (bytes.byteLength <= 65536) {
      url.hash = `8bg-pokecatch=${encodeURIComponent(raw)}`
    } else {
      const stored = await extensionApi.runtime.sendMessage({ type: 'pokecatch-store-pending', raw })
      if (!stored?.ok) throw new Error(stored?.error || '暂存大文件失败。')
      url.searchParams.set('extensionUpload', '1')
    }
    await extensionApi.tabs.create({ url: url.href })
    status.textContent = bytes.byteLength <= 65536
      ? `已交给 8BitGo。登录后会自动保存；云端有不同进度时会先让你确认。`
      : `已交给 8BitGo。存档较大，请在打开的页面选择“上传并保存”。`
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    button.disabled = false
  }
})

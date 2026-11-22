import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { openAuthModal } from '@/services/authModal'
import { useAuthReady, useCurrentUser } from '@/services/auth'
import { useLang } from '@/services/lang'
import { useSeo } from '@/services/seo'
import { cloudSavesEnabled, fetchCloudSaveStrict, MAX_SAVE_BYTES, pushSave } from '@/services/saves'
import { downloadBlob } from '@/emulator/recorder'
import {
  POKECATCH_DIRECT_TRANSFER_MAX_BYTES,
  parsePokecatchSave,
  pokecatchAutoUploadAction,
  pokecatchGameImportUrl,
  pokecatchBookmarklet,
  readPokecatchTransferHash,
  POKECATCH_SAVE_FORMAT,
  POKECATCH_SAVE_RUNTIME,
  POKECATCH_SAVE_SLUG,
  POKECATCH_SAVE_SLOT,
} from '@/emulator/pokecatchCloudSave'

const ZH = {
  title: 'Pokecatch 存档同步',
  intro: '把 Pokecatch 当前浏览器里的进度备份到你的 8BitGo 账号，也可以从云端恢复到另一台设备。',
  why: '推荐安装 8BitGo 存档桥扩展：它只在 Pokecatch 游戏标签页读取或写回 gachamon-save-v1，再由当前登录的 8BitGo 页面同步云端。扩展不读取 Google / Discord 登录信息或游戏的其它存储。未安装扩展时，可用书签和 JSON 文件手动迁移。macOS Safari 18.4+ / iOS Safari 18+ 版还需要 Apple 签名的扩展 App，目前尚未发布。',
  steps: '使用步骤',
  step1: '在支持扩展的浏览器上安装 8BitGo PokeCatch 存档桥，并登录 8BitGo。扩展只申请 8BitGo 与 Pokecatch 两个网站的访问权限。macOS Safari 18.4+ / iOS Safari 18+ 版需等 Apple 签名的扩展 App 发布。',
  step2: '在 Pokecatch 游戏标签页点扩展按钮，再点“读取并同步当前进度”。云端空白会自动保存；云端已有不同进度时先确认。',
  step3: '另一台设备也安装扩展并登录同一个 8BitGo 账号。打开该设备的 Pokecatch 游戏标签页，再到本页点“恢复到游戏标签页”并确认。',
  bookmark: 'Pokecatch 存档同步书签',
  copy: '复制书签代码',
  upload: '上传并保存到 8BitGo 云端',
  download: '下载云端存档',
  openGame: '在 Pokecatch 中恢复',
  restoreEmbedded: '恢复到游戏标签页',
  choose: '选择存档 JSON 文件',
  login: '请先登录 8BitGo，再使用账号云存档。',
  loginButton: '登录 8BitGo',
  cloudNone: '这个账号还没有 Pokecatch 云存档。',
  cloudReadFailed: '暂时无法确认云端存档状态，读取恢复后再试；为防止覆盖旧档，上传已禁用。',
  cloudPresent: '云端进度：图鉴 {n} / 151 · 更新于 {date}',
  saveReady: '文件有效：图鉴 {n} / 151 · {size} KB',
  overwrite: '云端已有图鉴 {old} / 151 的存档。要用本机上传的图鉴 {next} / 151 覆盖吗？',
  overwriteUnknown: '云端这个存档位已有一份无法识别的存档。覆盖会替换它，确定继续吗？',
  replaceLocal: '恢复时会先备份游戏标签页当前的本机存档，再覆盖并重新加载。请确认选对了 8BitGo 云端存档。',
  bookmarkInstructions: 'Android Chrome 不支持 Chrome 扩展。Firefox for Android 可使用本扩展的兼容包，但需先由 Mozilla 签名。macOS Safari 18.4+ / iOS Safari 18+ 自动同步也需要 Apple 签名的扩展 App，目前尚未发布；Safari 可先用书签配合 JSON 文件手动迁移。若继续用 Android Chrome，可通过电脑远程调试手动救出存档一次，这不能自动同步。',
  uploadDone: '已保存到当前 8BitGo 账号的云存档。',
  alreadySynced: '这份进度已经在 8BitGo 云端，不需要重复上传。',
  bridgeReady: '已检测到存档桥扩展。可直接把云端进度写回当前打开的 Pokecatch 游戏标签页。',
  bridgeConfirm: '将把云端图鉴 {n} / 151 写入当前打开的 Pokecatch 游戏标签页。现有存档会先备份，然后刷新游戏。继续吗？',
  bridgeRestoreDone: '云端存档已写入并备份本机旧档，Pokecatch 游戏页面正在重新加载。',
  bridgeTimeout: '扩展没有响应。请确认扩展已启用，并重新打开 Pokecatch 游戏标签页。',
  cloudNeedsConfirm: '云端已有不同进度。请核对进度后，点击“上传并保存到 8BitGo 云端”并确认覆盖。',
  uploadCancelled: '没有覆盖云端进度；如要继续，请点击上传按钮并确认。',
  downloadDone: '已下载云端 JSON。回到 Pokecatch 游戏标签页，点“导入云端存档到 Pokecatch”书签并选择该文件。',
  needFile: '请先选择从 Pokecatch 导出的 JSON 文件。',
  fail: '操作失败：{message}',
  cloudLoading: '正在读取云端存档…',
  notJson: '文件内容不是有效的 Pokecatch 存档。',
  fileLarge: '存档超过 4 MB，未上传。',
  copyDone: '已复制。',
  uploadHint: '存档桥扩展会从 Pokecatch 游戏标签页读取进度；macOS Safari 18.4+ / iOS Safari 18+ 版需先发布 Apple 签名的扩展 App。Safari 和 Android Chrome 可用书签与 JSON 文件手动迁移。登录后云端空白会自动保存，已有不同进度仍需确认。',
  back: '返回游戏',
} as const

const EN = {
  title: 'Pokecatch Save Sync',
  intro: 'Back up Pokecatch progress from this browser to your 8BitGo account, then restore it on another device.',
  why: 'Recommended: install the 8BitGo Save Bridge extension. It reads or writes only gachamon-save-v1 in the Pokecatch game tab, then the signed-in 8BitGo page syncs it to your account. The extension never reads Google / Discord credentials or other game storage. Without the extension, use the bookmark and JSON file for manual transfer. macOS Safari 18.4+ / iOS Safari 18+ needs an Apple-signed extension app, which is not published yet.',
  steps: 'How it works',
  step1: 'Install the 8BitGo PokeCatch Save Bridge in a supported browser, then sign in to 8BitGo. It requests access only to 8BitGo and Pokecatch. macOS Safari 18.4+ / iOS Safari 18+ support requires an Apple-signed extension app, which is not published yet.',
  step2: 'On the Pokecatch game tab, click the extension and choose Read and sync current progress. An empty cloud slot saves automatically; different cloud progress requires confirmation.',
  step3: 'Install the extension on the other device and sign in to the same 8BitGo account. Open the Pokecatch game tab, return here, then choose Restore to game tab and confirm.',
  bookmark: 'Pokecatch Save Sync bookmark',
  copy: 'Copy bookmark code',
  upload: 'Upload to 8BitGo Cloud Saves',
  download: 'Download cloud save',
  openGame: 'Restore in Pokecatch',
  restoreEmbedded: 'Restore to game tab',
  choose: 'Choose save JSON file',
  login: 'Sign in to 8BitGo to use account cloud saves.',
  loginButton: 'Sign in to 8BitGo',
  cloudNone: 'This account has no Pokecatch cloud save yet.',
  cloudReadFailed: 'Could not verify the cloud save status. Try again later; uploads are disabled to protect an existing save.',
  cloudPresent: 'Cloud progress: {n} / 151 in the Pokédex · updated {date}',
  saveReady: 'Valid file: {n} / 151 in the Pokédex · {size} KB',
  overwrite: 'The cloud already has {old} / 151. Replace it with this local save at {next} / 151?',
  overwriteUnknown: 'This cloud slot already contains a save that is not recognized as Pokecatch JSON. Replacing it will overwrite that save. Continue?',
  replaceLocal: 'Restore first backs up the game tab’s current local save, then replaces it and reloads the game. Make sure you picked the intended cloud save.',
  bookmarkInstructions: 'Chrome on Android does not support Chrome extensions. Firefox for Android can use this extension’s compatible build after it is signed by Mozilla. macOS Safari 18.4+ / iOS Safari 18+ also needs an Apple-signed extension app, which is not published yet. Safari and Android Chrome can use the bookmark and JSON file to transfer a save manually.',
  uploadDone: 'Saved to the signed-in 8BitGo account.',
  alreadySynced: 'This progress is already in 8BitGo Cloud Saves; no upload was needed.',
  bridgeReady: 'The Save Bridge extension is connected. You can write cloud progress into the open Pokecatch game tab.',
  bridgeConfirm: 'Write the cloud save at {n} / 151 into the open Pokecatch game tab? Its current save will be backed up before the game reloads.',
  bridgeRestoreDone: 'Cloud progress was written and the old local save was backed up. Pokecatch is reloading.',
  bridgeTimeout: 'The extension did not respond. Make sure it is enabled, then reopen the Pokecatch game tab.',
  cloudNeedsConfirm: 'The cloud has different progress. Review it, then choose Upload and confirm before replacing it.',
  uploadCancelled: 'The cloud save was left unchanged. Choose Upload and confirm if you want to replace it.',
  downloadDone: 'Cloud JSON downloaded. On the Pokecatch tab, click the Save Sync bookmark and choose this file.',
  needFile: 'Choose the JSON file exported from Pokecatch first.',
  fail: 'Operation failed: {message}',
  cloudLoading: 'Loading cloud save…',
  notJson: 'This file is not a valid Pokecatch save.',
  fileLarge: 'The save is over 4 MB and was not uploaded.',
  copyDone: 'Copied.',
  uploadHint: 'The Save Bridge extension reads progress from the Pokecatch game tab. macOS Safari 18.4+ / iOS Safari 18+ support needs an Apple-signed extension app that is not published yet. Safari and Android Chrome can use the bookmark and JSON file for manual transfer. An empty cloud slot saves automatically after sign-in, while different cloud progress requires confirmation.',
  back: 'Back to game',
} as const

function format(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ''))
}

type CloudState = { loading: boolean; checked: boolean; exists: boolean; updatedAt: number | null; mons: number | null; raw: string | null; bridgeRaw: string | null }
type PendingSave = { raw: string; name: string; size: number; mons: number }

export function PokecatchSaveSyncPage() {
  const lang = useLang()
  const t = lang.startsWith('zh') ? ZH : EN
  const ready = useAuthReady()
  const user = useCurrentUser()
  useSeo({ title: t.title, noindex: true })

  const fileRef = useRef<HTMLInputElement>(null)
  const bridgeRestoreTimer = useRef<number | null>(null)
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null)
  const [autoUploadFromLink, setAutoUploadFromLink] = useState(false)
  const [bridgeAvailable, setBridgeAvailable] = useState(false)
  const [cloud, setCloud] = useState<CloudState>({ loading: false, checked: false, exists: false, updatedAt: null, mons: null, raw: null, bridgeRaw: null })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const onExtensionMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      const message = event.data as { source?: string; type?: string; raw?: unknown; ok?: boolean; error?: string }
      if (message?.source !== '8bitgo-pokecatch-extension') return
      if (message.type === 'bridge-ready') {
        setBridgeAvailable(true)
        return
      }
      if (message.type === 'embedded-save') {
        try {
          if (typeof message.raw !== 'string') throw new Error(t.notJson)
          const parsed = parsePokecatchSave(message.raw)
          const size = new TextEncoder().encode(message.raw).length
          if (size > MAX_SAVE_BYTES) throw new Error(t.fileLarge)
          setPendingSave({ raw: message.raw, name: 'Embedded Pokecatch save', size, mons: parsed.mons.length })
          setAutoUploadFromLink(true)
          setError('')
          window.postMessage({ source: '8bitgo-pokecatch-page', type: 'pending-save-received' }, window.location.origin)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : t.notJson)
        }
        return
      }
      if (message.type === 'restore-result') {
        if (bridgeRestoreTimer.current !== null) window.clearTimeout(bridgeRestoreTimer.current)
        bridgeRestoreTimer.current = null
        setBusy(false)
        if (message.ok) setMessage(t.bridgeRestoreDone)
        else setError(message.error || t.bridgeTimeout)
      }
    }
    window.addEventListener('message', onExtensionMessage)
    window.postMessage({ source: '8bitgo-pokecatch-page', type: 'ready' }, window.location.origin)
    return () => {
      window.removeEventListener('message', onExtensionMessage)
      if (bridgeRestoreTimer.current !== null) window.clearTimeout(bridgeRestoreTimer.current)
    }
  }, [t.bridgeRestoreDone, t.bridgeTimeout, t.fileLarge, t.notJson])

  useEffect(() => {
    let raw: string | null
    try {
      raw = readPokecatchTransferHash(window.location.hash)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.notJson)
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      return
    }
    if (raw === null) return
    // 存档只在 URL 片段里短暂传递；片段不会发给服务器，读出后马上清除浏览器历史中的副本。
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    try {
      const parsed = parsePokecatchSave(raw)
      const size = new TextEncoder().encode(raw).length
      if (size > MAX_SAVE_BYTES) throw new Error(t.fileLarge)
      setPendingSave({ raw, name: 'Pokecatch transfer', size, mons: parsed.mons.length })
      setAutoUploadFromLink(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.notJson)
    }
  }, [t.fileLarge, t.notJson])

  const refreshCloud = useCallback(async () => {
    if (!cloudSavesEnabled()) {
      setCloud({ loading: false, checked: false, exists: false, updatedAt: null, mons: null, raw: null, bridgeRaw: null })
      return
    }
    setCloud((current) => ({ ...current, loading: true, checked: false }))
    try {
      const saved = await fetchCloudSaveStrict(POKECATCH_SAVE_RUNTIME, POKECATCH_SAVE_SLUG, POKECATCH_SAVE_SLOT)
      if (!saved) {
        setCloud({ loading: false, checked: true, exists: false, updatedAt: null, mons: null, raw: null, bridgeRaw: null })
        return
      }
      try {
        const raw = new TextDecoder().decode(saved.data)
        const parsed = parsePokecatchSave(raw)
        const size = new TextEncoder().encode(raw).length
        setCloud({ loading: false, checked: true, exists: true, updatedAt: saved.updatedAt, mons: parsed.mons.length, raw: size <= POKECATCH_DIRECT_TRANSFER_MAX_BYTES ? raw : null, bridgeRaw: raw })
      } catch {
        // 坐标已存在但格式陌生时仍显示为“有档”，上传必须二次确认覆盖。
        setCloud({ loading: false, checked: true, exists: true, updatedAt: saved.updatedAt, mons: null, raw: null, bridgeRaw: null })
        setError(t.notJson)
      }
    } catch {
      setCloud({ loading: false, checked: false, exists: false, updatedAt: null, mons: null, raw: null, bridgeRaw: null })
      setError(t.cloudReadFailed)
    }
  }, [t.cloudReadFailed, t.notJson])

  useEffect(() => {
    if (ready && user) void refreshCloud()
  }, [ready, user, refreshCloud])

  const chooseFile = async (picked: File | undefined) => {
    setPendingSave(null)
    setMessage('')
    setError('')
    if (!picked) return
    if (picked.size > MAX_SAVE_BYTES) {
      setError(t.fileLarge)
      return
    }
    try {
      const raw = await picked.text()
      const parsed = parsePokecatchSave(raw)
      setPendingSave({ raw, name: picked.name, size: picked.size, mons: parsed.mons.length })
    } catch {
      setError(t.notJson)
    }
  }

  const upload = useCallback(async (automatic = false) => {
    if (!pendingSave) {
      setError(t.needFile)
      return
    }
    if (!cloudSavesEnabled()) {
      openAuthModal()
      return
    }
    if (!cloud.checked || cloud.loading) {
      setError(t.cloudReadFailed)
      return
    }
    if (automatic) {
      const action = pokecatchAutoUploadAction(cloud, pendingSave.raw)
      if (action === 'already-synced') {
        setMessage(t.alreadySynced)
        return
      }
      if (action === 'confirm-overwrite') {
        setMessage(t.cloudNeedsConfirm)
        return
      }
    } else if (cloud.exists) {
      const prompt = cloud.mons === null
        ? t.overwriteUnknown
        : format(t.overwrite, { old: cloud.mons, next: pendingSave.mons })
      if (!window.confirm(prompt)) {
        setMessage(t.uploadCancelled)
        return
      }
    }

    setBusy(true)
    setMessage('')
    setError('')
    try {
      const payload = new TextEncoder().encode(pendingSave.raw)
      const result = await pushSave(
        POKECATCH_SAVE_RUNTIME,
        POKECATCH_SAVE_SLUG,
        payload,
        POKECATCH_SAVE_SLOT,
        'cloud',
        { core: 'pokecatch-web', format: POKECATCH_SAVE_FORMAT },
      )
      if (result.where !== 'cloud') throw new Error(result.error || 'cloud upload failed')
      setMessage(t.uploadDone)
      await refreshCloud()
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(format(t.fail, { message: detail }))
    } finally {
      setBusy(false)
    }
  }, [cloud, pendingSave, refreshCloud, t.alreadySynced, t.cloudNeedsConfirm, t.cloudReadFailed, t.needFile, t.overwrite, t.overwriteUnknown, t.uploadCancelled, t.uploadDone])

  useEffect(() => {
    if (!autoUploadFromLink || !ready || !user || !cloud.checked || cloud.loading || busy) return
    setAutoUploadFromLink(false)
    void upload(true)
  }, [autoUploadFromLink, busy, cloud.checked, cloud.loading, ready, upload, user])

  const restoreEmbedded = () => {
    if (!cloud.bridgeRaw || !bridgeAvailable || busy) return
    if (!window.confirm(format(t.bridgeConfirm, { n: cloud.mons ?? 0 }))) return
    setBusy(true)
    setMessage('')
    setError('')
    window.postMessage({ source: '8bitgo-pokecatch-page', type: 'restore-embedded', raw: cloud.bridgeRaw }, window.location.origin)
    bridgeRestoreTimer.current = window.setTimeout(() => {
      bridgeRestoreTimer.current = null
      setBusy(false)
      setError(t.bridgeTimeout)
    }, 20_000)
  }

  const download = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const saved = await fetchCloudSaveStrict(POKECATCH_SAVE_RUNTIME, POKECATCH_SAVE_SLUG, POKECATCH_SAVE_SLOT)
      if (!saved) throw new Error('No cloud save found')
      parsePokecatchSave(new TextDecoder().decode(saved.data))
      downloadBlob(new Blob([saved.data as BlobPart], { type: 'application/json' }), 'pokecatch-save.json')
      setMessage(t.downloadDone)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(format(t.fail, { message: detail }))
    } finally {
      setBusy(false)
    }
  }

  const copyBookmark = async () => {
    setError('')
    setMessage('')
    try {
      await navigator.clipboard.writeText(pokecatchBookmarklet())
      setMessage(t.copyDone)
    } catch {
      setError(t.fail.replace('{message}', 'Clipboard unavailable'))
    }
  }

  const updated = cloud.updatedAt
    ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(cloud.updatedAt))
    : ''

  return (
    <main className="container-x max-w-3xl space-y-6 py-8 sm:py-12">
      <div>
        <Link to="/games/pokecatch" className="text-sm font-semibold text-brand-hover hover:underline">← {t.back}</Link>
        <h1 className="mt-3 text-2xl font-extrabold sm:text-3xl">{t.title}</h1>
        <p className="mt-2 text-sm text-muted">{t.intro}</p>
      </div>

      <section className="rounded-2xl border border-line bg-surface p-4 sm:p-6">
        <p className="text-sm leading-6 text-muted">{t.why}</p>
        <h2 className="mt-5 text-base font-extrabold">{t.steps}</h2>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-muted">
          <li>{t.step1}</li>
          <li>{t.step2}</li>
          <li>{t.step3}</li>
        </ol>
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs leading-5 text-muted">{t.bookmarkInstructions}</p>

        <div className="mt-4 max-w-md">
          <BookmarkCard
            label={t.bookmark}
            onCopy={() => void copyBookmark()}
            copyLabel={t.copy}
          />
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-surface p-4 sm:p-6">
        <h2 className="text-base font-extrabold">8BitGo {lang.startsWith('zh') ? '云存档' : 'Cloud Save'}</h2>
        {!ready ? (
          <p className="mt-2 text-sm text-muted">{t.cloudLoading}</p>
        ) : !user ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted">{t.login}</p>
            <Button size="sm" onClick={openAuthModal}>{t.loginButton}</Button>
          </div>
        ) : (
          <>
            <p className="mt-2 text-xs text-muted">
              {lang.startsWith('zh') ? '当前 8BitGo 账号：' : 'Signed in to 8BitGo as '}{user.nickname}
            </p>
            <p className="mt-2 text-sm text-muted">
              {cloud.loading
                ? t.cloudLoading
                : !cloud.exists
                  ? t.cloudNone
                  : cloud.mons === null
                    ? t.notJson
                    : format(t.cloudPresent, { n: cloud.mons, date: updated })}
            </p>
            <p className="mt-3 text-xs text-muted">{t.uploadHint}</p>
            {cloud.raw && (
              <a
                href={pokecatchGameImportUrl(cloud.raw)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                {t.openGame}
              </a>
            )}
            {bridgeAvailable && cloud.bridgeRaw && (
              <div className="mt-3">
                <p className="text-xs text-muted">{t.bridgeReady}</p>
                <Button className="mt-2" variant="secondary" disabled={busy} onClick={restoreEmbedded}>
                  {t.restoreEmbedded}
                </Button>
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={(event) => {
                  const picked = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  void chooseFile(picked)
                }}
              />
              <Button variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
                {t.choose}
              </Button>
              <Button disabled={busy || cloud.loading || !cloud.checked || !pendingSave} onClick={() => void upload()}>
                {busy ? t.cloudLoading : t.upload}
              </Button>
              <Button variant="secondary" disabled={busy || cloud.loading || !cloud.exists || cloud.mons === null} onClick={() => void download()}>
                {t.download}
              </Button>
            </div>
            {pendingSave && (
              <p className="mt-3 text-sm text-muted">
                {format(t.saveReady, { n: pendingSave.mons, size: Math.max(1, Math.round(pendingSave.size / 1024)) })}
                {' · '}{pendingSave.name}
              </p>
            )}
            <p className="mt-3 rounded-xl border border-coin/40 bg-coin-soft px-3 py-2 text-xs leading-5 text-muted">{t.replaceLocal}</p>
          </>
        )}
        {message && <p role="status" className="mt-3 rounded-xl bg-brand-soft px-3 py-2 text-sm text-fg">{message}</p>}
        {error && <p role="alert" className="mt-3 rounded-xl bg-live/10 px-3 py-2 text-sm text-live">{error}</p>}
      </section>
    </main>
  )
}

function BookmarkCard({ label, onCopy, copyLabel }: { label: string; onCopy: () => void; copyLabel: string }) {
  const bookmarkRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    // React 会拦截源码里直接写的 javascript: href；这里只设置固定、带域名校验的本站脚本。
    bookmarkRef.current?.setAttribute('href', pokecatchBookmarklet())
  }, [])

  return (
    <div className="flex min-h-24 flex-col justify-between gap-3 rounded-xl border border-line bg-surface-2 p-3">
      <a
        ref={bookmarkRef}
        href="#bookmarklet"
        draggable
        onClick={(event) => event.preventDefault()}
        className="self-start text-sm font-bold text-brand-hover underline underline-offset-2"
      >
        {label}
      </a>
      <Button size="sm" variant="secondary" className="self-start" onClick={onCopy}>{copyLabel}</Button>
    </div>
  )
}

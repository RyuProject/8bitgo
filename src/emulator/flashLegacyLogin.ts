/**
 * 老 Flash 有两条登录链：SDK 自己的按钮会调 ExternalInterface，但 SAS3 主 SWF 里的登录按钮
 * 直接 `navigateToURL("https://ninjakiwi.com/login")`，完全绕过 Banana。旧网址如今只会跳回
 * Ninja Kiwi 首页，所以在**这一局自己的 iframe**里把这次明确的玩家操作接回站内登录框。
 * Ruffle 版本之间实现不同：旧版调 window.open，新版创建 target=_blank 的 form 后直接 submit；
 * 两条都要接住。只匹配注册表逐款列出的 origin + pathname，其它外链仍交给 Ruffle 原样打开。
 */
export function installFlashLegacyLoginRedirect(
  win: Window,
  urls: string[],
  onLogin: () => void,
): () => void {
  if (!urls.length) return () => {}
  const normalized = new Set<string>()
  for (const raw of urls) {
    try {
      const url = new URL(raw, win.location.href)
      normalized.add(`${url.origin}${url.pathname.replace(/\/$/, '')}`)
    } catch {
      /* 注册表的单条坏地址不能影响同款游戏其余登录入口。 */
    }
  }
  if (!normalized.size) return () => {}

  const isLegacyLogin = (raw: unknown): boolean => {
    try {
      const parsed = new URL(String(raw || ''), win.location.href)
      const key = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`
      return normalized.has(key)
    } catch {
      return false
    }
  }

  const original = win.open
  const patched: typeof win.open = function(url, target, features) {
    if (isLegacyLogin(url)) {
      onLogin()
      return null
    }
    return original.call(win, url, target, features)
  }

  const FrameHTMLFormElement = (win as unknown as { HTMLFormElement?: typeof HTMLFormElement }).HTMLFormElement
  const formPrototype = FrameHTMLFormElement?.prototype
  const originalSubmit = formPrototype?.submit
  const patchedSubmit: typeof HTMLFormElement.prototype.submit = function(this: HTMLFormElement) {
    if (isLegacyLogin(this.action)) {
      onLogin()
      return
    }
    return originalSubmit?.call(this)
  }
  const onSubmit = (event: Event) => {
    const form = event.target
    if (!FrameHTMLFormElement || !(form instanceof FrameHTMLFormElement) || !isLegacyLogin(form.action)) return
    event.preventDefault()
    onLogin()
  }

  let openInstalled = false
  let submitInstalled = false
  let listenerInstalled = false
  try {
    win.open = patched
    openInstalled = true
  } catch {}
  try {
    if (formPrototype && typeof originalSubmit === 'function') {
      formPrototype.submit = patchedSubmit
      submitInstalled = true
    }
  } catch {}
  try {
    win.document.addEventListener('submit', onSubmit, true)
    listenerInstalled = true
  } catch {}

  return () => {
    try {
      if (openInstalled && win.open === patched) win.open = original
      if (submitInstalled && formPrototype?.submit === patchedSubmit && originalSubmit) {
        formPrototype.submit = originalSubmit
      }
      if (listenerInstalled) win.document.removeEventListener('submit', onSubmit, true)
    } catch {
      /* iframe 已销毁时不用恢复。 */
    }
  }
}

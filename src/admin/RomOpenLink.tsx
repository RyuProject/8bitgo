import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { alternateRomUrls, reachableRomAssetUrl } from '@/services/romHosts'

type RomOpenLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'rel' | 'target'> & {
  href: string
}

/** 后台打开 ROM 时，按玩家所在网络实际读到的速度挑同一对象的最快域名。 */
export function RomOpenLink({ href, ...props }: RomOpenLinkProps) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // 中键和带修饰键的点击要保留浏览器原生行为；自定义外链没有本站备用域，也不多发探测请求。
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const targetUrl = event.currentTarget.href
    if (alternateRomUrls(targetUrl).length === 0) return

    // 先在用户手势同步阶段开空白页，避免等测速完成后才开新窗口被浏览器拦截。
    const tab = window.open('about:blank', '_blank')
    if (!tab) return
    event.preventDefault()

    try {
      tab.opener = null
      // 旧链接带 noreferrer；中间空白页也要保持不向 ROM 域泄露后台地址。
      tab.document.open()
      tab.document.write(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>正在选择下载线路</title></head><body style="margin:0;padding:32px;background:#111;color:#eee;font:16px system-ui,sans-serif">正在比较下载线路…</body></html>',
      )
      tab.document.close()
    } catch {
      /* 浏览器禁止写入空白页时仍继续导航，不让测速结果影响文件可打开性。 */
    }

    // 小样本足以识别几 KB/s 的慢线，同时避免为了打开小 BIOS 多取几十 KB。
    void reachableRomAssetUrl(targetUrl, undefined, {
      sampleBytes: 8 * 1024,
      hedgeDelayMs: 600,
      attemptTimeoutMs: 4_500,
      forceProbe: true,
    }).then((route) => {
      if (!tab.closed) tab.location.replace(route || targetUrl)
    }).catch(() => {
      if (!tab.closed) tab.location.replace(targetUrl)
    })
  }

  return <a {...props} href={href} target="_blank" rel="noreferrer" onClick={onClick} />
}

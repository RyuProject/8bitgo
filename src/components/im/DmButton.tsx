import { useState } from 'react'
import { cx } from '@/lib/format'
import { useT } from '@/services/i18n'
import { useAuthReady, useCurrentUser } from '@/services/auth'
import { requestImDm } from '@/services/imClient'

/**
 * 「给这个人发私信」的入口 —— 包在别人的头像上。
 *
 * ## 为什么做成「包头像」而不是加一颗按钮
 *
 * 评论那一行已经很挤了（昵称、国旗、时间、编辑过、评分、回复、删除），再塞一颗
 * 「私信」按钮会把这一行挤到换行。头像本来就在那儿、本来就代表这个人，
 * 而且点头像发私信是个到处都有的约定 —— locale 里的 emptyHint 就是这么写的。
 *
 * ## 什么时候不给这个入口
 *
 * 三种情况直接退回一个普通的 span（长得和原来一模一样）：
 *   1. 没登录 —— 私信要有身份，弹登录框反而打断他读评论
 *   2. 点的是自己 —— 给自己发私信没有意义
 *   3. 没有对方的 id —— 引用块里那种只有昵称的场合
 *
 * 退回普通 span 而不是禁用按钮：一颗灰掉的按钮看着像坏了，
 * 而这三种情况下这个功能本来就不该存在。
 *
 * ## 点下去可能要等一下
 *
 * 第一次点会触发「拉 sig → 下 SDK → 登录腾讯」，几百毫秒到一两秒。
 * 所以点下去立刻进 busy 状态（头像转一下），不然用户会以为没反应又点几次
 * —— requestImDm 本身是幂等的，但连点会让人以为坏了。
 */
export function DmAvatar({
  peerId,
  nick,
  avatar,
  className,
}: {
  peerId: string
  nick: string
  avatar: string
  className: string
}) {
  const t = useT()
  const me = useCurrentUser()
  /*
    等登录态确定再决定长什么样。

    useCurrentUser 的 SSR / 首帧快照恒为 null（见 services/auth.ts），只看 me 的话
    这里会经历 null -> 缓存里的用户 -> hydrateAuth 落地的用户，**两次**切换，
    每次都是 span 和 button 之间换节点（正在悬停/聚焦的会被打断）。
    等 authReady 之后只切一次。

    ⚠️ 这一次切换消不掉：服务端不知道访客是谁，头像是不是私信入口只能等到浏览器里
    才知道。所以两种形态的 className 必须完全一致，否则会有布局跳动。
  */
  const authReady = useAuthReady()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const canDm = authReady && Boolean(me && peerId && peerId !== me.id)

  if (!canDm) {
    return (
      <span className={className} aria-hidden>
        {avatar}
      </span>
    )
  }

  const label = failed ? t.im.dmUnavailable : `${t.im.dm} · ${nick || peerId}`

  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        setFailed(false)
        try {
          // false = 没登录 / 后端没配 IM / 连接失败。三种都不弹错误框：
          // 把 title 换成「暂时用不了」就够了，为一个次要入口弹全站模态框太重。
          if (!(await requestImDm({ peerId, nick, avatar }))) setFailed(true)
        } finally {
          setBusy(false)
        }
      }}
      className={cx(
        className,
        'transition hover:ring-2 hover:ring-brand/60 focus-visible:ring-2 focus-visible:ring-brand',
        busy && 'animate-pulse',
      )}
    >
      {avatar}
    </button>
  )
}

import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthReady, useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'
import { useSeo } from '@/services/seo'
import { useT } from '@/services/i18n'

/**
 * /login 现在只负责打开全站登录弹窗，然后把用户带回首页。
 * 已登录则直接去个人中心。保留此路由是为了兼容旧链接 / 书签。
 *
 * 注意两点：
 * 1. 必须等 useAuthReady() 为 true 再决定 —— hydration 首帧的 user 恒为 null，
 *    直接判断会让已登录用户被弹一次登录框、并且被送去首页而不是 /me。
 * 2. 这个页面也要调 useSeo：它是全站唯一没调的页面，而 SSR 会把模板里的默认
 *    title/robots 删掉再插入本页收集到的那份 —— 不调就等于输出一个空 <title>、
 *    没有 canonical、也没有 noindex。
 */
export function LoginPage() {
  const user = useCurrentUser()
  const ready = useAuthReady()
  const t = useT()

  useSeo({ title: t.auth.title, noindex: true })

  useEffect(() => {
    if (ready && !user) openAuthModal()
  }, [ready, user])

  if (!ready) return null
  return <Navigate to={user ? '/me' : '/'} replace />
}

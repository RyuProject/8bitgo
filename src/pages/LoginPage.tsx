import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useCurrentUser } from '@/services/auth'
import { openAuthModal } from '@/services/authModal'

/**
 * /login 现在只负责打开全站登录弹窗，然后把用户带回首页。
 * 已登录则直接去个人中心。保留此路由是为了兼容旧链接 / 书签。
 */
export function LoginPage() {
  const user = useCurrentUser()

  useEffect(() => {
    if (!user) openAuthModal()
  }, [user])

  return <Navigate to={user ? '/me' : '/'} replace />
}

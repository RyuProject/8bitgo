import { BrowserRouter } from 'react-router-dom'
import { AppRoutes } from './AppRoutes'

/**
 * 浏览器端的应用外壳。
 *
 * basename 承载语言前缀：英文页面下 basename='/en'，于是全站现有的
 * <Link to="/games"> 会自动指向 /en/games —— 不需要逐个改链接。
 * 默认语言（简体中文）没有前缀，basename 为 '/'。
 */
export default function App({ basename }: { basename?: string }) {
  return (
    <BrowserRouter basename={basename || '/'}>
      <AppRoutes />
    </BrowserRouter>
  )
}

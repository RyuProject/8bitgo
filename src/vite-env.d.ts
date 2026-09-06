/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EJS_PATH?: string
  readonly VITE_RUFFLE_PATH?: string
  readonly VITE_J2ME_PATH?: string
  readonly VITE_CLOUDGAME_URL?: string
  readonly VITE_CLOUDGAME_ZONE?: string
  readonly VITE_API_URL?: string
  readonly VITE_NETPLAY_URL?: string
  readonly VITE_NETPLAY_ICE?: string
  readonly VITE_CLOUDGAME_URL?: string
  readonly VITE_CLOUDGAME_ZONE?: string
  readonly VITE_API_URL?: string
  readonly VITE_NETPLAY_URL?: string
  readonly VITE_CLOUDGAME_URL?: string
  readonly VITE_CLOUDGAME_ZONE?: string
  readonly VITE_API_URL?: string
  readonly VITE_SITE_NAME?: string
  readonly VITE_CONTACT_EMAIL?: string
  readonly VITE_SITE_URL?: string
  /** 官方 X / Twitter 账号（@开头）。没有就留空，twitter:site 会整条不输出 */
  readonly VITE_TWITTER_SITE?: string
  readonly VITE_ROM_BASE_URL?: string
  readonly VITE_ROM_API_URL?: string
  readonly VITE_ROM_PREFIX?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

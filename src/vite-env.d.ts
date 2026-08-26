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
  readonly VITE_SITE_URL?: string
  readonly VITE_ADMIN_KEY?: string
  readonly VITE_ROM_BASE_URL?: string
  readonly VITE_ROM_API_URL?: string
  readonly VITE_ROM_PREFIX?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

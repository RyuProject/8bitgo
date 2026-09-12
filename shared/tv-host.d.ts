export declare const TV_SUBDOMAIN: string
export declare const TV_ROUTE: string
export declare function tvHostOf(siteHostname: string): string
export declare function isTvHost(hostname: string, siteHostname: string): boolean
export declare function splitLangPath(pathname: string): { lang: string; rest: string }
export declare function joinLangPath(lang: string, rest: string): string
export declare function tvRedirect(input: {
  hostname: string
  pathname: string
  siteOrigin: string
}): { origin: string; path: string } | null
export declare function tvRenderPath(input: {
  hostname: string
  pathname: string
  siteOrigin: string
}): string | null

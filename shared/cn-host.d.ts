export const CN_SUBDOMAIN: string
export const CN_SITE_HEADER: string
export const CN_SITE_ATTR: string
export function isCnHost(hostname: string, siteHostname: string): boolean
export function isCnRequest(input: { hostname: string; siteHostname: string; siteHeader?: string | string[] }): boolean

export const COVER_CDN_QUERY: string
export const COVER_CDN_META: string
export function coverCdnHint(input?: {
  cnSite?: boolean
  queryValue?: string
  country?: string | string[]
}): 'cn' | 'main' | ''
export function stripCoverCdnQuery(rawUrl: string): { url: string; value: string }

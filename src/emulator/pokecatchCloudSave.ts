/**
 * Pokecatch 是第三方跨源 HTML5 游戏，本站 iframe 不能读取它的 localStorage。
 * 这份专用格式只搬运游戏自己的进度键，不碰同源下的账号令牌或其它站点数据。
 */
export const POKECATCH_SAVE_RUNTIME = 'html5' as const
export const POKECATCH_SAVE_SLUG = 'pokecatch'
export const POKECATCH_SAVE_SLOT = 0
export const POKECATCH_SAVE_KEY = 'gachamon-save-v1'
export const POKECATCH_SAVE_FORMAT = 'gachamon-save-v1'
export const POKECATCH_SAVE_HOSTS = ['pokecatch-online.netlify.app'] as const
export const POKECATCH_TRANSFER_HASH = '#8bg-pokecatch='
/** URL 片段只用于小档直达；大档仍走文件，避免移动浏览器截断长链接。 */
export const POKECATCH_DIRECT_TRANSFER_MAX_BYTES = 64 * 1024

export interface PokecatchSave {
  v: number
  mons: unknown[]
  [key: string]: unknown
}

export function parsePokecatchSave(raw: string): PokecatchSave {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('这不是有效的 Pokecatch 存档 JSON。')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Number.isInteger((parsed as PokecatchSave).v) ||
    (parsed as PokecatchSave).v < 1 ||
    !Array.isArray((parsed as PokecatchSave).mons) ||
    (parsed as PokecatchSave).mons.length > 151
  ) {
    throw new Error('存档结构不匹配：需要包含版本号和图鉴进度的 Pokecatch 存档。')
  }
  return parsed as PokecatchSave
}

/** 哈希片段不会随 HTTP 请求发送；页面读出后应立即清掉地址栏中的存档内容。 */
export function readPokecatchTransferHash(hash: string): string | null {
  if (!hash.startsWith(POKECATCH_TRANSFER_HASH)) return null
  try {
    return decodeURIComponent(hash.slice(POKECATCH_TRANSFER_HASH.length))
  } catch {
    throw new Error('存档传递链接已损坏。')
  }
}

export function pokecatchCloudImportUrl(raw: string, origin = 'https://8bitgo.com'): string {
  return `${origin}/pokecatch-save-sync${POKECATCH_TRANSFER_HASH}${encodeURIComponent(raw)}`
}

export function pokecatchGameImportUrl(raw: string): string {
  return `https://${POKECATCH_SAVE_HOSTS[0]}/${POKECATCH_TRANSFER_HASH}${encodeURIComponent(raw)}`
}

/** 自动交接只在云端没有旧档时写入；冲突必须留给玩家确认。 */
export function pokecatchAutoUploadAction(cloud: { exists: boolean; raw: string | null }, incoming: string): 'upload' | 'already-synced' | 'confirm-overwrite' {
  if (!cloud.exists) return 'upload'
  if (cloud.raw !== null && cloud.raw === incoming) return 'already-synced'
  return 'confirm-overwrite'
}

/** 一枚书签同时负责导出和导入，只在游戏精确域名读写进度键。 */
export function pokecatchBookmarklet(): string {
  const host = JSON.stringify(POKECATCH_SAVE_HOSTS[0])
  const key = JSON.stringify(POKECATCH_SAVE_KEY)
  const backupKey = JSON.stringify('8bitgo.pokecatch.backup.v1')
  const code = `(()=>{if(location.hostname!==${host}){alert("请在 Pokecatch 游戏标签页运行此书签。");return}const key=${key},prefix="#8bg-pokecatch=",valid=x=>{try{const s=JSON.parse(x);return s&&Number.isInteger(s.v)&&s.v>0&&Array.isArray(s.mons)&&s.mons.length<=151?s:null}catch{return null}},apply=r=>{const s=valid(r);if(!s){alert("这不是有效的 Pokecatch 存档。");return}if(!confirm("将用图鉴 "+s.mons.length+" / 151 的存档覆盖本机进度。继续吗？"))return;try{const old=localStorage.getItem(key);if(old)localStorage.setItem(${backupKey},old);localStorage.setItem(key,r);alert("已导入并备份原进度，即将重新加载游戏。");location.reload()}catch{alert("浏览器存储空间不足，未能导入。")}};if(location.hash.startsWith(prefix)){let r;try{r=decodeURIComponent(location.hash.slice(prefix.length))}catch{alert("存档传递链接已损坏，未导入。");return}history.replaceState(null,"",location.pathname+location.search);apply(r);return}const r=localStorage.getItem(key),s=r&&valid(r);if(!s){alert("找不到有效的 Pokecatch 本机存档。");return}const box=document.createElement("div");box.style.cssText="position:fixed;z-index:2147483647;inset:12px 12px auto;padding:16px;background:#fff;color:#111;border:2px solid #444;border-radius:12px;font:16px sans-serif;box-shadow:0 4px 24px #0008";const close=document.createElement("button");close.textContent="×";close.onclick=()=>box.remove();box.append(close);const p=document.createElement("p");p.textContent="Pokecatch 图鉴 "+s.mons.length+" / 151。选择同步或恢复方式：";box.append(p);const b=new TextEncoder().encode(r);if(b.length<=65536){const a=document.createElement("a");a.href="https://8bitgo.com/pokecatch-save-sync#8bg-pokecatch="+encodeURIComponent(r);a.target="_blank";a.rel="noopener";a.textContent="打开 8BitGo 同步页面";a.style.cssText="display:block;padding:12px;background:#2563eb;color:white;border-radius:8px;text-align:center";box.append(a)}else{const p2=document.createElement("p");p2.textContent="存档较大，请下载文件后在 8BitGo 页面上传。";box.append(p2)}const d=document.createElement("a");d.href=URL.createObjectURL(new Blob([r],{type:"application/json"}));d.download="pokecatch-save.json";d.textContent="下载本机存档 JSON";d.style.cssText="display:block;margin-top:12px";box.append(d);const i=document.createElement("input");i.type="file";i.accept=".json,application/json";i.style.display="none";i.onchange=()=>{const f=i.files&&i.files[0];if(!f)return i.remove();if(f.size>4194304){i.remove();alert("存档超过 4 MB，未导入。");return}const reader=new FileReader();reader.onload=()=>{i.remove();apply(String(reader.result||""))};reader.onerror=()=>{i.remove();alert("读取文件失败，未导入。")};reader.readAsText(f)};const pick=document.createElement("button");pick.textContent="从 JSON 文件恢复";pick.style.cssText="display:block;margin-top:12px";pick.onclick=()=>i.click();box.append(pick,i);document.body.append(box)})()`
  return `javascript:${code}`
}

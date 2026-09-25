import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.js'
import { Bucket, environment, req, count, bytes, streamChunks } from './fixtures.mjs'

for (const method of ['PUT','POST','DELETE']) test(`${method}: unauthorized writes are rejected`, async () => {
  const e = environment(); const r = await worker.fetch(req('/game.zip', method), e); assert.equal(r.status,401); assert.equal(e.ROMS.calls.length,0)
})
test('invalid URL percent encoding returns CORS JSON 400, not uncaught URIError', async () => {
  const r = await worker.fetch(req('/%E0%A4%A'), environment()); assert.equal(r.status,400); assert.equal(r.headers.get('Access-Control-Allow-Origin'),'*')
})
test('unknown R2 failures return sanitized 503 with CORS and no-store', async () => {
  const e=environment(); e.ROMS.fail.get=Error('internal secret backend URL'); const r=await worker.fetch(req('/a'),e)
  assert.equal(r.status,503); assert.equal((await r.text()).includes('secret'),false); assert.equal(r.headers.get('Cache-Control'),'no-store')
})
test('key length uses UTF-8 byte length, not JS characters', async () => {
  const e=environment(); const r=await worker.fetch(req('/'+encodeURIComponent('中'.repeat(342)), 'PUT','x',{},true),e)
  assert.equal(r.status,404); assert.equal(count(e.ROMS,'put'),0)
})
test('internal upload markers cannot be read as objects', async () => {
  const e=environment(); e.ROMS.seed('_uploads/a.marker'); assert.equal((await worker.fetch(req('/_uploads/a.marker'),e)).status,404)
})
test('plain GET streams in one R2 call and uses the short unversioned policy', async () => {
  const e=environment(); e.ROMS.seed('a.zip','abcdef'); const r=await worker.fetch(req('/a.zip'),e)
  assert.equal(await r.text(),'abcdef'); assert.equal(count(e.ROMS,'get'),1); assert.equal(count(e.ROMS,'head'),0)
  assert.equal(r.headers.get('Content-Length'),'6'); assert.equal(r.headers.get('Cache-Control'),'public, max-age=300, s-maxage=600, must-revalidate')
})
test('CS1.5 and CS1.6 assets prefer WEBGAMES and fall back to the legacy ROMS bucket', async () => {
  const e=environment(); e.WEBGAMES=new Bucket('webgames')
  e.ROMS.seed('web/cs15/packs/index.json','legacy-cs15')
  e.WEBGAMES.seed('web/cs15/packs/index.json','webgames-cs15')
  e.WEBGAMES.seed('web/cs16/zstd-v1/catalog.json','webgames-cs16')
  e.ROMS.seed('web/cs16/zstd-v1/fallback.json','legacy-cs16')

  assert.equal(await (await worker.fetch(req('/web/cs15/packs/index.json'),e)).text(),'webgames-cs15')
  assert.equal(await (await worker.fetch(req('/web/cs16/zstd-v1/catalog.json'),e)).text(),'webgames-cs16')
  assert.equal(await (await worker.fetch(req('/web/cs16/zstd-v1/fallback.json'),e)).text(),'legacy-cs16')
  assert.equal(count(e.WEBGAMES,'get'),3)
  assert.equal(count(e.ROMS,'get'),1)
})
test('a Worker deployment without WEBGAMES keeps serving legacy CS assets', async () => {
  const e=environment(); e.ROMS.seed('web/cs16/zstd-v1/catalog.json','legacy')
  assert.equal(await (await worker.fetch(req('/web/cs16/zstd-v1/catalog.json'),e)).text(),'legacy')
  assert.equal(count(e.ROMS,'get'),1)
})
/*
  缓存分两档的判据是 **URL 有没有版本戳**，不是 key —— 见 src/index.js 顶部那段。
    ROM：播放地址由 probeRomUrl 拼上 ?romv=<etag>，内容换了 URL 就换 → 敢给长 TTL
    封面/视频/logo：没有版本戳，后台替换时又故意复用同一个 key → 只能短缓存，
      否则「换了封面，玩家半个月看到的还是旧图」
*/
test('versioned URL gets the long-lived policy, unversioned does not', async () => {
  const e=environment(); e.ROMS.seed('a.zip','abcdef')
  const versioned=await worker.fetch(req('/a.zip?romv=deadbeef'),e)
  assert.equal(versioned.headers.get('Cache-Control'),'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400')
  const covers=environment(); covers.ROMS.seed('covers/g.webp','x')
  const plain=await worker.fetch(req('/covers/g.webp'),covers)
  assert.equal(plain.headers.get('Cache-Control'),'public, max-age=300, s-maxage=600, must-revalidate')
})
test('versioned public GET is stored in edge cache without blocking the response path', async () => {
  const previous = globalThis.caches
  let stored
  let matches = 0
  let puts = 0
  const waits = []
  globalThis.caches = { default: {
    async match() { matches += 1; return stored?.clone() },
    async put(_request, response) { puts += 1; stored = response.clone(); await response.arrayBuffer() },
  } }
  const context = { waitUntil(promise) { waits.push(promise) } }
  try {
    const e = environment(); e.ROMS.seed('a.zip', 'abcdef')
    const first = await worker.fetch(req('/a.zip?romv=etag-1'), e, context)
    assert.equal(first.headers.get('X-8BitGo-Edge-Cache'), 'MISS')
    assert.equal(await first.text(), 'abcdef')
    await Promise.all(waits)
    assert.equal(puts, 1)
    assert.equal(count(e.ROMS, 'get'), 1)

    const second = await worker.fetch(req('/a.zip?romv=etag-1'), e, context)
    assert.equal(second.headers.get('X-8BitGo-Edge-Cache'), 'HIT')
    assert.equal(await second.text(), 'abcdef')
    assert.equal(count(e.ROMS, 'get'), 1)
    assert.equal(matches, 2)
  } finally {
    if (previous === undefined) delete globalThis.caches
    else globalThis.caches = previous
  }
})
test('unversioned objects and reflected CORS responses bypass edge cache', async () => {
  const previous = globalThis.caches
  let calls = 0
  globalThis.caches = { default: {
    async match() { calls += 1 },
    async put() { calls += 1 },
  } }
  const context = { waitUntil() { throw new Error('unversioned request must not schedule cache writes') } }
  try {
    const plain = environment(); plain.ROMS.seed('a.zip', 'plain')
    assert.equal(await (await worker.fetch(req('/a.zip'), plain, context)).text(), 'plain')
    const restricted = environment(); restricted.ALLOWED_ORIGINS = 'https://site.test'; restricted.ROMS.seed('a.zip', 'private-cors')
    const request = req('/a.zip?romv=1', 'GET', undefined, { Origin: 'https://site.test' })
    assert.equal(await (await worker.fetch(request, restricted, context)).text(), 'private-cors')
    assert.equal(calls, 0)
  } finally {
    if (previous === undefined) delete globalThis.caches
    else globalThis.caches = previous
  }
})
test('edge cache failure falls back to R2 instead of taking ROM downloads down', async () => {
  const previous = globalThis.caches
  globalThis.caches = { default: {
    async match() { throw new Error('temporary cache outage') },
    async put() { throw new Error('must not store after a failed lookup') },
  } }
  try {
    const e = environment(); e.ROMS.seed('a.zip', 'from-r2')
    const r = await worker.fetch(req('/a.zip?romv=1'), e, { waitUntil() {} })
    assert.equal(r.status, 200)
    assert.equal(await r.text(), 'from-r2')
    assert.equal(count(e.ROMS, 'get'), 1)
  } finally {
    if (previous === undefined) delete globalThis.caches
    else globalThis.caches = previous
  }
})
test('content-addressed CS16 Zstd shards are immutable and use the Zstd MIME type', async () => {
  const e=environment(); const hash='a'.repeat(64); const key=`web/cs16/zstd-v1/chunks/${hash}.zst`; e.ROMS.seed(key,'frame')
  const r=await worker.fetch(req(`/${key}?v=${hash}`),e)
  assert.equal(r.headers.get('Cache-Control'),'public, max-age=31536000, s-maxage=31536000, immutable')
  assert.equal(r.headers.get('Content-Type'),'application/zstd')
})
test('cache policy is overridable per class without a code change', async () => {
  const e=environment(); e.ROMS.seed('a.zip','abcdef')
  e.OBJECT_CACHE_CONTROL='public, max-age=60'; e.VERSIONED_CACHE_CONTROL='public, max-age=600'
  assert.equal((await worker.fetch(req('/a.zip'),e)).headers.get('Cache-Control'),'public, max-age=60')
  assert.equal((await worker.fetch(req('/a.zip?romv=1'),e)).headers.get('Cache-Control'),'public, max-age=600')
})
test('uploads record the revalidating policy in object metadata', async () => {
  const e=environment(); await worker.fetch(req('/a.zip','PUT','abcdef',{},true),e)
  assert.equal(e.ROMS.objects.get('a.zip').httpMetadata.cacheControl,'public, max-age=300, s-maxage=600, must-revalidate')
})
test('a newline in the cache configuration is rejected, never echoed into a header', async () => {
  const e=environment(); e.ROMS.seed('a.zip','abcdef'); e.OBJECT_CACHE_CONTROL='public, max-age=60\r\nX-Injected: 1'
  const r=await worker.fetch(req('/a.zip'),e)
  assert.equal(r.status,500); assert.equal(r.headers.get('X-Injected'),null)
})
test('legacy cover fallback and thumbnail fallback remain', async () => {
  const e=environment(); e.ROMS.seed('covers/game.webp','old'); const r=await worker.fetch(req('/covers/game-96.webp'),e)
  assert.equal(await r.text(),'old'); assert.equal(r.headers.get('Content-Type'),'image/webp')
})
test('COVERS copy has read priority', async () => {
  const e=environment(); e.ROMS.seed('covers/g.webp','old'); e.COVERS.seed('covers/g.webp','new'); assert.equal(await (await worker.fetch(req('/covers/g.webp'),e)).text(),'new')
})
test('HEAD never returns a body and ignores Range', async () => {
  const e=environment(); e.ROMS.seed('a','abcdef'); const r=await worker.fetch(req('/a','HEAD',undefined,{Range:'bytes=2-3'}),e)
  assert.equal(r.status,200); assert.equal(r.body,null); assert.equal(r.headers.get('Content-Length'),'6'); assert.equal(count(e.ROMS,'get'),0)
})
test('HEAD errors and ping have no body', async () => {
  const e=environment(); for(const path of ['/missing','/ping','/%GG']) assert.equal((await worker.fetch(req(path,'HEAD'),e)).body,null)
})
for(const [range,status,body,cr] of [
  ['bytes=1-3',206,'bcd','bytes 1-3/6'],['bytes=-2',206,'ef','bytes 4-5/6'],
  ['bytes=4-',206,'ef','bytes 4-5/6'],['bytes=4-99',206,'ef','bytes 4-5/6'],
  ['bytes=-99',206,'abcdef','bytes 0-5/6'],['bytes=6-',416,'','bytes */6'],
  ['bytes=-0',416,'','bytes */6'],['bytes=4-2',416,'','bytes */6'],
  ['bytes=0-1,3-4',200,'abcdef',null],['bytes=garbage',200,'abcdef',null],
]) test(`Range ${range}: ${status} and correct byte count`,async()=>{
  const e=environment();e.ROMS.seed('a','abcdef');const r=await worker.fetch(req('/a','GET',undefined,{Range:range}),e)
  assert.equal(r.status,status);assert.equal(await r.text(),body);assert.equal(r.headers.get('Content-Range'),cr)
  if(status===206)assert.equal(r.headers.get('Content-Length'),String(body.length))
})
test('If-Range mismatch returns complete NEW object, never partial mixed download',async()=>{
  const e=environment();e.ROMS.seed('a','new-content');const r=await worker.fetch(req('/a','GET',undefined,{Range:'bytes=4-','If-Range':'"old-etag"'}),e)
  assert.equal(r.status,200);assert.equal(await r.text(),'new-content')
})
test('If-Range strong ETag retains ranges; weak/date validators use full object',async()=>{
  const e=environment();const o=e.ROMS.seed('a','abcdef')
  assert.equal((await worker.fetch(req('/a','GET',undefined,{Range:'bytes=1-2','If-Range':o.httpEtag}),e)).status,206)
  assert.equal((await worker.fetch(req('/a','GET',undefined,{Range:'bytes=1-2','If-Range':o.uploaded.toUTCString()}),e)).status,200)
  assert.equal((await worker.fetch(req('/a','GET',undefined,{Range:'bytes=1-2','If-Range':'W/'+o.httpEtag}),e)).status,200)
})
test('If-Match mismatch is 412, not 304',async()=>{
  const e=environment();e.ROMS.seed('a');const r=await worker.fetch(req('/a','GET',undefined,{'If-Match':'"wrong"'}),e);assert.equal(r.status,412);assert.equal(count(e.ROMS,'get'),0)
})
test('Range romv pins the R2 object generation even for clients without If-Match',async()=>{
  const e=environment();const o=e.ROMS.seed('disc.chd','abcdef')
  const good=await worker.fetch(req(`/disc.chd?romv=${o.etag}`,'GET',undefined,{Range:'bytes=0-1'}),e)
  assert.equal(good.status,206);assert.equal(await good.text(),'ab')
  e.ROMS.seed('disc.chd','new-content')
  const stale=await worker.fetch(req(`/disc.chd?romv=${o.etag}`,'GET',undefined,{Range:'bytes=0-1'}),e)
  assert.equal(stale.status,412);assert.equal(stale.body,null)
})
test('Range requests bypass full-object edge cache and always reach version validation',async()=>{
  const previous=globalThis.caches;let calls=0
  globalThis.caches={default:{async match(){calls++;return new Response('wrong-full-object')},async put(){calls++}}}
  try{
    const e=environment();const o=e.ROMS.seed('disc.chd','abcdef')
    const r=await worker.fetch(req(`/disc.chd?romv=${o.etag}`,'GET',undefined,{Range:'bytes=2-3'}),e,{waitUntil(){}})
    assert.equal(r.status,206);assert.equal(await r.text(),'cd');assert.equal(calls,0)
  }finally{if(previous===undefined)delete globalThis.caches;else globalThis.caches=previous}
})
test('conditional HEAD supports 304',async()=>{
  const e=environment();const o=e.ROMS.seed('a');const r=await worker.fetch(req('/a','HEAD',undefined,{'If-None-Match':o.httpEtag}),e);assert.equal(r.status,304);assert.equal(r.body,null)
})
test('If-None-Match supports weak and multiple validators',async()=>{
  const e=environment();const o=e.ROMS.seed('a');const r=await worker.fetch(req('/a','GET',undefined,{'If-None-Match':`"other", W/${o.httpEtag}`}),e);assert.equal(r.status,304)
})
test('HTTP precondition precedence: If-Match > IUS; INM > IMS',async()=>{
  const e=environment();const o=e.ROMS.seed('a');const r=await worker.fetch(req('/a','GET',undefined,{'If-Match':o.httpEtag,'If-Unmodified-Since':'Tue, 01 Jan 2000 00:00:00 GMT','If-None-Match':'"other"','If-Modified-Since':'Wed, 01 Jan 2031 00:00:00 GMT'}),e);assert.equal(r.status,200)
})
test('nonexistent If-Match is 412; zero-byte Range is 416',async()=>{
  const e=environment();assert.equal((await worker.fetch(req('/missing','GET',undefined,{'If-Match':'*'}),e)).status,412)
  e.ROMS.seed('empty','');assert.equal((await worker.fetch(req('/empty','GET',undefined,{Range:'bytes=0-'}),e)).status,416)
})
test('head/get concurrent overwrite retries rather than mixing metadata with bytes',async()=>{
  const e=environment();e.ROMS.seed('a','old');let changed=false
  e.ROMS.beforeGet=()=>{if(!changed){changed=true;e.ROMS.seed('a','0123456789')}}
  const r=await worker.fetch(req('/a','GET',undefined,{Range:'bytes=1-2'}),e);assert.equal(r.status,206);assert.equal(await r.text(),'12');assert.equal(r.headers.get('Content-Range'),'bytes 1-2/10')
})
test('list cursor separately advances BOTH buckets with short metadata pages',async()=>{
  const e=environment(true,3);for(let i=0;i<11;i++){e.ROMS.seed('r'+i.toString().padStart(2,'0'));e.COVERS.seed('covers/c'+i.toString().padStart(2,'0'))}
  let cursor,iterations=0;const seen=new Set()
  do{const r=await worker.fetch(req('/list'+(cursor?'?cursor='+encodeURIComponent(cursor):''),'GET',undefined,{},true),e);assert.equal(r.status,200);const j=await r.json();for(const o of j.objects){const k=o.bucket+':'+o.key;assert(!seen.has(k));seen.add(k)}cursor=j.cursor;assert(++iterations<20)}while(cursor)
  assert.equal(seen.size,22);assert.equal(iterations,4)
})
test('once a list bucket is finished it is NOT refetched',async()=>{
  const e=environment(true,2);e.ROMS.seed('a');for(let i=0;i<5;i++)e.COVERS.seed('covers/'+i)
  let cursor;do{const j=await(await worker.fetch(req('/list'+(cursor?'?cursor='+encodeURIComponent(cursor):''),'GET',undefined,{},true),e)).json();cursor=j.cursor}while(cursor)
  assert.equal(count(e.ROMS,'list'),1);assert.equal(count(e.COVERS,'list'),3)
})
test('list with only hidden markers can return empty page WITH continuation',async()=>{
  const e=environment(false,2);for(let i=0;i<3;i++)e.ROMS.seed('_uploads/'+i);e.ROMS.seed('a')
  const j=await(await worker.fetch(req('/list','GET',undefined,{},true),e)).json();assert.equal(j.objects.length,0);assert.equal(j.truncated,true);assert(j.cursor)
})
test('old/malformed/cross-prefix list cursor is rejected, not silently reused',async()=>{
  const e=environment(false,1);e.ROMS.seed('a1');e.ROMS.seed('a2')
  const j=await(await worker.fetch(req('/list?prefix=a','GET',undefined,{},true),e)).json()
  for(const path of ['/list?cursor=roms:1','/list?prefix=b&cursor='+encodeURIComponent(j.cursor)])assert.equal((await worker.fetch(req(path,'GET',undefined,{},true),e)).status,400)
})
test('1000-key bulk delete uses one batched call, not 1000 awaits',async()=>{
  const e=environment();const keys=Array.from({length:1000},(_,i)=>'roms/'+i);keys.forEach(k=>e.ROMS.seed(k))
  const r=await worker.fetch(req('/bulk','POST',{keys},{},true),e);assert.equal(r.status,200);assert.equal((await r.json()).deleted.length,1000);assert.equal(count(e.ROMS,'delete'),1)
})
test('cover delete removes both copies; legacy file cannot resurrect',async()=>{
  const e=environment();for(const b of [e.ROMS,e.COVERS])b.seed('covers/a.png')
  assert.equal((await worker.fetch(req('/covers/a.png','DELETE',undefined,{},true),e)).status,200)
  assert.equal((await worker.fetch(req('/covers/a.png'),e)).status,404)
})
test('partial cross-bucket failure returns failed keys, never false all-success',async()=>{
  const e=environment();e.COVERS.fail.delete=Error('temporary');const r=await worker.fetch(req('/bulk','POST',{keys:['roms/a','covers/a']},{},true),e)
  assert.equal(r.status,503);const j=await r.json();assert.deepEqual(j.deleted,['roms/a']);assert.deepEqual(j.failed,['covers/a'])
})
test('bulk validates every key before deleting any object',async()=>{
  const e=environment();const r=await worker.fetch(req('/bulk','POST',{keys:['roms/a','../bad']},{},true),e);assert.equal(r.status,400);assert.equal(count(e.ROMS,'delete'),0)
})
test('single PUT unknown-length oversize stream is bounded before R2 commit',async()=>{
  const e=environment();e.MAX_UPLOAD_MB='1';const stats={};const body=streamChunks([new Uint8Array(700000),new Uint8Array(700000),new Uint8Array(700000)],stats)
  const r=await worker.fetch(req('/a','PUT',body,{},true),e);assert.equal(r.status,413);assert.equal(count(e.ROMS,'put'),0);assert(stats.cancelled);assert.equal(stats.pulls,2)
})
test('known-length PUT preserves streaming input',async()=>{
  const e=environment();const r=await worker.fetch(req('/a','PUT','abc',{'Content-Length':'3'},true),e);assert.equal(r.status,200);assert.equal(e.ROMS.stats.streamWrites,1)
})
test('oversized declared PUT is rejected before consuming body',async()=>{
  const e=environment();e.MAX_UPLOAD_MB='1';const r=await worker.fetch(req('/a','PUT','a',{'Content-Length':'2000000'},true),e);assert.equal(r.status,413);assert.equal(count(e.ROMS,'put'),0)
})
test('CORS reflects only allowed origins and includes conditional request headers',async()=>{
  const e=environment();e.ALLOWED_ORIGINS='https://site.test'
  const denied=await worker.fetch(req('/ping','OPTIONS',undefined,{Origin:'https://wrong.test'}),e);assert.equal(denied.status,403);assert.equal(denied.headers.get('Access-Control-Allow-Origin'),null)
  const good=await worker.fetch(req('/ping','OPTIONS',undefined,{Origin:'https://site.test'}),e);assert.equal(good.status,204);assert(good.headers.get('Access-Control-Allow-Headers').includes('If-Match'))
})
test('empty uploadId cannot accidentally fall through to delete final object',async()=>{
  const e=environment();e.ROMS.seed('a');const r=await worker.fetch(req('/a?uploadId=','DELETE',undefined,{},true),e);assert.equal(r.status,400);assert(e.ROMS.objects.has('a'))
})
for(const [path,method] of [['/a?partNumber=1','PUT'],['/a?uploads','DELETE'],['/a?marker=_uploads/m','DELETE'],['/a?uploadId=x&uploadId=y','DELETE']])test('malformed multipart parameters cannot overwrite/delete final object: '+path,async()=>{
  const e=environment();e.ROMS.seed('a','original-complete-file')
  const r=await worker.fetch(req(path,method,method==='PUT'?'one-part':undefined,{},true),e)
  assert.equal(r.status,400);assert.equal(new TextDecoder().decode(e.ROMS.objects.get('a').data),'original-complete-file')
})

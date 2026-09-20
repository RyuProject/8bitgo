import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../embed-vc/src/index.js'
import { req } from './fixtures.mjs'
const env=()=>({ BASE_PATH:'/embed/vc', VCSKY_UPSTREAM:'https://trusted.test/vcsky/', VCBR_UPSTREAM:'https://br.trusted.test/vcsky/', UPSTREAM_CACHE_TTL:'86400',
  ASSETS:{fetch:async r=>new Response('<html><head><title>Fixture</title></head><body>ok</body></html>',{headers:{'Content-Type':'text/html','Content-Length':'64','ETag':'"original"','Content-Encoding':'gzip','X-Frame-Options':'DENY'}})} })
async function mockFetch(fn, callback) {
  const old=globalThis.fetch;globalThis.fetch=fn
  try{return await callback()}finally{globalThis.fetch=old}
}
for(const path of [
  '/vcsky/https://untrusted.test/file','/vcsky///untrusted.test/file',
  '/vcsky/%2f%2funtrusted.test/file','/vcsky/%5c%5cuntrusted.test/file',
  '/vcsky/%252e%252e/file','/vcsky/%252f%252funtrusted.test/file','/vcsky/%GG',
])test('proxy rejects unsafe relative input '+path,async()=>{
  let calls=0;await mockFetch(async()=>{calls++;return new Response('oops')},async()=>{
    const r=await worker.fetch(req(path),env());assert.equal(r.status,400);assert.equal(calls,0)
  })
})
test('vcsky and vcbr retain fixed upstream paths and QUERY parameters',async()=>{
  const seen=[];await mockFetch(async(url)=>{seen.push(url);return new Response('ok')},async()=>{
    await worker.fetch(req('/vcsky/files/a.dat?v=2&key=x'),env());await worker.fetch(req('/embed/vc/vcbr/a.br?rev=3'),env())
  });assert.deepEqual(seen,['https://trusted.test/vcsky/files/a.dat?v=2&key=x','https://br.trusted.test/vcsky/a.br?rev=3'])
})
test('proxy forwards If-Range and does not forward Authorization/Cookie',async()=>{
  await mockFetch(async(url,opts)=>{
    assert.equal(opts.headers.get('If-Range'),'"etag"');assert.equal(opts.headers.get('Range'),'bytes=3-');assert.equal(opts.headers.get('Authorization'),null);assert.equal(opts.headers.get('Cookie'),null)
    return new Response('abc',{status:206,headers:{'Content-Range':'bytes 3-5/6','Content-Length':'3'}})
  },async()=>{const r=await worker.fetch(req('/vcsky/a','GET',undefined,{'If-Range':'"etag"',Range:'bytes=3-',Authorization:'Bearer no',Cookie:'private=1'}),env());assert.equal(r.status,206);assert.equal(await r.text(),'abc')})
})
test('upstream errors never get immutable/day-long browser or edge caching',async()=>{
  for(const status of [404,429,500,503])await mockFetch(async(url,opts)=>{
    assert.equal(opts.cf.cacheTtlByStatus['300-599'],-1);assert.equal(opts.cf.cacheTtl,undefined)
    return new Response('error',{status})
  },async()=>{const r=await worker.fetch(req('/vcsky/a'),env());assert.equal(r.status,status);assert.equal(r.headers.get('Cache-Control'),'no-store')})
})
test('TTL 0 is honored instead of silently becoming one day',async()=>{
  const e=env();e.UPSTREAM_CACHE_TTL='0';await mockFetch(async(url,opts)=>{assert.equal(opts.cf.cacheTtlByStatus['200-299'],0);return new Response('ok')},async()=>{
    const r=await worker.fetch(req('/vcsky/a'),e);assert.equal(r.headers.get('Cache-Control'),'public, max-age=0, must-revalidate')
  })
})
test('negative/invalid TTL rejected before fetch',async()=>{
  for(const value of ['-1','wat','3.5']){const e=env();e.UPSTREAM_CACHE_TTL=value;assert.equal((await worker.fetch(req('/vcsky/a'),e)).status,500)}
})
test('cross-origin redirects are blocked before issuing another fetch',async()=>{
  let calls=0;await mockFetch(async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://untrusted.test/a'}})},async()=>{
    const r=await worker.fetch(req('/vcsky/a'),env());assert.equal(r.status,502);assert.equal(calls,1)
  })
})
test('same-origin redirects outside configured prefix are blocked',async()=>{
  await mockFetch(async()=>new Response(null,{status:302,headers:{Location:'/admin'}}),async()=>{assert.equal((await worker.fetch(req('/vcsky/a'),env())).status,502)})
})
test('safe same-prefix redirect is followed manually and finitely',async()=>{
  const seen=[];await mockFetch(async(url,opts)=>{assert.equal(opts.redirect,'manual');seen.push(url);return seen.length===1?new Response(null,{status:302,headers:{Location:'b.dat'}}):new Response('data')},async()=>{
    const r=await worker.fetch(req('/vcsky/a.dat'),env());assert.equal(await r.text(),'data');assert.deepEqual(seen,['https://trusted.test/vcsky/a.dat','https://trusted.test/vcsky/b.dat'])
  })
})
test('redirect loops terminate after bounded fetches',async()=>{
  let calls=0;await mockFetch(async()=>{calls++;return new Response(null,{status:302,headers:{Location:'a'}})},async()=>{
    assert.equal((await worker.fetch(req('/vcsky/a'),env())).status,502);assert.equal(calls,4)
  })
})
test('upstream header timeout produces 504, not an endless pending request',async()=>{
  const e=env();e.UPSTREAM_HEADER_TIMEOUT_MS='15'
  await mockFetch(async(url,opts)=>new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})),async()=>{
    assert.equal((await worker.fetch(req('/vcsky/a'),e)).status,504)
  })
})
test('HEAD proxy output never carries a body',async()=>{
  await mockFetch(async()=>new Response('accidental upstream body'),async()=>{assert.equal((await worker.fetch(req('/vcsky/a','HEAD'),env())).body,null)})
})
test('proxy strips hop-by-hop and connection-nominated headers, preserves upstream CSP',async()=>{
  await mockFetch(async()=>new Response('ok',{headers:{Connection:'x-secret', 'X-Secret':'no', 'Set-Cookie':'secret', 'Content-Security-Policy':"default-src 'none'"}}),async()=>{
    const r=await worker.fetch(req('/vcsky/a'),env());assert.equal(r.headers.get('x-secret'),null);assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.headers.get('content-security-policy'),"default-src 'none'")
  })
})
test('HTML base injection drops stale length/encoding/validators and keeps isolation headers',async()=>{
  const r=await worker.fetch(req('/embed/vc/'),env());assert.equal(r.status,200);assert((await r.text()).includes('<base href="/embed/vc/">'))
  for(const h of ['Content-Length','Content-Encoding','ETag','X-Frame-Options'])assert.equal(r.headers.get(h),null)
  assert.equal(r.headers.get('Cross-Origin-Opener-Policy'),'same-origin');assert.equal(r.headers.get('Cross-Origin-Embedder-Policy'),'require-corp')
})
test('existing explicit base element remains unchanged',async()=>{
  const e=env();e.ASSETS.fetch=async()=>new Response('<head><base href="/custom/"></head>',{headers:{'Content-Type':'text/html'}})
  const s=await(await worker.fetch(req('/embed/vc/'),e)).text();assert(s.includes('/custom/'));assert.equal((s.match(/<base /g)||[]).length,1)
})
test('HTML HEAD avoids reading/transformation body but sends consistent headers',async()=>{
  const r=await worker.fetch(req('/embed/vc/','HEAD'),env());assert.equal(r.body,null);assert.equal(r.headers.get('Content-Length'),null);assert.equal(r.headers.get('ETag'),null)
})
test('HTML conditionals are not passed through with pre-transform ETags',async()=>{
  const e=env();e.ASSETS.fetch=async r=>{assert.equal(r.headers.get('If-None-Match'),null);return new Response('<head></head>',{headers:{'Content-Type':'text/html'}})}
  assert.equal((await worker.fetch(req('/embed/vc/','GET',undefined,{'If-None-Match':'"original"'}),e)).status,200)
})
test('missing ASSETS binding returns 503; invalid BASE_PATH returns 500',async()=>{
  const e=env();delete e.ASSETS;assert.equal((await worker.fetch(req('/embed/vc/'),e)).status,503)
  const bad=env();bad.BASE_PATH='/bad"path';assert.equal((await worker.fetch(req('/'),bad)).status,500)
})
test('non-HTML static assets remain byte-identical',async()=>{
  const e=env();e.ASSETS.fetch=async r=>{assert.equal(new URL(r.url).pathname,'/app.wasm');return new Response(new Uint8Array([0,97,115,109]),{headers:{'Content-Type':'application/wasm'}})}
  const r=await worker.fetch(req('/embed/vc/app.wasm'),e);assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[0,97,115,109])
})
test('read-only proxy refuses writes and allows OPTIONS',async()=>{
  assert.equal((await worker.fetch(req('/vcsky/a','POST','x'),env())).status,405);assert.equal((await worker.fetch(req('/vcsky/a','OPTIONS'),env())).status,204)
})

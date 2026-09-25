import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { load, stubs } from './helpers/target.mjs'
process.env.FLASH_SAVE_SECRET='audit-flash-independent-secret-'+'x'.repeat(40)
process.env.FLASH_SAVE_GAMES='infectonator-2,kingdom-rushfrontiers'
const users=new Map([['u1',{id:'u1',status:'active',token_version:7}],['u2',{id:'u2',status:'active',token_version:7}]])
const slots=new Map(),kv=new Map(),seqs=new Map();let revoke=false;let locks=0;let tail=Promise.resolve()
const identity=p=>p.slice(0,3).join(':')
async function run(sql,p=[]) {
 const s=sql.replace(/\s+/g,' ').trim()
 const table=s.includes('flash_save_seqs')?seqs:s.includes('flash_save_kv')?kv:slots
 if(s.includes('FROM games'))return ['infectonator-2','kingdom-rushfrontiers'].includes(String(p[0]))?[{slug:p[0],platform:'flash'}]:[]
 if(s.includes('FROM users')) {if(s.includes('FOR UPDATE'))locks++;return users.has(p[0])?[{...users.get(p[0])}]:[]}
 if(s.includes('SUM(size)'))return [{bytes:[...table.values()].filter(x=>x.user_id===p[0]).reduce((n,x)=>n+x.size,0)}]
 if(s.startsWith('SELECT')) {
  if(s.includes('FROM flash_save_seqs')) {
   const rows=[...seqs.values()].filter(x=>x.user_id===p[0] && x.game_slug===p[1])
   return p.length>=3 ? rows.filter(x=>x.save_key===p[2]).map(x=>({...x})) : rows.map(x=>({...x}))
  }
  const rows=[...table.values()].filter(x=>x.user_id===p[0] && x.game_slug===p[1])
  return p.length>=3 ? (table.has(identity(p))?[{...table.get(identity(p))}]:[]) : rows.map(x=>({...x}))
 }
 if(s.startsWith('INSERT INTO flash_save_')) {
  const old=table.get(identity(p))
  // 存档行和代次行都会显式带上 revision（删掉再存也不能回到 1），只有代次表的自增是真自增
  const revision=s.includes('revision = VALUES(revision)')?Number(p[p.length-1]):(old?.revision||0)+1
  const row={user_id:p[0],game_slug:p[1],revision,updated_at:new Date()}
  if(table===seqs)Object.assign(row,{
   save_key:p[2],
   // 删除推进代次时传 null，但 SQL 用 COALESCE 保留最后一次写入 ID，防止超时重放把删掉的档复活
   last_op_id:p[3]??(s.includes('COALESCE(VALUES(last_op_id), last_op_id)')?old?.last_op_id:null)??null,
  })
  else if(table===kv)Object.assign(row,{save_key:p[2],value_json:JSON.parse(p[3]),size:p[4]})
  else Object.assign(row,{slot:p[2],profile_json:JSON.parse(p[3]),data_json:JSON.parse(p[4]),size:p[5]})
  table.set(identity(p),row);return {affectedRows:1}
 }
 if(s.startsWith('DELETE FROM flash_save_'))return {affectedRows:table.delete(identity(p))?1:0}
 throw new Error('Unexpected SQL: '+s)
}
globalThis.__flashDb={query:run,queryOne:async(s,p)=>(await run(s,p))[0],withTransaction(fn){
 const task=tail.then(async()=>{if(revoke){users.get('u1').token_version++;revoke=false}return fn(run)})
 tail=task.catch(()=>{});return task
}}
stubs({
 'db.js':`export const query=(...a)=>globalThis.__flashDb.query(...a);export const queryOne=(...a)=>globalThis.__flashDb.queryOne(...a);export const withTransaction=(...a)=>globalThis.__flashDb.withTransaction(...a);`,
 'auth.js':`export const tokenVersionOf=u=>Number(u?.token_version)||0;export const requireUser=(req,res,next)=>{if(req.headers.authorization!=='Bearer login-u1')return res.status(401).json({error:'请先登录'});req.user={id:'u1',nickname:'Player',token_version:7};next()};`,
 'shared/flash-save-games.js':`export const flashSaveKnownSlugs=()=>['infectonator-2','kingdom-rushfrontiers'];export const flashSaveProtocolOf=slug=>slug==='kingdom-rushfrontiers'?'agi2':'agi1';export const flashSaveBridgeOf=slug=>'/flash-api/armor-games/20260925-r03/'+(slug==='kingdom-rushfrontiers'?'AGI2':'AGI')+'.swf';`,
})
const {flashSavesRouter}=await load('src/routes/flash-saves.js')
const {signFlashSaveToken}=await load('src/flash-save-token.js')
const app=express();app.use(express.json({limit:'4mb'}));app.use('/',flashSavesRouter)
app.use((e,req,res,_next)=>res.status(500).json({error:e.message}))
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
const url=`http://127.0.0.1:${server.address().port}`
const tok=(slug,user='u1')=>signFlashSaveToken({userId:user,gameSlug:slug,tokenVersion:users.get(user).token_version}).token
async function session(token='') {
 const response=await fetch(`${url}/session`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({gameSlug:'infectonator-2'})})
 return {status:response.status,body:await response.json()}
}
async function post(slug,method,body,token=tok(slug)) {
 const response=await fetch(`${url}/${slug}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionToken:token,...body})})
 return {status:response.status,body:await response.json(),headers:response.headers}
}
test('session: guest cannot obtain an online-save token',async()=>{
 const result=await session();assert.equal(result.status,401);assert.match(result.body.error,/登录/)
})
test('session: signed-in user receives a game-scoped bridge session',async()=>{
 const result=await session('login-u1');assert.equal(result.status,200)
  assert.equal(result.body.data.protocol,'agi1');assert.equal(result.body.data.bridgeUrl,'/flash-api/armor-games/20260925-r03/AGI.swf')
 assert.ok(result.body.data.sessionToken);assert.equal(result.body.data.username,'Player')
})
const cases=[{protocol:'AGI1',slug:'infectonator-2',write:{slot:0,profile:{index:'online0',saved:1},data:{index:'online0',score:123}},read:{key:'dataonline0'},del:{slot:0},table:slots},
 {protocol:'AGI2',slug:'kingdom-rushfrontiers',write:{key:'slot1',value:{score:123}},read:{key:'slot1'},del:{key:'slot1'},table:kv}]
for(const c of cases){
 test(`${c.protocol}: write/read/delete retains contract over real local HTTP`,async()=>{
  const write=await post(c.slug,'write-slot',c.write);assert.equal(write.status,200);assert.equal(write.body.data.revision,1)
  const read=await post(c.slug,'read',c.read);assert.equal(read.status,200)
  assert.equal(c.protocol==='AGI1'?read.body.data.score:read.body.keys.slot1.score,123)
  assert.equal(read.headers.get('cache-control'),'no-store')
  const before=locks;assert.equal((await post(c.slug,'delete-slot',c.del)).status,200);assert.equal(locks,before+1)
  assert.equal((await post(c.slug,'delete-slot',c.del)).status,200)
 })
 test(`${c.protocol}: second user cannot read first user's save`,async()=>{
  await post(c.slug,'write-slot',c.write)
  const r=await post(c.slug,'read',c.read,tok(c.slug,'u2'))
  assert.equal(r.status,200);if(c.protocol==='AGI1')assert.equal(r.body.data,null);else assert.deepEqual(r.body.keys,{})
 })
 test(`${c.protocol}: token revoked between middleware and delete lock cannot delete`,async()=>{
  const before=c.table.size;const token=tok(c.slug);revoke=true
  const result=await post(c.slug,'delete-slot',c.del,token)
  assert.equal(result.status,401);assert.equal(c.table.size,before)
  revoke=false
 })
 test(`${c.protocol}: invalid slots are rejected without mutation`,async()=>{
  const before=c.table.size;const r=await post(c.slug,'delete-slot',{slot:3,key:'slot4'});assert.equal(r.status,400);assert.equal(c.table.size,before)
 })
}
test('mismatched game token cannot access another namespace',async()=>assert.equal((await post(cases[1].slug,'read',{},tok(cases[0].slug))).status,403))
test('invalid token is rejected',async()=>assert.equal((await post(cases[0].slug,'read',{},'invalid')).status,401))
test('removing game from allowlist invalidates existing session use',async()=>{
 const slug=cases[1].slug;const token=tok(slug);process.env.FLASH_SAVE_GAMES=cases[0].slug
 try{assert.equal((await post(slug,'read',{},token)).status,404)}finally{process.env.FLASH_SAVE_GAMES=cases.map(c=>c.slug).join(',')}
})
/* ---------------- R01：迟到的旧请求不许覆盖新存档 ---------------- */
/*
  存档请求可能被网络拖到「更晚的一次保存之后」才到达。原来的 upsert 只认「谁来谁覆盖」，
  于是一份基于旧状态的档会把新档盖掉，玩家的进度看起来倒退了。
  现在写入可以带 expectedRevision（条件更新）和 opId（幂等重放），见 src/routes/flash-saves.js。
*/
const AGI1='infectonator-2'
// profile.saved 必须是 1、两半的 index 必须是 online<slot> —— 见 validateFlashSavePair
const pair=(slot,version,extra={})=>({slot,profile:{index:`online${slot}`,saved:1,v:version},data:{index:`online${slot}`,v:version},...extra})

test('R01: a write based on an outdated revision is rejected and changes nothing',async()=>{
  const first=await post(AGI1,'write-slot',pair(2,1));assert.equal(first.status,200)
  const base=first.body.data.revision
  const newer=await post(AGI1,'write-slot',pair(2,2,{expectedRevision:base}));assert.equal(newer.status,200)
  const late=await post(AGI1,'write-slot',pair(2,1,{expectedRevision:base}))
  assert.equal(late.status,409);assert.equal(late.body.error.code,'stale_write')
  assert.equal(late.body.error.currentRevision,newer.body.data.revision,'桥必须拿到当前代次，不能降级成无条件写')
  // 新档还在：迟到的那次没有盖掉它
  const read=await post(AGI1,'read',{key:'dataonline2'})
  assert.equal(read.body.data.v,2)
})

test('R01: retry of a successful write cannot resurrect a slot after delete',async()=>{
 const body=pair(0,11,{opId:'op-delete-replay-0001'})
 const first=await post(AGI1,'write-slot',body);assert.equal(first.status,200)
 assert.equal((await post(AGI1,'delete-slot',{slot:0})).status,200)
 const replay=await post(AGI1,'write-slot',body);assert.equal(replay.status,200)
 const read=await post(AGI1,'read',{key:'dataonline0'})
 assert.equal(read.body.data,null,'已成功过的旧写重放不能把删除的档复活')
})

test('R01: a retry that reuses the opId is applied once, not twice',async()=>{
  const body=pair(1,7,{opId:'op-abcdefgh-0001'})
  const a=await post(AGI1,'write-slot',body);assert.equal(a.status,200)
  const b=await post(AGI1,'write-slot',body);assert.equal(b.status,200)
  assert.equal(a.body.data.revision,b.body.data.revision,'重试不该再推进版本号')
})

test('R01: delete advances the generation, so a pre-delete write cannot resurrect the slot',async()=>{
  const w=await post(AGI1,'write-slot',pair(0,5));const before=w.body.data.revision
  assert.equal((await post(AGI1,'delete-slot',{slot:0})).status,200)
  const late=await post(AGI1,'write-slot',pair(0,5,{expectedRevision:before}))
  assert.equal(late.status,409,'删除之后版本号必须继续往前走（ABA）')
})

test('R01: reads hand the current revisions to the bridge',async()=>{
  const w=await post(AGI1,'write-slot',pair(1,3))
  const read=await post(AGI1,'read',{})
  assert.equal(read.body.revisions['1'],w.body.data.revision)
})

test('R01: write options are validated instead of trusted',async()=>{
  for(const extra of [{opId:'short'},{opId:'x'.repeat(65)},{opId:12345},{expectedRevision:-1},{expectedRevision:1.5},{expectedRevision:'abc'}]){
    const r=await post(AGI1,'write-slot',pair(0,1,extra))
    assert.equal(r.status,400,JSON.stringify(extra))
    assert.equal(r.body.error.code,'invalid_request')
    // 断言拒的是**这个选项**，不是载荷 —— 载荷本身是合法的（message 会不一样）
    assert.match(r.body.error.message,/操作 ID|expectedRevision/,JSON.stringify(extra))
  }
})

test('R01: a write without expectedRevision still works (old bridges keep saving)',async()=>{
  const r=await post(AGI1,'write-slot',pair(0,9))
  assert.equal(r.status,200)
  assert.ok(r.body.data.revision>0)
})

test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r))})

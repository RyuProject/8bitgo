# Worker 压缩包体检、修复与性能优化报告

**对象：** 用户上传的 `worker.zip`。  
**审计日期：** 2026-09-20。  
**交付性质：** 保留原接口的代码修复、离线回归及结构性性能优化；不是 Cloudflare/R2 线上验收或全系统安全认证。

## 1. 结论

最需要优先处理的不是 JavaScript 压缩体积，而是两类直接风险：

1. **数据破坏：** 分片请求的参数为空或缺失时会落入普通对象写入/删除分支，可能误删完整 ROM，或用一片数据覆盖完整对象。触发写删仍需有效管理员 Bearer，并非已经发现匿名删桶。
2. **公开代理越界：** embed-vc 把用户控制的路径作为 `new URL(rest, upstreamBase)` 的第一个参数，允许其替换固定上游。在离线 fetch 替身中，无需管理员权限即可让原代码选择未配置的域名。

此外，跨桶分页、分片临时错误处理、中止后的标记清理、If-Range/条件请求、同名封面删除、错误响应缓存和 HTML 响应头均存在可复现问题或明确实现缺陷。

本次整理为 **18 组发现及修复/加固事项**，提供 **105 项通过的离线测试、21 个原版与修复版对照场景**，以及实际 API 调用次数记录。未对真实用户数据执行任何写入、删除或网络探测。

## 2. 输入、范围与交付

原 ZIP 大小为 **21,448 字节**，SHA-256：

```text
296b11b03d00fa4e93beccd75cd42f68bc53e38687b51901c2ee4b7c0e0d1ab4
```

ZIP 共 13 项；剔除目录和 macOS 辅助条目后，只有 6 个实际项目文件，未压缩合计 **41,744 字节**：

| 原始文件 | 字节数 | 作用 |
|---|---:|---|
| `worker/src/index.js` | 25,017 | R2 ROM/封面读取与管理，544 行 |
| `worker/embed-vc/src/index.js` | 6,793 | 静态资源与上游反代，159 行 |
| `worker/wrangler.toml` | 615 | ROM Worker 配置 |
| `worker/embed-vc/wrangler.toml` | 1,586 | embed Worker 配置 |
| `worker/README.md` | 3,759 | 原部署说明 |
| `worker/embed-vc/README.md` | 3,974 | 原嵌入说明 |

归档 CRC 校验通过。本次没有发现需要运行的构建安装脚本；没有把压缩包中的源码当作安装命令执行。`__MACOSX` 和空 `.wrangler/tmp` 不在交付包中；项目源码、配置和说明均有对应保留/更新，原始 6 文件另存于 `audit/original-project/` 供核对。

**原包没有 `embed-vc/dist/`、前端后台上传器、主站 server/play 路由、ROM/BIOS、模拟器核心或完整 reVCDOS 游戏资源。** 因此不能将本次结果写成“完整游戏已部署运行”或“游戏 FPS 提升”。

原有部署身份保留：`8bitgo-roms`、`8bitgo-embed-vc`；ROMS 绑定到 `8bitgo`，COVERS 绑定到 `8bitgo-image`；两个 compatibility_date 均仍为 `2026-01-01`。2026-09-23 后续迁移另加只读 `WEBGAMES → 8bitgo-webgame`，只承接 `/web/cs15/`、`/web/cs16/` 的公开读取。没有写入或假定你的 ADMIN_TOKEN。

## 3. 发现总表

以下定位均指**上传原版**；R 代表 `src/index.js`，E 代表 `embed-vc/src/index.js`。级别为本次结合触发条件给出的修复优先级，不是 CVSS 评分。P 编号对应 `audit/differential-results.json`，其他依据为回归测试或静态路径分析。

| 编号 | 优先级与条件 | 原始定位 | 问题与处理 | 证据 |
|---|---|---|---|---|
| W01 | 严重；管理员写删请求 | R:195–239 | 空/缺失 multipart 参数误入普通 PUT/DELETE；新增方法与参数组合校验，禁止降级 | P09、P21，路由测试 |
| W02 | 高；公开反代入口 | E:70–86 | 相对 URL 解析接受绝对上游，自动跟随任意重定向；固定 HTTPS origin+目录并逐跳验证 | P01，重定向/编码边界测试 |
| W03 | 高；版本/签名资源 | E:71–85、143–149 | 查询串丢失，If-Range 未转发；保留 search 并完善请求头白名单 | P02，条件头测试 |
| W04 | 高；上游异常 | E:83–96 | 404/5xx 等都被配上长缓存和 immutable；按状态控制边缘策略，错误 no-store，TTL=0 生效 | P03，缓存参数测试 |
| W05 | 中高；HTML 注入 base | E:107–130 | 正文变长但保留旧 Content-Length/Encoding/ETag；删除失效表示头，HTML 有界处理，正确处理 HEAD | P19，HTML 测试 |
| W06 | 中；上游不响应头 | E:79–86 | 未设置响应头等待上限；新增跨重定向链 deadline 和错误收尾 | 超时/取消夹具；未做正文停滞修复 |
| W07 | 高；多桶多页 | R:146–169、393–415 | 一个 cursor 混用两桶且 COVERS 每次回到首页；复合游标分别推进已完成/未完成桶 | P11，multipart 双桶分页测试 |
| W08 | 高；条件 GET/HEAD | R:242–271、466–479 | body 缺失统一当 304，If-Match 应返回 412；HEAD 忽略条件；显式按条件优先级评估 | P05、P07，条件矩阵 |
| W09 | 高；断点续传 | R:242–271、466–479 | R2 不处理 If-Range；suffix 形态缺乏正确响应头分支；新增 Range 解析与 ETag 固定读取 | P04、P06；suffix 为契约模型复现 |
| W10 | 高；中止临时失败 | R:366–378 | abort 失败仍清标记，可能 ok=true 但会话仍活动；失败保留线索，仅确定已结束时清理 | P12 |
| W11 | 高；上传/合并临时故障 | R:330–337、354–362 | 所有 R2 错误均 fatal=true；未知/临时错误改为可重试 503，不宣布会话失效 | P13、P14 |
| W12 | 中高；错误 marker | R:422–427 | 清理无条件信任传入 marker，可能删另一上传的账本；验证 key+uploadId | P15 |
| W13 | 中高；旧标记超过一页 | R:429–437 | 只扫首页，却返回已清理；新标记可直接定位，旧标记分页有预算并诚实报告 | P16，24 页预算测试 |
| W14 | 高；未知长度上传 | R:211–229、278–284 | 普通 PUT 只检查声明长度，未知长度绕过本地上限；JSON 缺少有界读取；新增实际字节限制 | P17，JSON 大小测试 |
| W15 | 高；并发分片 | R:313–328 | 先 arrayBuffer 整块读入，超限也等读完；已知长度改定长流，未知长度有界回退 | P20，流式/长度测试 |
| W16 | 高；封面迁移副本 | R:89–97、187、234–239 | 删除只到新桶，但读取会回退旧桶，封面“复活”；逻辑删除覆盖两桶，部分失败可见 | P10 |
| W17 | 性能；批量管理 | R:186–188 | 1000 key 顺序等待 1000 次 delete；改为每桶数组 delete，最多并发两桶 | P18，调用统计 |
| W18 | 中；畸形输入/配置 | R:129、488–503；E:45–50、139 | URL 解码未捕获、CORS 条件头不全、TTL 0 被默认值覆盖等；统一输入/配置校验和响应 | P08，CORS/方法/配置测试 |

## 4. 关键缺陷的实际结果

### 4.1 分片参数错误导致最终对象被破坏

`DELETE /a?uploadId=` 中参数存在但为空，原版 `if (uploadId)` 为假，进入普通对象删除。对照夹具中原版返回 200、最终对象消失；修复版返回 400、最终对象保留。

`PUT /a?partNumber=1` 缺少 uploadId，原版把片内容直接写成 `/a` 的完整对象。对照中原文件 `original-complete-file` 被替换成 `one-part`；修复后拒绝并保留原值。

这两类问题都发生在管理员授权后的请求路径。没有必要构造外部攻击；前端状态丢失、序列化为空或错误拼接参数即可满足触发条件。测试仅在隔离内存对象上进行。

### 4.2 固定上游并不固定

原反代对用户提供的剩余路径调用 URL 相对解析；当剩余路径是绝对 URL 时，基址会被替换。测试环境把 fetch 替换为记录函数，原版选中了未配置的 `untrusted.test`，修复版在发起任何 fetch 前返回 400。

这足以证明代码级开放代理/服务端请求目标可控问题，**不证明 Cloudflare 环境中能够访问内网、云元数据或任意受限制地址**。修复不依赖前端过滤，后端同时验证 HTTPS、origin、路径前缀、编码后的分隔符和每一步重定向。

### 4.3 续传进度被错误作废或隐藏

临时 uploadPart 失败：原版 409 + fatal=true；修复版 503 + fatal=false + retryable=true。临时 complete 失败：原版 400 + fatal=true；修复版同样保留续传。

临时 abort 失败：原版可能已经删除 marker、却仍有活动上传并返回 200；修复版 503、marker 和会话身份保留。新建 marker 写入失败时执行补偿 abort；补偿也失败则返回 uploadId 和 cleanupRequired，而不是隐藏孤立会话。

这并不等于自动恢复任何会话：R2 的 unknown error 尚不能精确映射所有永久错误；客户端必须有有限重试和人工处理入口。只将明确 NoSuchUpload 当作结束信号，优先防止错误清空用户进度。

### 4.4 双桶分页缺项，不是数据库丢文件

原版把后一桶的 cursor 返回，下一次却交给 ROMS；同时 COVERS 总是从第一页读。模型将每桶限制为两条/页并放入各五条：原版首轮读四条后发生跨桶 cursor 错误；修复版三页完整读出十个物理对象，无重复 bucket:key。

这里证明列表读取错误，不是证明 R2 对象被删除。每桶 cursor 独立；一桶读完后不再查询它；结果沿用原 objects/uploads/truncated/cursor 字段，新增 bucket。R2 文档也明确 cursor 是不透明标识，不能按“结果不足 limit”推断结束。[1]

### 4.5 下载与 HTML 表示不一致

If-Range 使用旧 ETag 请求新文件：原版模型返回 206 新文件片段，修复版返回 200 完整新文件。这避免客户端将新文件片段接到旧文件尾部。R2 官方明确不支持 If-Range 自动条件处理，需要应用补齐。[1][4]

suffix 测试中原版正文是 `ef`，却返回 200 / Content-Length=6；修复版返回 206 / Content-Length=2 / Content-Range=`bytes 4-5/6`。这是对官方允许的 suffix 返回形态做契约测试；**没有实测 Cloudflare 原生 binding 是否把其规范化为 offset**，不能据此断言所有线上 suffix 请求必坏。

HTML 夹具正文在 base 注入后为 67 字节，原版仍携带 43 字节长度、gzip 编码和旧 ETag；修复版移除这些已失效的头。真实 ASSETS 压缩、CDN 自动编码和浏览器行为仍需 staging 验证。

## 5. 性能优化：已测量的是什么

### 5.1 API 调用数量

| 场景 | 原版 | 修复版 | 可以得出的结论 |
|---|---:|---:|---|
| 批量删除 1000 个普通 ROM | 1000 次 R2 delete | 1 次 | 方法调用减少 99.9% |
| 批量删除 500 ROM + 500 cover | 1000 次 R2 delete | 2 次 | 方法调用减少 99.8%；cover 同时清旧桶 |
| 新 v2 标记清理 | 未提供 marker 时可能遍历桶首页 | 按确定键 head+delete；不 list | 正常新会话不随标记数量扩大扫描成本 |
| 无条件普通 GET 首桶命中 | 1 次 R2 get | 1 次 R2 get | 没为所有读取统一增加 head |

R2 Workers API 支持一次 delete 至多 1000 key。[1] 这里减少的是绑定方法调用和串行等待点，**不能据此宣称延迟下降 99.9%、速度提升 1000 倍，或账单下降同比例**。计费粒度和真实云延迟不在本次实测中。

### 5.2 分片的数据路径

8 MiB 已知长度测试分为 128 个 64 KiB 输入块：

| 指标 | 原版 | 修复版 |
|---|---:|---:|
| request.arrayBuffer() 调用 | 1 | 0 |
| 开始调用 R2 uploadPart 前已读入块数 | 128 | 0 |
| R2 fixture 收到的参数是 ReadableStream | 否 | 是 |
| 最终消费块数 | 128 | 128 |

这一计数测试运行 Node 回退路径，真实 Cloudflare 使用 FixedLengthStream；另外用 shim 验证了字节不足/超长和写入方提前失败的取消流程。[2] 修复开发过程中发现“只 abort、但无读者释放背压”可能等待，已在写入失败路径取消未锁定 readable，并有专门测试。

没有测量 Cloudflare 峰值内存、内网传输速度或浏览器上传吞吐。不能把参数变成流等同于所有层级零拷贝。未知长度仍会最多缓冲 32 MiB，并可能同时存在块列表和拼接结果；多个并发请求的合计内存依旧要管理。平台内存限制针对 isolate 而非单个 invocation。[3]

### 5.3 正确性带来的性能取舍

Range/有条件 GET 一般由一次 get 改为 head 后条件 get，防止对象替换竞态；同时按 ETag 固定，最多重试三次。命中 304 可仅返回元数据。只给出结构变化，未承诺云端更快。

可覆盖对象默认 max-age=0、must-revalidate，不再使用全局长 TTL。这可能增加 Worker/R2 验证请求，属于更新正确性与延迟/费用的取舍。不可变内容 hash key 可以显式选长 TTL，但本包不能知道现有 URL 是否真的不再覆盖。

embed 仍为成功静态资源配置 TTL；错误不缓存，不把上游故障扩大成持续一天的陈旧错误。cf.cacheTtlByStatus 的负值用于不缓存对应状态。[5] 真正的 Cloudflare 缓存命中率没有测试。

新增校验、测试和文档会使项目 ZIP 比原包大。这不是 WASM/ROM 核心压缩任务，也不以牺牲错误处理换取几 KB 源码体积。运行时代码没有新增第三方依赖。

## 6. 验证范围与复现

测试环境：Linux、Node.js **v22.16.0**。生产源码使用 Web API；所有测试无需第三方 npm 包。

```bash
cd worker
npm run check
npm test
npm run test:original
npm run benchmark
npm run build:standalone
```

最终 **105 tests，105 pass，0 fail，0 skipped，0 cancelled**。其中包括身份校验、坏参数不会写删、双桶短页推进、UTF-8 key、条件头矩阵、并发替换、逻辑封面删除、部分桶失败、multipart 正常流程/故障补偿、旧标记兼容、代理目标/重定向/查询串/HTML/超时、流取消，以及模块版与单文件版对照。合法的 1024 字节 key、中文文件名和较长 uploadId 也有兼容测试。

`test:original` 记录 21 个差异场景，见 JSON；不是 21 次线上渗透测试。`benchmark` 是确定性调用计数，不是 QPS 压测或统计显著性速度基准。

使用了真实 Node WHATWG Request/Response/ReadableStream，但以下服务由夹具替代：

- **R2：** 内存对象/游标/分片 API 模型；不模拟真实存储一致性、全部错误形态、最低分片大小、签名规则、收费和限流。
- **fetch/ASSETS：** 本地记录或构造响应，没有访问第三方上游、用户域名或 Cloudflare 账户。
- **FixedLengthStream：** Node 中采用 shim 的专项测试，另有普通流的离线分支；不是 workerd 原生测试。

环境没有安装可运行的 Wrangler/workerd；npm 注册表解析失败，因此没有安装并执行 miniflare 或 `wrangler deploy --dry-run`。文档中的这些命令是供用户环境验收的步骤，不是已执行记录。

交付还包含源码差异、原始源码快照、逐文件 SHA-256 和归档校验信息。单文件产物由工具重新生成，避免手工拼接漏掉模块。

## 7. 上线前必须接受的兼容变化

### 7.1 完整更新入口及依赖

ROM 的 `src/index.js` 现在依赖同目录 `common.js` 和 `http.js`。不能只复制 index。控制台单文件版本用 `standalone/rom-worker.js`；模块工程由 Wrangler 入口打包。另一个 Worker 用 embed-vc 的源码或 standalone/embed-worker.js。

完整交付保留全部原始配置身份，但没有替你部署。测试时更换成测试 Worker 名称与测试桶；确认后再发布生产。不要为了测试直接对生产 `/bulk` 或 DELETE 路径发破坏请求。

### 7.2 前端响应处理

旧 cursor 要重新从第一页获取；新增 bucket 字段是物理记录身份。multipart 客户端应保留 marker 并正确处理 503/retryable/fatal。部分批量失败的 failed 列表要单独重试。markerOnly 不代表实际分片已中止。

未知长度单次 PUT 大于 32 MiB 不再放行；请使用有效长度的上传或分片。零字节最终对象仍允许，零字节分片仍拒绝。整个 multipart 的总大小没有由 MAX_UPLOAD_MB 限制。

If-Range 日期形式保守返回 200；客户端宜使用返回的强 ETag。多段 Range 不提供 multipart/byteranges，而返回完整表示；HEAD 忽略 Range、保留条件判断。下载器必须遵守实际 HTTP 状态重新开始或接续。

### 7.3 路由、静态文件与缓存

embed-vc/dist 不在原包，必须补齐自有合法构建产物。BASE_PATH、根绝对资源路径、主站 /play/、iframe 父页面的隔离/权限政策都要组合验收。不能保证仅粘贴单文件就能跑完整游戏。

严格上游限制可能拒绝原先被自动跟随的合法跨域重定向；应确认并配置可信最终基址，不要恢复任意转发。原默认 DOS Zone 地址只是保留配置，没有验证实时内容和可用性。

默认 ROM cache policy 不会刷新部署前留在浏览器、CDN 或独立 R2 自定义域名中的旧响应。采用新资源版本或按需失效缓存；若直连另一 R2 域名，本 Worker 不会拦截其请求。[6]

## 8. 剩余风险及未执行的工作

**真实环境验证仍是缺口。** 未跑 Cloudflare 原生 R2/FixedLengthStream、CDN 缓存、入口 Content-Length、实际请求断流、客户端取消、移动浏览器/Safari、完整游戏、云存档或大规模并发。不能给出全部严重漏洞已经消失的保证。

**没有引入全局事务。** 双桶删除可能一边成功一边失败；返回可重试结果而不是回滚。GET 的 ETag 检查避免混合字节与旧元数据，但跨桶整体优先级不是原子快照。

**分片完成的结果不确定性仍存在。** R2 已合并但响应在网络丢失时，下一次 complete 可能表示会话不存在；本次没有新增持久化幂等结果表，不能凭最终对象存在就认定一定是本次上传。需前端核对 size/etag/hash 后人工或专门恢复流程。

**错误分类偏向保守保留进度。** 未知永久错误也可能返回可重试 503；客户端不能无限重试。需要结合真实 R2 错误样本细化映射，但不能为了快退出又恢复“任何错误都 fatal”。

**仅响应头 deadline。** embed 的响应体无进展超时未实现；不能声称中途断流永不等待。没有给 ROM 上传/存储调用增加全局强制时限，R2 流取消和背压传播仍需原生运行时验证。

**未新增身份体系、限速或存储额度。** 保留单 ADMIN_TOKEN 的管理员模式；公开 GET 是原产品行为。未实现短期凭证、细粒度角色、每租户配额、全局上传并发、Durable Object 协调、速率限制或 WAF 配置。

**标记不是上传会话本身。** 已中止、已过期或合并后清理失败的 marker 可能残留；名单是账本，不是原生 listMultipartUploads。24 页旧账本扫描上限是单请求保护，不是全库清理保证。显式 marker-only 删除可隐藏仍活动的分片，管理界面应清楚区分。

**HTML 仍有有限转换边界。** 保留原有“有 base 不替换”的行为；未重写 CSS/JS 根绝对路径，未验证所有字符编码/流式压缩路径。超过 1 MiB 的 HTML 被拒绝，需按实际构建调整，不能盲目扩大到无界读取。

## 9. 建议的 staging 验收顺序

1. 在独立测试桶中上传短文本、中文 key、ROM 样本和两个桶同 key 封面；比较普通 GET、HEAD、ETag、Range/suffix/416、旧 If-Range。
2. 验证真实 8 MiB 分片上传、断线重试、主动中止、丢失 marker、成功合并后清理失败；记录真实 R2 错误对象，核对客户端不会轻易清空进度。
3. 每桶造超过一页数据，完整遍历 objects 和 multipart；把 composite cursor 原样传回，验证额外 bucket 字段不破坏后台展示。
4. 在测试桶执行单个封面和批量删除，确认逻辑删除意图；观察部分失败的管理界面处理，而不是只看 HTTP 请求结束。
5. 补齐 dist 和真实域名路由，检查资源查询串、跨域重定向、页面编码、完整 iframe 隔离、CDN 错误不缓存与恢复；最后观察真实 CPU/内存/延迟，再决定是否调整缓存 TTL 和分片并发。

以上是可执行的验收建议，不是已经完成的云操作。

## 10. 官方技术依据

核对日期：2026-09-20。平台限制会调整，部署时应再次核对。

[1] R2 Workers API：get/onlyIf、If-Range 不支持、delete 数组、分页和 multipart。
https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

[2] Workers FixedLengthStream：已知长度流、过多/过少字节错误。
https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/

[3] Workers limits：每 isolate 内存、入口请求体、子请求类别和静态文件上限。
https://developers.cloudflare.com/workers/platform/limits/

[4] RFC 9110：条件请求、Range、If-Range 和 HEAD 的表示语义。
https://www.rfc-editor.org/rfc/rfc9110.html

[5] Workers Request cf：cacheTtl / cacheTtlByStatus 的状态匹配与负数规则。
https://developers.cloudflare.com/workers/runtime-apis/request/

[6] R2 一致性及缓存：存储写删成功不等于现有边缘缓存已全部刷新。
https://developers.cloudflare.com/r2/reference/consistency/

[7] R2 limits：key 按字节计数，当前对象 metadata 总预算为 8192 字节；代码另用 7000 字节本地保护值留余量，不把旧的 2 KiB 假设当作本轮依据。
https://developers.cloudflare.com/r2/platform/limits/

[8] 浏览器跨源隔离属性与条件。
https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated

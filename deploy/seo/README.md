# 搜索引擎主动推送（IndexNow + 百度普通收录）

## 两条通道

| | IndexNow（Bing / Yandex …） | 百度普通收录 |
|---|---|---|
| 接口 | `https://api.indexnow.org/indexnow` | `http://data.zz.baidu.com/urls` |
| 请求体 | JSON（`urlList`） | `text/plain`，每行一个 URL |
| 凭证 | key，**公开**放在网站根目录 `/<key>.txt` | 准入密钥 token，**私密**，挂在 query 上 |
| 每日配额 | 实际上没有 | 有，站点级，新站常见 10~100 条/天 |
| 推送语言 | 全部 8 种 | 默认只推简体中文（`BAIDU_PUSH_LANGUAGES`） |

百度那条只有 http，没有 https —— token 是明文过网络的。所以它**不能**像 IndexNow 的 key
那样写进代码仓库，只放 `server/.env`（已被 .gitignore 忽略）。万一泄露，去搜索资源平台
点一次「更新」换掉即可，别人拿它只能往你自己的站提交 URL。

## 什么时候会推

1. **上架即推**：后台新增 / 修改 / 上下架 / 删除游戏（`PUT|PATCH|DELETE /api/games/:slug`）
   与批量导入（`POST /api/admin/import`）之后，详情页和相关聚合页进入内存队列，
   ~1 秒后合并成一次请求发出。第三方接口失败只记日志，绝不会让内容保存失败。
2. **每日兜底**：本目录的 `push-daily.sh`，见下。

## 每日兜底任务

```bash
# 1. 放到服务器上（或者直接用仓库里的这份）
chmod +x /var/www/8bitgo/deploy/seo/push-daily.sh

# 2. 加进 crontab（crontab -e）
#    每天 03:20 跑一次。选凌晨是因为百度的配额按自然日重置，
#    这个点当天配额是满的，而且不会和白天的上架动作抢额度。
MAILTO=vins@bitabc.io
20 3 * * * APP_DIR=/var/www/8bitgo /var/www/8bitgo/deploy/seo/push-daily.sh >> /var/log/8bitgo-seo-push.log 2>&1
```

想改回溯天数：`BAIDU_DAYS=7 ...push-daily.sh`。

## 手动补交

```bash
cd server

npm run baidu -- --dry-run     # 只打印将要提交的 URL，一条都不发（排查配置用这个）
npm run baidu                  # 最近 3 天有变动的上架游戏
npm run baidu -- --days 7
npm run baidu -- --all         # 全部上架游戏（首次启用时跑一次）
npm run baidu -- --limit 10    # 最多只推 10 条

npm run indexnow               # IndexNow 全量重推
```

根目录也有同名快捷方式：`npm run baidu -- --dry-run`、`npm run indexnow`。

## 配置

`server/.env`：

```ini
PUBLIC_SITE_URL=https://8bitgo.com
INDEXNOW_ENABLED=1
INDEXNOW_KEY=b8b81a59fab843acaa590586b6733da0
BAIDU_PUSH_ENABLED=1
BAIDU_PUSH_TOKEN=<搜索资源平台的准入密钥>
# 留空则用 PUBLIC_SITE_URL；必须和平台里验证过的写法完全一致
BAIDU_PUSH_SITE=https://8bitgo.com
# 留空则只推简体中文
BAIDU_PUSH_LANGUAGES=zh-Hans
```

后端启动时会把两条通道的状态各打印一行。看到
`[baidu] 普通收录自动提交未启用` 或 `[baidu] 配置无效` 就是没配对，别等日志里的推送记录。

## 排查

| 现象 | 原因 |
|---|---|
| `[baidu] 提交失败：百度推送返回 401：token is not valid` | token 错了，或者和 `site` 不是同一个站点 |
| 响应里 `not_same_site` 有值 | `BAIDU_PUSH_SITE` 和平台里验证的写法不一致（带不带 www、http/https 都算不同站点） |
| `百度推送返回 400：over quota` | 当天配额用完，正常现象，第二天兜底任务会继续 |
| 推了但迟迟不收录 | 推送只保证「百度知道了这个 URL」，不保证收录。收录还取决于内容质量、站点权重 |

## sitemap 怎么跟着上架自动更新

- `/sitemaps/games-<语言>.xml` 共 8 份，**每次请求都现查数据库**，上架即生效，不用重新构建。
- `/sitemap.xml` 索引由后端接管（`server/src/routes/sitemaps.js`），其中 8 份游戏 sitemap 的
  `lastmod` 取「库里可见游戏的最新更新时间」。这一条很关键：构建期生成的那份静态
  `public/sitemap.xml` 里 lastmod 停在构建当天，搜索引擎据此认为子 sitemap 没动过，
  就不会回来重抓 —— 于是游戏 sitemap 明明是实时的，抓取却迟迟不来。
- `/sitemap-static.xml`（首页、平台页、类型页、文章页）仍然是构建期产物。
  新游戏带出一个**此前完全没有游戏**的平台或类型时，那张列表页要等下次
  `npm run build` 才会进 sitemap —— 不过它已经在上架推送的 URL 列表里了，
  搜索引擎照样能发现。

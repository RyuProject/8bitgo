/**
 * 内容变更后的搜索引擎主动推送统一入口。
 *
 * 路由层只认识这一个函数。以前 games.js / admin.js 直接调 queueGameIndexing，
 * 加百度就得在三处各补一行 —— 漏一处的症状是「有的入口推、有的不推」，
 * 而且只有对着日志一条条比对才看得出来。
 *
 * 两个通道互不影响：任一通道的配置错误或接口故障都不会影响另一个，
 * 更不会让已经成功的内容保存变成 500。
 */
import {
  flushIndexNowQueue,
  indexNowEnabled,
  publicSiteUrl,
  queueGameIndexing,
  queueIndexNowUrls,
} from './indexnow.js'
import {
  baiduPushEnabled,
  baiduPushLanguages,
  baiduPushSite,
  baiduPushToken,
  flushBaiduQueue,
  queueBaiduUrls,
  queueGameBaiduPush,
} from './baidu-push.js'

/** 一款游戏新增 / 修改 / 上下架 / 删除后调用。 */
export function queueGameSearchPush(game) {
  return {
    indexnow: queueGameIndexing(game),
    baidu: queueGameBaiduPush(game),
  }
}

/** 任意一批本站 URL（文章、聚合页等）。 */
export function queueSearchPushUrls(urls) {
  return {
    indexnow: queueIndexNowUrls(urls),
    baidu: queueBaiduUrls(urls),
  }
}

/** 进程退出前或脚本收尾时把队列里剩下的推完。 */
export async function flushSearchPushQueues() {
  const [indexnow, baidu] = await Promise.allSettled([flushIndexNowQueue(), flushBaiduQueue()])
  return { indexnow: indexnow.value ?? { error: String(indexnow.reason) }, baidu: baidu.value ?? { error: String(baidu.reason) } }
}

/**
 * 启动时把结论直接说出来。
 *
 * 「配了却没生效」是这类功能最常见也最难查的故障：内容保存一切正常，
 * 只是搜索引擎那边永远收不到通知，而且没有任何报错。所以这里宁可啰嗦。
 */
export function logSearchPushStatus() {
  if (indexNowEnabled()) {
    try {
      console.log(`[indexnow] 自动提交已启用：${publicSiteUrl()}`)
    } catch (error) {
      console.warn(`[indexnow] 配置无效，自动提交未启用：${error?.message || error}`)
    }
  } else {
    console.log('[indexnow] 自动提交未启用（正式环境在 server/.env 设置 INDEXNOW_ENABLED=1）')
  }

  if (baiduPushEnabled()) {
    try {
      baiduPushToken()
      console.log(`[baidu] 普通收录自动提交已启用：${baiduPushSite()}（语言：${baiduPushLanguages().join('、')}）`)
    } catch (error) {
      console.warn(`[baidu] 配置无效，自动提交未启用：${error?.message || error}`)
    }
  } else {
    console.log('[baidu] 普通收录自动提交未启用（正式环境在 server/.env 设置 BAIDU_PUSH_ENABLED=1 和 BAIDU_PUSH_TOKEN）')
  }
}

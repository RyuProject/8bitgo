package
{
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.events.EventDispatcher;
   import flash.events.IOErrorEvent;
   import flash.events.SecurityErrorEvent;
   import flash.events.TimerEvent;
   import flash.external.ExternalInterface;
   import flash.net.URLLoader;
   import flash.net.URLRequest;
   import flash.net.URLRequestMethod;
   import flash.utils.Timer;

   /**
    * Armor Games AGI2 的最小兼容层（Kingdom Rush Frontiers 用的那一代）。
    *
    * ── 它和 AGI.swf（AGI1）的关系 ─────────────────────────────
    * 两代**接口不兼容**，所以是两个独立产物，不能互相顶替：
    *   AGI1（Infectonator 2）方法式：init / submitUserData / retrieveUserData，profile + data 成对提交
    *   AGI2（KRF）对象式：connect() 之后通过 user / storage / content / quests 四个命名空间调用
    * 服务端的方言映射在 shared/flash-save-games.js（前后端共用一份）。
    *
    * ── 构建方式（和 AGI1 不同，注意） ──────────────────────────
    * AGI1 借 Ruffle 的回归测试 SWF 空壳，其文档类是 test_fla.MainTimeline，所以源码里
    * 包名/类名必须叫这个。而 AGI2 的产物文档类就叫 **KrfAgiBridge**（包外顶层类），
    * 换名字会让 `Loader.content` / getDefinitionByName 拿不到它。
    * 因此这里用仓库里那份**已核对的 AGI2.swf 当种子模板**（flash-api/armor-games/template-agi2.swf），
    * 类名保持一致，FFDec 重编译时替换的是同一个文档类的实现 —— 名字不会变。
    *
    * ── 三个必须保持的形状（游戏直接依赖） ───────────────────────
    *   1. user / storage / content / quests 是**公开属性**，游戏从 Loader.content 上直接取
    *   2. 所有方法都收一个 options 对象，回调是 options.callback（不是第二个参数）
    *   3. storage.user.retrieve 的回调拿到的是 `{success, keys}`，keys 缺省时也要给空对象
    *
    * ── 不能用顶层 JSON 类（2026-11-05 线上「CONNECTION LOST TO THE ARMORGAMES SAVE SYSTEM」）──
    * KRF 主影片是 SWF 10；Ruffle 按根影片版本开放 API，`JSON` 只对 SWF 11+ 存在。桥里任何
    * `JSON.stringify / JSON.parse` 都会抛 `Error #1065: Variable JSON is not defined`，post() 在
    * 发请求之前就失败，游戏只看到 success:false 并弹「连接丢失」。所以编解码用下面自带的
    * encodeJson / decodeJson（按 RFC 8259 实现，只处理普通对象 / 数组 / 字符串 / 数字 / 布尔 / null）。
    */
   public dynamic class KrfAgiBridge extends Sprite
   {
      /** 避免游戏异常连发存档时把大块 JSON 无限堆在内存里；常规同槽快照会先合并。 */
      private static const MAX_QUEUED_TASKS:int = 12;

      /** 四个旧 AGI2 命名空间。游戏在 connect() 之后直接读它们，必须是公开属性 */
      public var user:Object;
      public var storage:Object;
      public var content:Object;
      public var quests:Object;
      /**
       * 新 Flash 游戏用的简化接口：不用懂 Armor Games 的命名空间，
       * 只需 eightbitgo.read / write / remove / showLogin。旧 KRF 完全不读它，因此是向后兼容的扩展。
       */
      public var eightbitgo:Object;

      private var endpoint:String = "";
      private var sessionToken:String = "";
      private var username:String = "";
      private var avatarUrl:String = "";
      private var saveMode:String = "";
      private var loginCallback:String = "";
      private var loggedIn:Boolean = false;
      /** 一局只弹一次，避免一次保存又读又写时叠出多层登录框。 */
      private var loginPromptSent:Boolean = false;
      /**
       * user.showLogin / eightbitgo.showLogin 挂起的回调。
       * 真 Armor Games 的 showLogin 在登录窗**关闭后**才回调；旧实现在通知页面开登录框的同一刻
       * 就回 `loggedIn:false`，按它重画界面的游戏会永远停在游客态。现在先挂起，页面推来新会话
       * （登录成功 / 登出）或 eightbitgoLoginSettled（没登录就关了框）时再按当时状态回；
       * 页面版本过旧不会推的话，LOGIN_WAIT_MS 后兜底回调，游戏不会一直等。
       * （KRF 本身不走这里，见 refreshGameLoginWidgets。）
       */
      private var pendingLoginCallbacks:Array = [];
      private var loginWaitTimer:Timer = null;
      private static const LOGIN_WAIT_MS:int = 600000;
      /** 每个槽的服务端代次，用来拒绝弱网下迟到的旧写入。 */
      private var revisions:Object = {};
      /** 页面会话内的操作 ID；同一次写入重试时复用，服务端才能幂等去重。 */
      private var sessionId:String = "";
      /** 登录账号变化是队列边界；迟到的旧账号回包不能污染新账号的代次或读档结果。 */
      private var sessionGeneration:int = 0;
      private var opCounter:int = 0;

      /**
       * 写入 / 删除的串行队列。
       * 用一个全局队列而不是每个槽一个：AGI2 的一次提交就是一份完整档，
       * 串行化保证「后点的保存」一定在「先点的保存」之后落库。
       */
      private var queue:Array;
      private var busy:Boolean = false;

      /** KRF 在 connect({stage}) 里把舞台交给桥：桥不在显示列表上，自己的 stage 是 null */
      private var connectStage:Object = null;

      /** decodeJson 的游标；解析是同步的，不会重入 */
      private var jsonText:String = "";
      private var jsonPos:int = 0;

      public function KrfAgiBridge()
      {
         this.queue = [];
         super();

         this.user = {
            "isGuest": function():Boolean
            {
               return !loggedIn;
            },
            "getUsername": function():String
            {
               return username;
            },
            "getAvatarURL": function():String
            {
               return avatarUrl;
            },
            "getUID": function():String
            {
               return username == "" ? "guest" : username;
            },
            "showLogin": this.showLoginFn
         };

         this.storage = {
            "user": {
               "retrieve": this.retrieveFn,
               "submit": this.submitFn,
               "erase": this.eraseFn
            }
         };

         this.eightbitgo = {
            "isLoggedIn": this.simpleIsLoggedIn,
            "getUser": this.simpleGetUser,
            "showLogin": this.simpleShowLogin,
            "read": this.simpleRead,
            "write": this.simpleWrite,
            "remove": this.simpleRemove
         };

         /*
            内购：第一版一律返回「没有可卖的东西 / 商店不可用」。
            常量必须原样保留 —— 游戏用它们比对返回值，少一个就是 undefined。
         */
         this.content = {
            "retrievePurchases": this.retrievePurchasesFn,
            "showStore": this.showStoreFn,
            "retrieveProducts": this.retrieveProductsFn,
            "RESPONSE_USER_CANCELLED": "cancelled",
            "RESPONSE_PURCHASE_FAILED": "failed",
            "RESPONSE_PURCHASE_SUCCESS": "success"
         };

         this.quests = {
            "submit": this.questSubmitFn
         };

         /*
            登录弹窗可以在游戏运行中完成。把一个窄接口暴露给本站播放器，收到新会话后只替换
            在线存档凭证，不重启游戏、不丢当前波次；如果播放器版本不支持回调，仍可退出重进。
         */
         try
         {
            if(ExternalInterface.available)
            {
               ExternalInterface.addCallback("eightbitgoSetSession",this.setSessionFromHost);
               // 登录框没登录就关掉 / 会话签发失败时，播放器用它把挂起的 showLogin 回调结掉。
               ExternalInterface.addCallback("eightbitgoLoginSettled",this.settleLoginFromHost);
            }
         }
         catch(error:Error)
         {
            // ExternalInterface 受限时，原有游戏与本地存档仍照常工作。
         }
      }

      /** 登录框关闭但没有拿到新会话：按当前状态回调挂起的 showLogin，不改动会话本身。 */
      public function settleLoginFromHost() : Boolean
      {
         this.loginPromptSent = false;
         this.flushPendingLogin();
         return true;
      }

      /** 登录 / 登出后由同源播放器更新短期会话；站点 JWT 从不传入 Flash。 */
      public function setSessionFromHost(token:String, nextUsername:String = "", nextAvatarUrl:String = "", nextMode:String = "authenticated") : Boolean
      {
         var safeToken:String = this.stringValue(token);
         var changed:Boolean = this.sessionToken != safeToken;
         var wasLoggedIn:Boolean = this.loggedIn;
         if(this.endpoint.length == 0) return false;
         if(safeToken.length == 0)
         {
            if(changed)
            {
               this.sessionGeneration++;
               this.revisions = {};
            }
            this.sessionToken = "";
            this.username = "";
            this.avatarUrl = "";
            this.saveMode = nextMode == "unavailable" ? "unavailable" : "guest";
            this.loggedIn = false;
            this.loginPromptSent = false;
            if(changed) this.failQueuedTasksForSessionChange();
            // 取消登录 / 登出也会推一次游客会话：挂起的 showLogin 按「未登录」回，游戏不再干等。
            this.flushPendingLogin();
            if(wasLoggedIn) this.refreshGameLoginWidgets();
            return true;
         }
         if(changed)
         {
            this.sessionGeneration++;
            this.revisions = {};
         }
         this.sessionToken = safeToken;
         this.username = this.stringValue(nextUsername);
         this.avatarUrl = this.stringValue(nextAvatarUrl);
         this.saveMode = "authenticated";
         this.loggedIn = true;
         this.loginPromptSent = false;
         // 新会话可能属于另一账号；先失败掉旧队列，不能把旧档用新账号凭证继续发出。
         if(changed) this.failQueuedTasksForSessionChange();
         // 登录成功：现在才回 showLogin，游戏据此重画在线存档面板并读取云端槽位。
         this.flushPendingLogin();
         if(!wasLoggedIn || changed) this.refreshGameLoginWidgets();
         return true;
      }

      /**
       * KRF 的登录小部件（混淆类 _-im）只在 ADDED_TO_STAGE 时读一次 isLoggedIn。
       * 站内 KRF 包把它的 tryToLogin 改成了 navigateToURL("https://8bitgo.com")，原本登录窗关闭后
       * 回调的私有 afterLogin 从此没人调，所以「点 START → 登录 → 面板仍显示 Login to use the
       * AG Save System」。它的 init / showLoggedIn 都不是 public（2026-11-06 Ruffle 实测直接调抛
       * #1069），但 init 仍挂在 ADDED_TO_STAGE 上：会话一变就给舞台上带 tryToLogin 的对象补发一次
       * addedToStage，让它按新状态重画并拉取已购英雄。按鸭子类型找，不依赖混淆类名；
       * 找不到（换了游戏 / 面板没开）就什么都不做。
       */
      private function refreshGameLoginWidgets() : void
      {
         var root:Object = this.connectStage;
         if(root == null) return;
         var pending:Array = [root];
         var visited:int = 0;
         while(pending.length > 0 && visited < 5000)
         {
            var node:Object = pending.pop();
            visited++;
            try
            {
               if(node !== root && ("tryToLogin" in node) && (node is EventDispatcher))
               {
                  EventDispatcher(node).dispatchEvent(new Event(Event.ADDED_TO_STAGE));
                  continue;
               }
               if(!("numChildren" in node)) continue;
               var count:int = int(node.numChildren);
               for(var i:int = 0; i < count; i++)
               {
                  var child:Object = node.getChildAt(i);
                  if(child != null) pending.push(child);
               }
            }
            catch(error:Error)
            {
               // 单个对象不可访问（卸载中 / 跨沙箱）不能拖累登录刷新，也不能抛回 ExternalInterface。
            }
         }
      }

      /** 凭证边界改变时，尚未发送的任务不能借用新账号凭证重放。 */
      private function failQueuedTasksForSessionChange() : void
      {
         var pending:Array = this.queue.splice(0,this.queue.length);
         for each(var task:Object in pending)
         {
            var failure:Object = {"success":false,"error":{"code":"session_changed"}};
            if(task.kind == "read") failure.keys = {};
            this.callTaskCallback(task,failure);
         }
      }

      /** options 里可以带 callback；游戏拿它判断「桥起来了没有」 */
      public function connect(options:Object = null) : void
      {
         try
         {
            this.connectStage = options != null && options.stage != null ? options.stage : null;
         }
         catch(error:Error)
         {
            this.connectStage = null;
         }
         this.readParameters();
         this.sessionId = this.newSessionId();
         this.opCounter = 0;
         this.revisions = {};
         this.loginPromptSent = false;
         this.callOnce(options == null ? null : options.callback, {"success":true});
      }

      /* ---------------- 8BitGo 简化接口（给新 Flash 游戏） ---------------- */

      public function simpleIsLoggedIn() : Boolean
      {
         return this.loggedIn;
      }

      public function simpleGetUser() : Object
      {
         return {
            "username":this.username,
            "avatar_url":this.avatarUrl
         };
      }

      public function simpleShowLogin(callback:Function = null) : void
      {
         if(this.loggedIn)
         {
            this.callOnce(callback,this.loginResult());
            return;
         }
         // 玩家主动点登录：每次都要能重新打开登录框（上次可能被他自己关掉了）。
         this.loginPromptSent = false;
         this.notifyLoginRequired();
         if(!this.loginPromptSent)
         {
            // 页面登录框打不开（会话服务故障 / 不在本站播放器里）：按原样立刻回未登录。
            this.callOnce(callback,this.loginResult());
            return;
         }
         if(callback != null) this.pendingLoginCallbacks.push(callback);
         this.armLoginWait();
      }

      private function loginResult() : Object
      {
         return {
            "success":this.loggedIn,
            "loggedIn":this.loggedIn,
            "user":this.simpleGetUser(),
            "error":this.loggedIn ? null : {"code":"not_logged_in"}
         };
      }

      private function armLoginWait() : void
      {
         if(this.loginWaitTimer != null) this.loginWaitTimer.stop();
         this.loginWaitTimer = new Timer(LOGIN_WAIT_MS,1);
         this.loginWaitTimer.addEventListener(TimerEvent.TIMER_COMPLETE,function(event:TimerEvent):void
         {
            flushPendingLogin();
         });
         this.loginWaitTimer.start();
      }

      /** 按当前登录状态回掉全部挂起的 showLogin；回调里再点登录会重新挂起，不会被这一轮吃掉。 */
      private function flushPendingLogin() : void
      {
         if(this.loginWaitTimer != null)
         {
            this.loginWaitTimer.stop();
            this.loginWaitTimer = null;
         }
         if(this.pendingLoginCallbacks.length == 0) return;
         var callbacks:Array = this.pendingLoginCallbacks.splice(0,this.pendingLoginCallbacks.length);
         var result:Object = this.loginResult();
         for each(var callback:Function in callbacks)
         {
            this.callOnce(callback,result);
         }
      }

      /** 简化读档只回一个 value，不把 AGI2 的 keys 容器泄给新游戏。 */
      public function simpleRead(key:String, callback:Function) : void
      {
         if(!this.validKey(key))
         {
            this.callOnce(callback,{"success":false,"error":{"code":"invalid_key"}});
            return;
         }
         this.retrieveFn({
            "key":key,
            "promptLogin":true,
            "callback":function(result:Object):void
            {
               if(result != null && result.success === true)
               {
                  var value:Object = result.keys != null && result.keys.hasOwnProperty(key) ? result.keys[key] : null;
                  callOnce(callback,{"success":true,"key":key,"value":value});
               }
               else
               {
                  callOnce(callback,result);
               }
            }
         });
      }

      public function simpleWrite(key:String, value:Object, callback:Function) : void
      {
         this.submitFn({"key":key,"value":value,"callback":callback});
      }

      public function simpleRemove(key:String, callback:Function) : void
      {
         this.eraseFn({"key":key,"callback":callback});
      }

      /** 旧 AGI2 也可以通过 user.showLogin({callback}) 调同一个站内登录框。 */
      public function showLoginFn(options:Object = null) : void
      {
         this.simpleShowLogin(options == null ? null : options.callback);
      }

      /**
       * 读档。**故意忽略 options.key**，永远取全量：
       * 服务端一次回的就是 { success, keys: { slot1..3 } }，游戏也是整份拿。
       * 单键读取留了接口（服务端支持 key），但这里不改语义 —— 已经核对过的产物就是这么做的。
       */
      public function retrieveFn(options:Object) : void
      {
         var key:String = options == null ? "" : String(options.key);
         var callback:Function = options == null ? null : options.callback;
         if(!this.loggedIn)
         {
            // 旧游戏开局会自动 retrieve，那不是用户意图；只有简化接口显式带了 promptLogin 才弹。
            if(options != null && options.promptLogin === true) this.notifyLoginRequired();
            this.callOnce(callback,{
               "success":false,
               "error":{"code":"not_logged_in"}
            });
            return;
         }
         // 读也进同一条 FIFO；排队超过 30 秒会明确失败，不能越过未完成写入交一份旧档。
         this.enqueue({"kind":"read","callback":callback});
      }

      public function submitFn(options:Object) : void
      {
         var key:String = options == null ? "" : String(options.key);
         var value:Object = options == null ? null : options.value;
         var callback:Function = options == null ? null : options.callback;
         if(!this.validKey(key))
         {
            this.callOnce(callback,{"success":false,"error":{"code":"invalid_key"}});
            return;
         }
         if(!this.loggedIn)
         {
            this.notifyLoginRequired();
            this.callOnce(callback,{
               "success":false,
               "error":{"code":"not_logged_in"}
            });
            return;
         }
         this.enqueue({
            "kind":"write",
            "key":key,
            "value":value,
            "opId":this.nextOpId(),
            "callback":callback
         });
      }

      public function eraseFn(options:Object) : void
      {
         var key:String = options == null ? "" : String(options.key);
         var callback:Function = options == null ? null : options.callback;
         if(!this.validKey(key))
         {
            this.callOnce(callback,{"success":false,"error":{"code":"invalid_key"}});
            return;
         }
         if(!this.loggedIn)
         {
            this.notifyLoginRequired();
            this.callOnce(callback,{
               "success":false,
               "error":{"code":"not_logged_in"}
            });
            return;
         }
         this.enqueue({
            "kind":"delete",
            "key":key,
            "callback":callback
         });
      }

      public function retrievePurchasesFn(options:Object) : void
      {
         this.callOnce(options == null ? null : options.callback,{
            "success":true,
            "purchases":[]
         });
      }

      public function retrieveProductsFn(options:Object) : void
      {
         this.callOnce(options == null ? null : options.callback,{
            "success":true,
            "products":[]
         });
      }

      public function showStoreFn(options:Object) : void
      {
         this.callOnce(options == null ? null : options.callback,{
            "success":false,
            "error":{"code":"store_unavailable"}
         });
      }

      /** 任务进度：第一版不做任务系统，但必须回成功，否则游戏的任务界面会一直转 */
      public function questSubmitFn(options:Object) : void
      {
         var progress:* = options == null ? 1 : options.progress;
         this.callOnce(options == null ? null : options.callback,{
            "success":true,
            "quest":{
               "progress":progress,
               "status":"completed"
            }
         });
      }

      /**
       * 合并最外层游戏与桥自身的 LoaderInfo 参数。
       *
       * 主影片的 FlashVars 有三条路能拿到，按顺序取第一条可用的：
       *   1. 桥自己的 stage.root —— 只有桥被 addChild 到显示列表时才有（新游戏可能这么做）；
       *   2. connect({stage}) 传进来的舞台的第一个子对象（主影片文档类）—— KRF 就是这样调的，
       *      桥本身不在显示列表上，自己的 stage 恒为 null（2026-11-05 Ruffle 实测）；
       *   3. 桥 URL 的 query —— 旧页面 / 不传 stage 的新游戏的兜底，优先级最高，可覆盖同名旧值。
       * 第 2 条让桥不再依赖第 3 条：以后前端若不再把令牌拼进桥 URL（避免进访问日志 / CDN 缓存键），KRF 照样能连上。
       */
      private function readParameters() : void
      {
         var params:Object = {};
         var rootParams:Object = null;
         var bridgeParams:Object = null;
         try
         {
            if(Boolean(stage) && Boolean(stage.root) && Boolean(stage.root.loaderInfo))
            {
               rootParams = stage.root.loaderInfo.parameters;
            }
         }
         catch(error:Error)
         {
            rootParams = null;
         }
         try
         {
            if(rootParams == null && this.connectStage != null)
            {
               if(this.connectStage.numChildren > 0 && this.connectStage.getChildAt(0).loaderInfo != null)
               {
                  rootParams = this.connectStage.getChildAt(0).loaderInfo.parameters;
               }
               else if(this.connectStage.loaderInfo != null)
               {
                  rootParams = this.connectStage.loaderInfo.parameters;
               }
            }
         }
         catch(error:Error)
         {
            // 跨安全域时取不到主影片参数，退回桥 URL query；不能让 connect 本身抛出。
         }
         try
         {
            if(loaderInfo) bridgeParams = loaderInfo.parameters;
         }
         catch(error:Error)
         {
            bridgeParams = null;
         }
         if(rootParams != null)
         {
            for(var rootName:String in rootParams) params[rootName] = rootParams[rootName];
         }
         if(bridgeParams != null)
         {
            // 子桥 URL 的 query 是专门给 AGI2 的参数副本，优先于主影片里同名的旧值。
            for(var bridgeName:String in bridgeParams) params[bridgeName] = bridgeParams[bridgeName];
         }
         this.endpoint = this.stringValue(params.eightbitgo_save_endpoint);
         this.sessionToken = this.stringValue(params.eightbitgo_save_token);
         this.username = this.stringValue(params.eightbitgo_username);
         this.avatarUrl = this.stringValue(params.eightbitgo_avatar_url);
         this.saveMode = this.stringValue(params.eightbitgo_save_mode);
         this.loginCallback = this.stringValue(params.eightbitgo_login_callback);
         this.loggedIn = this.endpoint.length > 0 && this.sessionToken.length > 0;
         if(!this.loggedIn)
         {
            // 未登录是**正常**状态（本地槽照常可用），但排查时总得有一行线索可以说
            trace("[8bitgo-flash-save] 未登录：在线槽不可用（endpoint " + (this.endpoint.length > 0 ? "有" : "无") + "，token " + (this.sessionToken.length > 0 ? "有" : "无") + "）");
         }
      }

      private function stringValue(value:*) : String
      {
         return value == null ? "" : String(value);
      }

      private function validKey(key:String) : Boolean
      {
         return /^slot[1-3]$/.test(String(key));
      }

      private function newSessionId() : String
      {
         var now:String = new Date().getTime().toString(16);
         var noise:String = Math.floor(Math.random() * 0x1000000).toString(16);
         return "s" + now + noise;
      }

      private function nextOpId() : String
      {
         if(this.sessionId.length == 0) this.sessionId = this.newSessionId();
         this.opCounter++;
         return this.sessionId + "-" + this.opCounter;
      }

      private function mergeRevisions(result:Object) : void
      {
         try
         {
            if(result == null || result.revisions == null) return;
            for(var key:String in result.revisions)
            {
               var value:Number = Number(result.revisions[key]);
               if(!isNaN(value)) this.revisions[key] = value;
            }
         }
         catch(error:Error)
         {
            // 代次只影响并发保护，解析失败不能连这次读档也一起弄丢。
         }
      }

      /** 只在真游客主动用在线槽时通知页面；会话服务故障不弹登录。 */
      private function notifyLoginRequired() : void
      {
         if(this.loginPromptSent || this.saveMode != "guest" || this.loginCallback.length == 0) return;
         if(!/^[A-Za-z_$][A-Za-z0-9_$.]{0,127}$/.test(this.loginCallback)) return;
         try
         {
            if(ExternalInterface.available)
            {
               ExternalInterface.call(this.loginCallback,"login_required");
               this.loginPromptSent = true;
            }
         }
         catch(error:Error)
         {
            // 页面提示不可用时，本地档和游戏本体仍要继续跑。
         }
      }

      private function enqueue(task:Object) : void
      {
         var i:int = 0;
         var pending:Object = null;
         var failure:Object = null;
         task.sessionGeneration = this.sessionGeneration;
         // 相邻的读可以共用一次全量读取；它本身是全局顺序边界，不能跨读合并写入。
         if(task.kind == "read" && this.queue.length > 0 &&
            this.queue[this.queue.length - 1].kind == "read" &&
            this.queue[this.queue.length - 1].completed !== true)
         {
            this.appendTaskCallback(this.queue[this.queue.length - 1],task.callback);
            return;
         }
         if(task.kind == "write")
         {
            // 同一键的待发送值是完整快照，只保留最新一份；旧回调随最新快照一起完成。
            // 读 / 删是顺序边界，跨过去合并会改写玩家实际操作顺序。
            for(i = this.queue.length - 1; i >= 0; i--)
            {
               pending = this.queue[i];
               if(pending.sessionGeneration != task.sessionGeneration) break;
               if(pending.kind == "read") break;
               if(pending.key != task.key) continue;
               if(pending.kind == "delete") break;
               if(pending.kind == "write")
               {
                  pending.value = task.value;
                  pending.opId = task.opId;
                  this.appendTaskCallback(pending,task.callback);
                  return;
               }
            }
         }
         else if(task.kind == "delete")
         {
            // 同一键连续删除是幂等操作，合成一条请求并保留全部调用回调。
            for(i = this.queue.length - 1; i >= 0; i--)
            {
               pending = this.queue[i];
               if(pending.sessionGeneration != task.sessionGeneration) break;
               if(pending.kind == "read") break;
               if(pending.key != task.key) continue;
               if(pending.kind == "delete")
               {
                  this.appendTaskCallback(pending,task.callback);
                  return;
               }
               break;
            }
         }
         if(this.queue.length >= MAX_QUEUED_TASKS)
         {
            // 存档 JSON 可能很大；极端异常连发时明确拒绝，不让未发送快照无限占内存。
            failure = {"success":false,"error":{"code":"queue_full"}};
            if(task.kind == "read") failure.keys = {};
            this.callTaskCallback(task,failure);
            return;
         }
         this.queue.push(task);
         if(task.kind == "read") this.armReadTimeout(task);
         this.pump();
      }

      private function pump() : void
      {
         var task:Object = null;
         if(this.busy)
         {
            return;
         }
         if(this.queue.length == 0)
         {
            return;
         }
         this.busy = true;
         task = this.queue.shift();
         if(task.completed === true)
         {
            this.busy = false;
            this.pump();
            return;
         }
         if(task.sessionGeneration != this.sessionGeneration)
         {
            this.callTaskCallback(task,{"success":false,"keys":{},"error":{"code":"session_changed"}});
            this.busy = false;
            this.pump();
         }
         else if(!this.loggedIn)
         {
            this.callTaskCallback(task,{"success":false,"keys":{},"error":{"code":"not_logged_in"}});
            this.busy = false;
            this.pump();
         }
         else if(task.kind == "read")
         {
            this.readTask(task);
         }
         else if(task.kind == "write")
         {
            this.submitWrite(task,0);
         }
         else
         {
            var deleteGeneration:int = task.sessionGeneration;
            this.post("/delete-slot",{
               "sessionToken":this.sessionToken,
               "key":task.key
            },function(result:Object):void
            {
               if(deleteGeneration != sessionGeneration)
               {
                  callTaskCallback(task,{"success":false,"error":{"code":"session_changed"}});
               }
               else if(result != null && result.success === true && result.data != null && result.data.revision != null)
               {
                  revisions[task.key] = Number(result.data.revision);
               }
               else
               {
                  delete revisions[task.key];
               }
               callTaskCallback(task,Boolean(result) && Boolean(result.success) ? {"success":true} : {
                  "success":false,
                  "error":errorCode(result)
               });
               busy = false;
               pump();
            });
         }
      }

      private function readTask(task:Object) : void
      {
         var readGeneration:int = task.sessionGeneration;
         this.post("/read",{"sessionToken":this.sessionToken},function(result:Object):void
         {
            if(readGeneration != sessionGeneration)
            {
               callTaskCallback(task,{"success":false,"keys":{},"error":{"code":"session_changed"}});
               busy = false;
               pump();
               return;
            }
            // 空账号由服务端回 keys:{}；再兜底一次，避免旧游戏对 null 做 for-in。
            if(result == null) result = {"success":false,"error":{"code":"network_error"}};
            if(result.keys == null) result.keys = {};
            mergeRevisions(result);
            callTaskCallback(task,result);
            busy = false;
            pump();
         });
      }

      /** 排队等待过久时明确失败，而不是让游戏无限转圈或后来误收到一份过期读取。 */
      private function armReadTimeout(task:Object) : void
      {
         var owner:KrfAgiBridge = this;
         var timer:Timer = new Timer(30000,1);
         task.timeoutTimer = timer;
         task.timeoutHandler = function(event:TimerEvent):void
         {
            var index:int = owner.queue.indexOf(task);
            if(index >= 0) owner.queue.splice(index,1);
            owner.callTaskCallback(task,{
               "success":false,
               "keys":{},
               "error":{"code":"timeout"}
            });
            owner.pump();
         };
         timer.addEventListener(TimerEvent.TIMER_COMPLETE,task.timeoutHandler);
         timer.start();
      }

      private function appendTaskCallback(task:Object, callback:Function) : void
      {
         if(!(task.callbacks is Array))
         {
            task.callbacks = [];
            if(task.callback != null) task.callbacks.push(task.callback);
            task.callback = null;
         }
         task.callbacks.push(callback);
      }

      private function callTaskCallback(task:Object, result:Object) : void
      {
         if(task.completed === true) return;
         task.completed = true;
         if(task.timeoutTimer != null)
         {
            task.timeoutTimer.stop();
            task.timeoutTimer.removeEventListener(TimerEvent.TIMER_COMPLETE,task.timeoutHandler);
            task.timeoutTimer = null;
            task.timeoutHandler = null;
         }
         var callbacks:Array = task.callbacks as Array;
         var callback:Function = task.callback as Function;
         task.callbacks = null;
         task.callback = null;
         if(callbacks)
         {
            for each(var groupedCallback:Function in callbacks) this.callOnce(groupedCallback,result);
         }
         else
         {
            this.callOnce(callback,result);
         }
      }

      /**
       * 写一槽，失败先重试一次再报给游戏。
       *
       * 和 AGI1 同理：游戏多半忽略回调里的错误，一次网络抖动就等于玩家这一程的进度白跑。
       * 服务端写入是 upsert，重试天然幂等；重试期间 busy 没清，后面的保存会排队等它。
       * 会话已失效就不再重试 —— 重试多少次都是同一个 401。
       */
      private function submitWrite(task:Object, attempt:int) : void
      {
         if(task.sessionGeneration != this.sessionGeneration)
         {
            this.callTaskCallback(task,{"success":false,"error":{"code":"session_changed"}});
            this.busy = false;
            this.pump();
            return;
         }
         var body:Object = {
            "sessionToken":this.sessionToken,
            "key":task.key,
            "value":task.value
         };
         // 同一次逻辑保存的重试复用 opId，避免超时后已成功的请求被再写一遍。
         if(task.opId != null) body.opId = task.opId;
         // 只在先读过该槽、知道服务端代次时做条件更新；老响应没代次时保留兼容降级。
         if(this.revisions[task.key] != null) body.expectedRevision = this.revisions[task.key];
         var writeGeneration:int = task.sessionGeneration;
         this.post("/write-slot",body,function(result:Object):void
         {
            if(writeGeneration != sessionGeneration)
            {
               callTaskCallback(task,{"success":false,"error":{"code":"session_changed"}});
               busy = false;
               pump();
               return;
            }
            var ok:Boolean = Boolean(result) && Boolean(result.success);
            if(ok && result.data != null && result.data.revision != null)
            {
               revisions[task.key] = Number(result.data.revision);
            }
            else if(result != null && String(errorCode(result).code) == "stale_write")
            {
               // 新服务端会返回当前代次；继续做条件更新，不能降级成无条件覆盖。
               if(result.error != null && result.error.currentRevision != null &&
                  !isNaN(Number(result.error.currentRevision)))
               {
                  revisions[task.key] = Number(result.error.currentRevision);
               }
               else
               {
                  // 兼容还没下发 currentRevision 的旧服务端。
                  delete revisions[task.key];
               }
               trace("[8bitgo-flash-save] " + task.key + " 的保存基于旧版本，已丢弃");
            }
            if(!ok && loggedIn && attempt < 1 && retriable(result))
            {
               var timer:Timer = new Timer(800,1);
               timer.addEventListener(TimerEvent.TIMER_COMPLETE,function(event:TimerEvent):void
               {
                  submitWrite(task,attempt + 1);
               });
               timer.start();
               return;
            }
            callTaskCallback(task, ok ? {"success":true} : {
               "success":false,
               "error":errorCode(result)
            });
            busy = false;
            pump();
         });
      }

      /** 只有「这次没送到」值得重试；会话失效 / 参数错 / 超限重试多少次都一样 */
      private function retriable(result:Object) : Boolean
      {
         var code:String = String(errorCode(result).code);
         return code == "network_error" || code == "timeout" || code == "bad_response" || code == "request_failed";
      }

      private function errorCode(result:Object) : Object
      {
         try
         {
            if(Boolean(result) && Boolean(result.error) && Boolean(result.error.code))
            {
               return {"code":String(result.error.code)};
            }
         }
         catch(error:Error)
         {
         }
         return {"code":"network_error"};
      }

      private function post(path:String, body:Object, callback:Function) : void
      {
         var loader:URLLoader = new URLLoader();
         var timer:Timer = new Timer(12000,1);
         var finished:Boolean = false;
         var requestGeneration:int = this.sessionGeneration;

         /**
          * 把响应体解析成服务端对象；不是我们那套形状就返回 null。
          *
          * ⚠️ **失败回调里也必须能用**：HTTP 4xx/5xx 在不少播放器（含 Ruffle）里走的是
          * ioErrorEvent，但响应体仍躺在 loader.data 上。不看它就等于把 invalid_session
          * 一律报成 network_error —— 游戏分不清「网断了」和「会话过期」，
          * 而后者只有玩家自己能解决（重进一局）。
          */
         var parseBody:Function = function(raw:*) : Object
         {
            try
            {
               if(raw == null)
               {
                  return null;
               }
               var text:String = String(raw);
               if(text.length == 0)
               {
                  return null;
               }
               var parsed:Object = decodeJson(text) as Object;
               return parsed != null && parsed.success !== undefined ? parsed : null;
            }
            catch(error:Error)
            {
               return null;
            }
         };

         var done:Function = function(result:Object):void
         {
            if(finished)
            {
               return;
            }
            finished = true;
            timer.stop();
            loader.removeEventListener(Event.COMPLETE,onComplete);
            loader.removeEventListener(IOErrorEvent.IO_ERROR,onFailure);
            loader.removeEventListener(SecurityErrorEvent.SECURITY_ERROR,onFailure);
            /*
               会话过期就把登录态摘掉，游戏据此把在线槽重新标成不可用。
               不摘的话它一直显示「能存」，玩家以为进度在云上，其实每条都被服务端拒掉。
            */
            if(requestGeneration == sessionGeneration && result != null && result.success === false && String(errorCode(result).code) == "invalid_session")
            {
               loggedIn = false;
            }
            callOnce(callback,result);
         };

         var onComplete:Function = function(event:Event):void
         {
            var parsed:Object = parseBody(loader.data);
            done(parsed != null ? parsed : {"success":false,"error":{"code":"bad_response"}});
         };

         var onFailure:Function = function(event:Event):void
         {
            var recovered:Object = parseBody(loader.data);
            done(recovered != null ? recovered : {"success":false,"error":{"code":"network_error"}});
         };

         timer.addEventListener(TimerEvent.TIMER_COMPLETE,function(event:TimerEvent):void
         {
            try
            {
               loader.close();
            }
            catch(error:Error)
            {
            }
            done({"success":false,"error":{"code":"timeout"}});
         });

         loader.addEventListener(Event.COMPLETE,onComplete);
         loader.addEventListener(IOErrorEvent.IO_ERROR,onFailure);
         loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,onFailure);

         try
         {
            var request:URLRequest = new URLRequest(this.endpoint + path);
            request.method = URLRequestMethod.POST;
            request.contentType = "application/json";
            request.data = this.encodeJson(body,0);
            timer.start();
            loader.load(request);
         }
         catch(error:Error)
         {
            done({"success":false,"error":{"code":"request_failed"}});
         }
      }

      /* ---------------- JSON 编解码（SWF 10 宿主里没有顶层 JSON，见类注释） ---------------- */

      /**
       * 与 JSON.stringify 对普通数据的输出一致：undefined / 函数的属性跳过、在数组里变 null，
       * NaN / Infinity 变 null。深度超过 64 直接抛出（循环引用），由 post() 报 request_failed。
       */
      private function encodeJson(value:*, depth:int) : String
      {
         var parts:Array = null;
         var i:int = 0;
         if(depth > 64) throw new Error("JSON 嵌套过深或存在循环引用");
         if(value === null || value === undefined) return "null";
         if(value is String) return this.quoteJson(String(value));
         if(value is Boolean) return value ? "true" : "false";
         if(value is Number)
         {
            var number:Number = Number(value);
            return isFinite(number) ? String(number) : "null";
         }
         if(value is Function) return "null";
         if(value is Date) return this.quoteJson(String(value));
         parts = [];
         if(value is Array)
         {
            var list:Array = value as Array;
            for(i = 0; i < list.length; i++)
            {
               var item:* = list[i];
               parts.push(item === undefined || item is Function ? "null" : this.encodeJson(item,depth + 1));
            }
            return "[" + parts.join(",") + "]";
         }
         for(var key:String in value)
         {
            var field:* = value[key];
            if(field === undefined || field is Function) continue;
            parts.push(this.quoteJson(key) + ":" + this.encodeJson(field,depth + 1));
         }
         return "{" + parts.join(",") + "}";
      }

      private function quoteJson(value:String) : String
      {
         var out:Array = null;
         var start:int = 0;
         var length:int = value.length;
         for(var i:int = 0; i < length; i++)
         {
            var code:Number = value.charCodeAt(i);
            var escaped:String = null;
            if(code == 34) escaped = "\\\"";
            else if(code == 92) escaped = "\\\\";
            else if(code < 32 || code == 0x2028 || code == 0x2029)
            {
               if(code == 10) escaped = "\\n";
               else if(code == 13) escaped = "\\r";
               else if(code == 9) escaped = "\\t";
               else
               {
                  var hex:String = code.toString(16);
                  while(hex.length < 4) hex = "0" + hex;
                  escaped = "\\u" + hex;
               }
            }
            if(escaped != null)
            {
               if(out == null) out = [];
               if(i > start) out.push(value.substring(start,i));
               out.push(escaped);
               start = i + 1;
            }
         }
         if(out == null) return "\"" + value + "\"";
         if(start < length) out.push(value.substring(start));
         return "\"" + out.join("") + "\"";
      }

      /** 严格解析（RFC 8259）；格式不对就抛，parseBody 会把它当成 bad_response。 */
      private function decodeJson(text:String) : *
      {
         this.jsonText = text;
         this.jsonPos = 0;
         try
         {
            var value:* = this.jsonValue(0);
            this.jsonSkip();
            if(this.jsonPos != this.jsonText.length) throw new Error("JSON 末尾有多余内容");
            return value;
         }
         finally
         {
            this.jsonText = "";
            this.jsonPos = 0;
         }
         return null;
      }

      private function jsonSkip() : void
      {
         var length:int = this.jsonText.length;
         while(this.jsonPos < length)
         {
            var code:Number = this.jsonText.charCodeAt(this.jsonPos);
            if(code != 32 && code != 9 && code != 10 && code != 13) return;
            this.jsonPos++;
         }
      }

      private function jsonValue(depth:int) : *
      {
         if(depth > 64) throw new Error("JSON 嵌套过深");
         this.jsonSkip();
         if(this.jsonPos >= this.jsonText.length) throw new Error("JSON 提前结束");
         var code:Number = this.jsonText.charCodeAt(this.jsonPos);
         if(code == 123) return this.jsonObject(depth);
         if(code == 91) return this.jsonArray(depth);
         if(code == 34) return this.jsonString();
         if(this.jsonText.substr(this.jsonPos,4) == "true")
         {
            this.jsonPos += 4;
            return true;
         }
         if(this.jsonText.substr(this.jsonPos,5) == "false")
         {
            this.jsonPos += 5;
            return false;
         }
         if(this.jsonText.substr(this.jsonPos,4) == "null")
         {
            this.jsonPos += 4;
            return null;
         }
         return this.jsonNumber();
      }

      private function jsonObject(depth:int) : Object
      {
         var result:Object = {};
         this.jsonPos++;
         this.jsonSkip();
         if(this.jsonText.charCodeAt(this.jsonPos) == 125)
         {
            this.jsonPos++;
            return result;
         }
         while(true)
         {
            this.jsonSkip();
            if(this.jsonText.charCodeAt(this.jsonPos) != 34) throw new Error("JSON 对象键必须是字符串");
            var key:String = this.jsonString();
            this.jsonSkip();
            if(this.jsonText.charCodeAt(this.jsonPos) != 58) throw new Error("JSON 缺少冒号");
            this.jsonPos++;
            result[key] = this.jsonValue(depth + 1);
            this.jsonSkip();
            var next:Number = this.jsonText.charCodeAt(this.jsonPos);
            this.jsonPos++;
            if(next == 125) return result;
            if(next != 44) throw new Error("JSON 对象分隔符错误");
         }
         return result;
      }

      private function jsonArray(depth:int) : Array
      {
         var result:Array = [];
         this.jsonPos++;
         this.jsonSkip();
         if(this.jsonText.charCodeAt(this.jsonPos) == 93)
         {
            this.jsonPos++;
            return result;
         }
         while(true)
         {
            result.push(this.jsonValue(depth + 1));
            this.jsonSkip();
            var next:Number = this.jsonText.charCodeAt(this.jsonPos);
            this.jsonPos++;
            if(next == 93) return result;
            if(next != 44) throw new Error("JSON 数组分隔符错误");
         }
         return result;
      }

      private function jsonString() : String
      {
         var text:String = this.jsonText;
         var length:int = text.length;
         var out:Array = null;
         var start:int = ++this.jsonPos;
         while(true)
         {
            if(this.jsonPos >= length) throw new Error("JSON 字符串没有结束");
            var code:Number = text.charCodeAt(this.jsonPos);
            if(code == 34)
            {
               var tail:String = text.substring(start,this.jsonPos);
               this.jsonPos++;
               if(out == null) return tail;
               out.push(tail);
               return out.join("");
            }
            if(code == 92)
            {
               if(out == null) out = [];
               out.push(text.substring(start,this.jsonPos));
               var escape:Number = text.charCodeAt(this.jsonPos + 1);
               this.jsonPos += 2;
               if(escape == 34) out.push("\"");
               else if(escape == 92) out.push("\\");
               else if(escape == 47) out.push("/");
               else if(escape == 98) out.push(String.fromCharCode(8));
               else if(escape == 102) out.push(String.fromCharCode(12));
               else if(escape == 110) out.push("\n");
               else if(escape == 114) out.push("\r");
               else if(escape == 116) out.push("\t");
               else if(escape == 117)
               {
                  var hex:String = text.substr(this.jsonPos,4);
                  if(!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error("JSON \\u 转义不完整");
                  out.push(String.fromCharCode(parseInt(hex,16)));
                  this.jsonPos += 4;
               }
               else throw new Error("JSON 未知转义");
               start = this.jsonPos;
               continue;
            }
            if(code < 32) throw new Error("JSON 字符串里有未转义的控制字符");
            this.jsonPos++;
         }
         return "";
      }

      private function jsonNumber() : Number
      {
         var text:String = this.jsonText;
         var start:int = this.jsonPos;
         var length:int = text.length;
         while(this.jsonPos < length)
         {
            var code:Number = text.charCodeAt(this.jsonPos);
            // - + . 0-9 e E
            if(code == 45 || code == 43 || code == 46 || (code >= 48 && code <= 57) || code == 101 || code == 69) this.jsonPos++;
            else break;
         }
         var raw:String = text.substring(start,this.jsonPos);
         if(!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(raw)) throw new Error("JSON 数字格式错误");
         return Number(raw);
      }

      private function callOnce(callback:Function, value:Object) : void
      {
         if(callback == null)
         {
            return;
         }
         try
         {
            callback(value);
         }
         catch(error:Error)
         {
            // 游戏的回调抛异常不能卡住后面排队的保存
         }
      }
   }
}

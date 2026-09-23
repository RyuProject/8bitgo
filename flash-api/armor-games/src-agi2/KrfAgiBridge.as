package
{
   import flash.display.Sprite;
   import flash.events.Event;
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
    */
   public dynamic class KrfAgiBridge extends Sprite
   {
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
      /** 每个槽的服务端代次，用来拒绝弱网下迟到的旧写入。 */
      private var revisions:Object = {};
      /** 页面会话内的操作 ID；同一次写入重试时复用，服务端才能幂等去重。 */
      private var sessionId:String = "";
      private var opCounter:int = 0;

      /**
       * 写入 / 删除的串行队列。
       * 用一个全局队列而不是每个槽一个：AGI2 的一次提交就是一份完整档，
       * 串行化保证「后点的保存」一定在「先点的保存」之后落库。
       */
      private var queue:Array;
      private var busy:Boolean = false;

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
      }

      /** options 里可以带 callback；游戏拿它判断「桥起来了没有」 */
      public function connect(options:Object = null) : void
      {
         this.readParameters();
         this.sessionId = this.newSessionId();
         this.opCounter = 0;
         this.revisions = {};
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
         if(!this.loggedIn) this.notifyLoginRequired();
         this.callOnce(callback,{
            "success":this.loggedIn,
            "loggedIn":this.loggedIn,
            "user":this.simpleGetUser(),
            "error":this.loggedIn ? null : {"code":"not_logged_in"}
         });
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
         this.waitForQueue(function():void
         {
            post("/read",{"sessionToken":sessionToken},function(result:Object):void
            {
               // 一个槽都没有时服务端回的是 { success:true, keys:{} }；这里再兜一层，
               // 免得游戏拿到 keys == null 就去 for-in 报错
               if(Boolean(result.success) && result.keys == null)
               {
                  result.keys = {};
               }
               mergeRevisions(result);
               callOnce(callback,result);
            });
         });
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
       * 从最外层游戏的 LoaderInfo 读 FlashVars。
       * 桥是子 Loader，所以参数挂在 stage.root 上；拿不到就退回自己的 loaderInfo。
       */
      private function readParameters() : void
      {
         var params:Object = {};
         try
         {
            if(Boolean(stage) && Boolean(stage.root) && Boolean(stage.root.loaderInfo))
            {
               params = stage.root.loaderInfo.parameters;
            }
            else if(loaderInfo)
            {
               params = loaderInfo.parameters;
            }
         }
         catch(error:Error)
         {
            params = {};
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

      /**
       * 读档前等排队中的写 / 删结束，避免玩家刚存完就看到旧档。
       * 最多等 3 秒，极端弱网下宁可回旧档，也不能让读档界面无限转圈。
       */
      private function waitForQueue(proceed:Function, waited:int = 0) : void
      {
         if((!this.busy && this.queue.length == 0) || waited >= 3000)
         {
            proceed();
            return;
         }
         var timer:Timer = new Timer(60,1);
         timer.addEventListener(TimerEvent.TIMER_COMPLETE,function(event:TimerEvent):void
         {
            waitForQueue(proceed,waited + 60);
         });
         timer.start();
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
         this.queue.push(task);
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
         if(task.kind == "write")
         {
            this.submitWrite(task,0);
         }
         else
         {
            this.post("/delete-slot",{
               "sessionToken":this.sessionToken,
               "key":task.key
            },function(result:Object):void
            {
               if(result != null && result.success === true && result.data != null && result.data.revision != null)
               {
                  revisions[task.key] = Number(result.data.revision);
               }
               else
               {
                  delete revisions[task.key];
               }
               callOnce(task.callback,Boolean(result) && Boolean(result.success) ? {"success":true} : {
                  "success":false,
                  "error":errorCode(result)
               });
               busy = false;
               pump();
            });
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
         var body:Object = {
            "sessionToken":this.sessionToken,
            "key":task.key,
            "value":task.value
         };
         // 同一次逻辑保存的重试复用 opId，避免超时后已成功的请求被再写一遍。
         if(task.opId != null) body.opId = task.opId;
         // 只在先读过该槽、知道服务端代次时做条件更新；老响应没代次时保留兼容降级。
         if(this.revisions[task.key] != null) body.expectedRevision = this.revisions[task.key];
         this.post("/write-slot",body,function(result:Object):void
         {
            var ok:Boolean = Boolean(result) && Boolean(result.success);
            if(ok && result.data != null && result.data.revision != null)
            {
               revisions[task.key] = Number(result.data.revision);
            }
            else if(result != null && String(errorCode(result).code) == "stale_write")
            {
               // 留着过期代次会让之后每次保存都撞 409；丢掉后下一次降级为无条件写入。
               delete revisions[task.key];
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
            callOnce(task.callback, ok ? {"success":true} : {
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
               var parsed:Object = JSON.parse(text);
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
            if(result != null && result.success === false && String(errorCode(result).code) == "invalid_session")
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
            request.data = JSON.stringify(body);
            timer.start();
            loader.load(request);
         }
         catch(error:Error)
         {
            done({"success":false,"error":{"code":"request_failed"}});
         }
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

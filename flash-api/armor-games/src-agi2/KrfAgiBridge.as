package
{
   import flash.display.Sprite;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.events.SecurityErrorEvent;
   import flash.events.TimerEvent;
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
      /** 四个命名空间。游戏在 connect() 之后直接读它们，必须是公开属性 */
      public var user:Object;
      public var storage:Object;
      public var content:Object;
      public var quests:Object;

      private var endpoint:String = "";
      private var sessionToken:String = "";
      private var username:String = "";
      private var avatarUrl:String = "";
      private var loggedIn:Boolean = false;

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
            }
         };

         this.storage = {
            "user": {
               "retrieve": this.retrieveFn,
               "submit": this.submitFn,
               "erase": this.eraseFn
            }
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
         this.callOnce(options == null ? null : options.callback, {"success":true});
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
            this.callOnce(callback,{
               "success":false,
               "error":{"code":"not_logged_in"}
            });
            return;
         }
         this.post("/read",{"sessionToken":this.sessionToken},function(result:Object):void
         {
            // 一个槽都没有时服务端回的是 { success:true, keys:{} }；这里再兜一层，
            // 免得游戏拿到 keys == null 就去 for-in 报错
            if(Boolean(result.success) && result.keys == null)
            {
               result.keys = {};
            }
            callOnce(callback,result);
         });
      }

      public function submitFn(options:Object) : void
      {
         var key:String = options == null ? "" : String(options.key);
         var value:Object = options == null ? null : options.value;
         var callback:Function = options == null ? null : options.callback;
         if(!this.loggedIn)
         {
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
            "callback":callback
         });
      }

      public function eraseFn(options:Object) : void
      {
         var key:String = options == null ? "" : String(options.key);
         var callback:Function = options == null ? null : options.callback;
         if(!this.loggedIn)
         {
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
         this.post("/write-slot",{
            "sessionToken":this.sessionToken,
            "key":task.key,
            "value":task.value
         },function(result:Object):void
         {
            var ok:Boolean = Boolean(result) && Boolean(result.success);
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

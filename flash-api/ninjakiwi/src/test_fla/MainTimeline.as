package test_fla
{
   import flash.display.MovieClip;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.events.SecurityErrorEvent;
   import flash.external.ExternalInterface;
   import flash.net.URLLoader;
   import flash.net.URLLoaderDataFormat;
   import flash.net.URLRequest;
   import flash.net.URLRequestMethod;
   import flash.utils.setTimeout;

   /**
    * SAS3 所依赖的 Banana.swf 最小兼容层。
    *
    * 原版 Banana 只是一个可动态调用的方法集合；SAS3 自己负责登录提示、游客 SharedObject
    * 和存档迁移。旧 mynK 网关退役后，继续代理原文件只会让玩家把账号信息送进 500 接口，
    * 所以这里保留游戏真正使用的接口与冒泡事件，把身份和主进度改接 8BitGo 短期会话。
    */
   public dynamic class MainTimeline extends MovieClip
   {
      private static const SAVE_KEY:String = "slot1";

      private var endpoint:String = "";
      private var sessionToken:String = "";
      private var username:String = "";
      private var saveMode:String = "";
      private var loginCallback:String = "";
      private var loggedIn:Boolean = false;
      /** 读档失败时本局禁止写云端，避免把暂时读不到的旧档覆盖成游客档。 */
      private var cloudReady:Boolean = false;
      private var dataHandler:Function = null;
      private var revision:Number = 0;
      private var opCounter:int = 0;
      private var loginPromptSent:Boolean = false;

      public function MainTimeline()
      {
         super();
         if(stage) this.startup();
         else addEventListener(Event.ADDED_TO_STAGE,this.onAdded);
      }

      private function onAdded(event:Event) : void
      {
         removeEventListener(Event.ADDED_TO_STAGE,this.onAdded);
         this.startup();
      }

      private function startup() : void
      {
         this.readParameters();
         this.loggedIn = this.saveMode == "authenticated" && this.endpoint.length > 0 && this.sessionToken.length > 0;
         // Loader 的 COMPLETE 与游戏侧监听器在同一轮事件里安装；延后一拍，避免连接事件抢跑。
         setTimeout(this.announceConnection,0);
      }

      private function announceConnection() : void
      {
         dispatchEvent(new Event("connected",true));
         dispatchEvent(new Event(this.loggedIn ? "logged in" : "logged out",true));
      }

      private function readParameters() : void
      {
         var params:Object = {};
         try
         {
            // Banana 是子 Loader；8BitGo 会话参数在最外层主 SWF 的 LoaderInfo 上。
            if(stage && stage.root && stage.root.loaderInfo) params = stage.root.loaderInfo.parameters;
            else if(loaderInfo) params = loaderInfo.parameters;
         }
         catch(error:Error)
         {
            params = {};
         }
         this.endpoint = this.stringValue(params.eightbitgo_save_endpoint);
         this.sessionToken = this.stringValue(params.eightbitgo_save_token);
         this.username = this.stringValue(params.eightbitgo_username);
         this.saveMode = this.stringValue(params.eightbitgo_save_mode);
         this.loginCallback = this.stringValue(params.eightbitgo_login_callback);
      }

      public function getVersion() : String
      {
         return "8bitgo-sas3-banana-1";
      }

      public function getUserName() : String
      {
         return this.loggedIn ? this.username : "";
      }

      public function getUserID() : String
      {
         // SAS3 只把它当非空身份标记；不把数据库主键或完整 JWT 暴露给旧 SWF。
         return this.loggedIn ? this.username : "";
      }

      public function enforcedLogin() : void
      {
         this.notifyLoginRequired();
      }

      /**
       * 登录态进入时 SAS3 安装这个回调。空云档会传 {}，游戏随后自动把游客本地档迁到云端；
       * 网络错误也传 {} 让游戏可继续，但 cloudReady 保持 false，本局不会反向覆盖服务器。
       */
      public function setDataHandler(callback:Function) : void
      {
         this.dataHandler = callback;
         if(callback == null || !this.loggedIn) return;
         this.post("/read",{"sessionToken":this.sessionToken,"key":SAVE_KEY},function(result:Object):void
         {
            if(result != null && result.success === true)
            {
               cloudReady = true;
               mergeRevision(result);
               var value:Object = result.keys != null && result.keys[SAVE_KEY] != null ? result.keys[SAVE_KEY] : {};
               callOnce(dataHandler,value);
            }
            else
            {
               cloudReady = false;
               callOnce(dataHandler,{});
            }
         });
      }

      /** 游戏每次保存给的是完整对象，所以直接覆盖 slot1，不存在半份档拼错的问题。 */
      public function save(data:Object, force:Boolean = false) : void
      {
         if(!this.loggedIn || !this.cloudReady || data == null)
         {
            dispatchEvent(new Event("save error",true));
            return;
         }
         var body:Object = {
            "sessionToken":this.sessionToken,
            "key":SAVE_KEY,
            "value":data,
            "opId":this.nextOpId(),
            "expectedRevision":this.revision
         };
         this.post("/write-slot",body,function(result:Object):void
         {
            if(result != null && result.success === true)
            {
               if(result.data != null && !isNaN(Number(result.data.revision))) revision = Number(result.data.revision);
               dispatchEvent(new Event("save ok",true));
            }
            else
            {
               dispatchEvent(new Event("save error",true));
            }
         });
      }

      /* ---------- SAS3 会探测、但不影响账号进度的旧 Banana 方法 ---------- */

      public function callServer(command:String, callback:Function, ... rest) : void
      {
         // additional-data 是旧活动 / 购买扩展，不是角色主进度。明确回空比让游戏无限等回调安全。
         this.callOnce(callback,null);
      }

      public function getServerTime() : void {}
      public function loginAsKongUser(name:String, id:String, token:String) : void { this.notifyLoginRequired(); }
      public function track(... rest) : void {}
      public function forceTrack(... rest) : void {}
      public function showLeaderboard(... rest) : void {}
      public function showAchievements(... rest) : void {}
      public function setAchievement(... rest) : void {}
      public function addAwesome(... rest) : void {}
      public function checkReward(... rest) : void {}
      public function claimReward(... rest) : void {}
      public function redeemCode(... rest) : void {}
      public function getConsecutiveLoginDaysCount(... rest) : void {}
      public function getCurrencyBalance(... rest) : void {}
      public function buyCurrencyItems(... rest) : void {}
      public function getCurrency(... rest) : void {}
      public function getPremiumCurrencyInventoryForGame(... rest) : void {}
      public function showItem(... rest) : void {}
      public function showItems(... rest) : void {}
      public function showStoreShop(... rest) : void {}
      public function showSpecials(... rest) : void {}

      public function setScore(score:Number, callback:Function = null, privateScore:Boolean = false, board:int = 0) : void
      {
         this.callOnce(callback,{"success":false,"error":"unsupported"});
      }

      public function getItemInfo(items:Array = null) : Array
      {
         return [];
      }

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
            // 登录框不可用不能影响游客本地进度或联机。
         }
      }

      private function post(path:String, body:Object, callback:Function) : void
      {
         var request:URLRequest = new URLRequest(this.endpoint + path);
         request.method = URLRequestMethod.POST;
         request.contentType = "application/json";
         request.data = JSON.stringify(body);
         var loader:URLLoader = new URLLoader();
         loader.dataFormat = URLLoaderDataFormat.TEXT;
         var done:Boolean = false;
         var finish:Function = function(result:Object):void
         {
            if(done) return;
            done = true;
            callOnce(callback,result);
         };
         loader.addEventListener(Event.COMPLETE,function(event:Event):void
         {
            try
            {
               finish(JSON.parse(String(loader.data)));
            }
            catch(error:Error)
            {
               finish({"success":false,"error":{"code":"invalid_response"}});
            }
         });
         loader.addEventListener(IOErrorEvent.IO_ERROR,function(event:IOErrorEvent):void
         {
            finish({"success":false,"error":{"code":"network_error"}});
         });
         loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,function(event:SecurityErrorEvent):void
         {
            finish({"success":false,"error":{"code":"security_error"}});
         });
         try
         {
            loader.load(request);
         }
         catch(error:Error)
         {
            finish({"success":false,"error":{"code":"network_error"}});
         }
      }

      private function mergeRevision(result:Object) : void
      {
         try
         {
            if(result != null && result.revisions != null && !isNaN(Number(result.revisions[SAVE_KEY])))
            {
               this.revision = Number(result.revisions[SAVE_KEY]);
            }
         }
         catch(error:Error)
         {
            // 旧服务端没有 revisions 时按 0 开始；读档本身仍然有效。
         }
      }

      private function nextOpId() : String
      {
         this.opCounter++;
         return "sas3-" + new Date().time.toString(36) + "-" + this.opCounter.toString(36) + "-" + int(Math.random() * 0x7fffffff).toString(36);
      }

      private function callOnce(callback:Function, value:Object) : void
      {
         if(callback == null) return;
         try { callback(value); } catch(error:Error) {}
      }

      private function stringValue(value:*) : String
      {
         return value == null ? "" : String(value);
      }
   }
}

package test_fla
{
   import flash.display.MovieClip;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.events.SecurityErrorEvent;
   import flash.events.TimerEvent;
   import flash.net.URLLoader;
   import flash.net.URLRequest;
   import flash.net.URLRequestMethod;
   import flash.utils.Timer;
   import flash.utils.getTimer;

   /**
    * Armor Games AGI 的最小兼容层。
    *
    * 类名保持 MainTimeline 是因为构建脚本借 Ruffle 的开源回归测试 SWF 作空壳，再由
    * FFDec 重编译文档类。它必须就是 id=0 的根类，Loader.content 才能直接看到这些方法。
    */
   public dynamic class MainTimeline extends MovieClip
   {
      private var endpoint:String = "";
      private var sessionToken:String = "";
      private var username:String = "";
      private var avatarUrl:String = "";
      private var loggedIn:Boolean = false;
      private var gameAccepted:Boolean = false;
      private var pendingPairs:Object = {};
      private var queues:Object = {};
      private var busy:Object = {};
      private var lastDelete:Object = {};
      private var scoreboardClose:Function = null;

      public function MainTimeline()
      {
         super();
      }

      /** devKey 只为兼容旧签名；身份只认父页面下发的短期会话令牌。 */
      public function init(devKey:String, gameKey:String) : void
      {
         readParameters();
         gameAccepted = gameKey == "infect-2";
         loggedIn = gameAccepted && endpoint.length > 0 && sessionToken.length > 0;
      }

      public function isLoggedIn() : Boolean
      {
         return loggedIn;
      }

      public function getUserData() : Object
      {
         return {"username":username,"avatar_url":avatarUrl};
      }

      public function getUserName() : String
      {
         return username;
      }

      public function showLogin(callback:Function) : void
      {
         callOnce(callback, {
            "success":true,
            "loggedIn":loggedIn,
            "username":username,
            "avatar_url":avatarUrl
         });
      }

      /**
       * 原游戏先交 profile、紧接着再交 data。两半都在才入队；任何一半超时都失败，
       * 防止下一次保存把旧 profile 和新 data 拼成一份表面正常、实际损坏的档。
       */
      public function submitUserData(key:String, data:Object, callback:Function) : void
      {
         if(!loggedIn)
         {
            callOnce(callback,{"success":false,"error":"not_logged_in"});
            return;
         }
         var parsed:Object = parseKey(key);
         if(!parsed)
         {
            callOnce(callback,{"success":false,"error":"invalid_key"});
            return;
         }
         var slot:int = int(parsed.slot);
         var state:Object = pendingPairs[slot];
         if(!state)
         {
            state = newPair(slot);
            pendingPairs[slot] = state;
         }
         if(state[parsed.kind] != null)
         {
            failPair(slot,state,"duplicate_part");
            state = newPair(slot);
            pendingPairs[slot] = state;
         }
         state[parsed.kind] = data;
         state.callbacks.push(callback);
         if(state.profile != null && state.data != null)
         {
            state.timer.stop();
            delete pendingPairs[slot];
            enqueue(slot, {
               "kind":"write",
               "profile":state.profile,
               "data":state.data,
               "callbacks":state.callbacks.concat()
            });
         }
      }

      /** 注意真实 AGI 的参数顺序是 callback 在前、key 在后。 */
      public function retrieveUserData(callback:Function, key:String = null) : void
      {
         if(!loggedIn)
         {
            callOnce(callback,{"success":false,"data":null,"error":"not_logged_in"});
            return;
         }
         if(key != null && !parseKey(key))
         {
            callOnce(callback,{"success":false,"data":null,"error":"invalid_key"});
            return;
         }
         var body:Object = {"sessionToken":sessionToken};
         if(key != null) body.key = key;
         post("/read",body,function(result:Object):void {
            callOnce(callback,result);
         });
      }

      /** 游戏会为 profile/data 连调两次；按槽合并，并和写任务走同一条 FIFO。 */
      public function deleteUserData(key:String) : void
      {
         if(!loggedIn) return;
         var parsed:Object = parseKey(key);
         if(!parsed) return;
         var slot:int = int(parsed.slot);
         var now:int = getTimer();
         if(lastDelete[slot] !== undefined && now - int(lastDelete[slot]) < 2000) return;
         lastDelete[slot] = now;
         if(pendingPairs[slot]) failPair(slot,pendingPairs[slot],"deleted");
         enqueue(slot,{"kind":"delete"});
      }

      public function initAGUI(options:Object = null) : void
      {
         scoreboardClose = options && options.onClose is Function ? options.onClose as Function : null;
      }

      public function showScoreboardSubmit(score:Number, user:String, board:String, columns:Array) : void
      {
         // 原游戏提交前会隐藏按钮；不调 onClose，它会在本局永久消失。
         if(scoreboardClose != null) callOnce(scoreboardClose,null,false);
      }

      public function showScoreboardList(columns:Array, board:String) : void
      {
         // 第一版没有排行榜；保留方法让旧游戏继续运行。
      }

      private function readParameters() : void
      {
         var params:Object = {};
         try
         {
            // 兼容 SWF 是子 Loader；FlashVars 在最外层游戏的 LoaderInfo 上。
            if(stage && stage.root && stage.root.loaderInfo) params = stage.root.loaderInfo.parameters;
            else if(loaderInfo) params = loaderInfo.parameters;
         }
         catch(error:Error)
         {
            params = {};
         }
         endpoint = stringValue(params.eightbitgo_save_endpoint);
         sessionToken = stringValue(params.eightbitgo_save_token);
         username = stringValue(params.eightbitgo_username);
         avatarUrl = stringValue(params.eightbitgo_avatar_url);
      }

      private function stringValue(value:*) : String
      {
         return value == null ? "" : String(value);
      }

      private function parseKey(key:String) : Object
      {
         var match:Array = /^(profile|data)online([0-2])$/.exec(String(key));
         return match ? {"kind":match[1],"slot":int(match[2])} : null;
      }

      private function newPair(slot:int) : Object
      {
         var state:Object = {"profile":null,"data":null,"callbacks":[]};
         var timer:Timer = new Timer(1500,1);
         state.timer = timer;
         timer.addEventListener(TimerEvent.TIMER_COMPLETE,function(event:TimerEvent):void {
            if(pendingPairs[slot] === state) failPair(slot,state,"pair_incomplete");
         });
         timer.start();
         return state;
      }

      private function failPair(slot:int, state:Object, reason:String) : void
      {
         if(state && state.timer) state.timer.stop();
         if(pendingPairs[slot] === state) delete pendingPairs[slot];
         var callbacks:Array = state && state.callbacks ? state.callbacks as Array : [];
         for each(var callback:Function in callbacks)
         {
            callOnce(callback,{"success":false,"error":reason});
         }
      }

      private function enqueue(slot:int, task:Object) : void
      {
         if(!queues[slot]) queues[slot] = [];
         (queues[slot] as Array).push(task);
         pump(slot);
      }

      private function pump(slot:int) : void
      {
         if(busy[slot]) return;
         var queue:Array = queues[slot] as Array;
         if(!queue || queue.length == 0) return;
         busy[slot] = true;
         var task:Object = queue.shift();
         if(task.kind == "write")
         {
            post("/write-slot",{
               "sessionToken":sessionToken,
               "slot":slot,
               "profile":task.profile,
               "data":task.data
            },function(result:Object):void {
               for each(var callback:Function in task.callbacks)
               {
                  callOnce(callback,result && result.success ? {"success":true} : {
                     "success":false,
                     "error":errorCode(result)
                  });
               }
               finishTask(slot);
            });
         }
         else
         {
            post("/delete-slot",{"sessionToken":sessionToken,"slot":slot},function(result:Object):void {
               finishTask(slot);
            });
         }
      }

      private function finishTask(slot:int) : void
      {
         busy[slot] = false;
         pump(slot);
      }

      private function errorCode(result:Object) : String
      {
         try
         {
            if(result && result.error && result.error.code) return String(result.error.code);
         }
         catch(error:Error)
         {
         }
         return "network_error";
      }

      private function post(path:String, body:Object, callback:Function) : void
      {
         var loader:URLLoader = new URLLoader();
         var timer:Timer = new Timer(12000,1);
         var finished:Boolean = false;
         var done:Function = function(result:Object):void {
            if(finished) return;
            finished = true;
            timer.stop();
            loader.removeEventListener(Event.COMPLETE,onComplete);
            loader.removeEventListener(IOErrorEvent.IO_ERROR,onFailure);
            loader.removeEventListener(SecurityErrorEvent.SECURITY_ERROR,onFailure);
            callOnce(callback,result);
         };
         var onComplete:Function = function(event:Event):void {
            try
            {
               var result:Object = JSON.parse(String(loader.data));
               if(!result || result.success === undefined) throw new Error("bad_response");
               done(result);
            }
            catch(error:Error)
            {
               done({"success":false,"error":{"code":"bad_response"}});
            }
         };
         var onFailure:Function = function(event:Event):void {
            done({"success":false,"error":{"code":"network_error"}});
         };
         timer.addEventListener(TimerEvent.TIMER_COMPLETE,function(event:TimerEvent):void {
            try { loader.close(); } catch(error:Error) {}
            done({"success":false,"error":{"code":"timeout"}});
         });
         loader.addEventListener(Event.COMPLETE,onComplete);
         loader.addEventListener(IOErrorEvent.IO_ERROR,onFailure);
         loader.addEventListener(SecurityErrorEvent.SECURITY_ERROR,onFailure);
         try
         {
            var request:URLRequest = new URLRequest(endpoint + path);
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

      private function callOnce(callback:Function, value:Object, passArgument:Boolean = true) : void
      {
         if(callback == null) return;
         try
         {
            if(passArgument) callback(value);
            else callback();
         }
         catch(error:Error)
         {
            // 旧游戏的回调异常不能卡住下一条存档任务。
         }
      }
   }
}

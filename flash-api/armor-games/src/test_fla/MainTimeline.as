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
      /** 这个槽已经排着一个删除任务，用来合并游戏连发的那两次 deleteUserData */
      private var deleteQueued:Object = {};
      /**
       * 正在飞的写入请求数。读之前要等它归零 —— 玩家刚过关触发了一次保存、紧接着打开存档页时，
       * 不等就会读到写之前那一份，看起来像「刚存的档没生效」。见 waitForWrites。
       */
      private var writesInFlight:int = 0;
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
         if(!gameAccepted)
         {
            /*
               校验失败时整条在线存档链是**静默关闭**的（游戏只会看到 isLoggedIn() 为 false），
               这里留一条能在控制台查到的线索，免得「为什么在线槽不亮」只能靠读源码回答。
            */
            trace("[8bitgo-flash-save] gameKey 不匹配（收到 " + gameKey + "），在线存档已关闭");
         }
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
         // 先等在飞的写落库，避免读到写之前那一份（见 waitForWrites）
         waitForWrites(function():void {
            var body:Object = {"sessionToken":sessionToken};
            if(key != null) body.key = key;
            post("/read",body,function(result:Object):void {
               callOnce(callback,result);
            });
         });
      }

      /**
       * 游戏会为 profile/data 连调两次；按「这个槽已经排了删除」合并，并和写任务走同一条 FIFO。
       *
       * ⚠️ 不能用时间窗去重（以前是 2 秒）。时间窗会把「删档 → 重新存 → 再删」里的第二次删除
       * 一起吞掉：玩家删完看到槽空了、其实档还在，下次进游戏它又冒出来。
       * 写入入队时会清掉标记（见 enqueue），所以上面那种序列能正常删掉。
       */
      public function deleteUserData(key:String) : void
      {
         if(!loggedIn) return;
         var parsed:Object = parseKey(key);
         if(!parsed) return;
         var slot:int = int(parsed.slot);
         if(deleteQueued[slot] === true) return;
         deleteQueued[slot] = true;
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
         // 排进一个新的写入 = 这个槽又有内容了，之前那次删除的「已排队」标记必须清掉，
         // 否则玩家「删档 → 重新存 → 再删」时第二次删除会被当成重复请求吞掉
         if(task.kind == "write") deleteQueued[slot] = false;
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
            submitWrite(slot,task,0);
         }
         else
         {
            post("/delete-slot",{"sessionToken":sessionToken,"slot":slot},function(result:Object):void {
               // 删除任务结束（成功或失败）就清标记，之后单独的一次删除还能正常发出去
               deleteQueued[slot] = false;
               finishTask(slot);
            });
         }
      }

      /**
       * 轮询等在飞的写入归零再放行。
       * 最多等 3 秒：宁可给一份可能略旧的档，也不能把游戏卡在读档界面 ——
       * 那个界面上的「等待」和「坏了」长得一模一样。
       */
      private function waitForWrites(proceed:Function, waited:int = 0) : void
      {
         if(writesInFlight <= 0 || waited >= 3000)
         {
            proceed();
            return;
         }
         var timer:Timer = new Timer(60,1);
         timer.addEventListener(TimerEvent.TIMER_COMPLETE,function(event:TimerEvent):void {
            waitForWrites(proceed,waited + 60);
         });
         timer.start();
      }

      /**
       * 写一槽，失败先重试一次再报给游戏。
       *
       * 为什么值得重试：游戏**忽略** submitUserData 回调里的错误，所以一次网络抖动就等于
       * 这一关的进度白打，而且玩家和我们都看不见。服务端写入是 upsert，重试天然幂等；
       * 重试期间这个槽的 busy 没清，不会和下一次保存交叉。
       * 会话已经失效时不再重试 —— 重试多少次都是同样的 401。
       */
      private function submitWrite(slot:int, task:Object, attempt:int) : void
      {
         if(attempt == 0) writesInFlight++;
         post("/write-slot",{
            "sessionToken":sessionToken,
            "slot":slot,
            "profile":task.profile,
            "data":task.data
         },function(result:Object):void {
            var ok:Boolean = result != null && result.success === true;
            if(!ok && loggedIn && attempt < 1 && retriable(result))
            {
               var timer:Timer = new Timer(800,1);
               timer.addEventListener(TimerEvent.TIMER_COMPLETE,function(event:TimerEvent):void {
                  submitWrite(slot,task,attempt + 1);
               });
               timer.start();
               // 计数先不还：这次逻辑写入还在飞，读要继续等它（见 waitForWrites）
               return;
            }
            // 走到这里这次写入就结束了（成功或彻底失败）。计数只在第一次尝试时加过，这里还一次
            if(writesInFlight > 0) writesInFlight--;
            for each(var callback:Function in task.callbacks)
            {
               callOnce(callback, ok ? {"success":true} : {
                  "success":false,
                  "error":errorCode(result)
               });
            }
            finishTask(slot);
         });
      }

      /** 只有「这次没送到」值得重试；会话失效 / 参数错 / 超限，重试多少次都一样。 */
      private function retriable(result:Object) : Boolean
      {
         var code:String = errorCode(result);
         return code == "network_error" || code == "timeout" || code == "bad_response" || code == "request_failed";
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
         /**
          * 把响应体解析成服务端对象；不是我们那套形状就返回 null。
          *
          * ⚠️ 必须能在**失败**回调里也调用。HTTP 4xx/5xx 在不少播放器（含 Ruffle）里走的是
          * ioErrorEvent，但响应体仍然躺在 loader.data 上 —— 不看它就会把 invalid_session
          * 一律报成 network_error，于是「会话过期」和「网络断了」在游戏侧长得一模一样，
          * 而前者是玩家唯一需要知道的（去重开一局 / 刷新页面）。
          */
         var parseBody:Function = function(raw:*) : Object {
            try
            {
               if(raw == null) return null;
               var text:String = String(raw);
               if(text.length == 0) return null;
               var parsed:Object = JSON.parse(text);
               return (parsed != null && parsed.success !== undefined) ? parsed : null;
            }
            catch(error:Error)
            {
               return null;
            }
         };
         var done:Function = function(result:Object):void {
            if(finished) return;
            finished = true;
            timer.stop();
            loader.removeEventListener(Event.COMPLETE,onComplete);
            loader.removeEventListener(IOErrorEvent.IO_ERROR,onFailure);
            loader.removeEventListener(SecurityErrorEvent.SECURITY_ERROR,onFailure);
            /*
              会话过期就把登录态摘掉，游戏会据此把在线槽重新标成不可用。
              不摘的话它一直显示「可以存」，玩家以为进度在云上，其实每一条都被服务端拒掉 ——
              这是这个桥在「游戏忽略回调里的 error」这一前提下唯一能给出的可见反馈。
            */
            if(result != null && result.success === false && errorCode(result) == "invalid_session")
            {
               loggedIn = false;
            }
            callOnce(callback,result);
         };
         var onComplete:Function = function(event:Event):void {
            var parsed:Object = parseBody(loader.data);
            done(parsed != null ? parsed : {"success":false,"error":{"code":"bad_response"}});
         };
         var onFailure:Function = function(event:Event):void {
            // 先从错误响应里挖出真正的原因（401 会带着 invalid_session），挖不到才当网络故障
            var recovered:Object = parseBody(loader.data);
            done(recovered != null ? recovered : {"success":false,"error":{"code":"network_error"}});
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

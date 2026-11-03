package test_fla
{
   import flash.display.MovieClip;
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
      private var saveMode:String = "";
      private var loginCallback:String = "";
      private var expectedGameKey:String = "infect-2";
      private var loggedIn:Boolean = false;
      private var gameAccepted:Boolean = false;
      /** 一局只弹一次：游戏可能会紧接着调 submit / delete，不能连弹两层登录框。 */
      private var loginPromptSent:Boolean = false;
      private var pendingPairs:Object = {};
      private var queues:Object = {};
      private var busy:Object = {};
      /** 所有已接收但尚未完成的写/删任务；读档屏障不能只看正在发出的 HTTP 请求。 */
      private var pendingMutations:int = 0;
      private var drainWaiters:Array = [];
      private static const MAX_PENDING_MUTATIONS:int = 12;
      /** 这个槽已经排着一个删除任务，用来合并游戏连发的那两次 deleteUserData */
      private var deleteQueued:Object = {};
      private var scoreboardClose:Function = null;
      /**
       * 每个槽「服务端当前的写入版本号」，读档时和每次写成功后同步。
       *
       * 它是**条件更新**的凭据（R01）：写入时带上它，服务端只在这个值等于当前版本时才落库。
       * 于是被网络拖到很后面的旧请求不会覆盖一份更新的档 —— 版本对不上，服务端直接 409。
       * 拿不到版本（老服务端没有 revisions 字段）时不带这个参数，退化成原来的「谁来谁覆盖」。
       */
      private var revisions:Object = {};
      /** 页面会话的操作 ID 前缀 + 计数器，给每次保存生成唯一 ID；重试复用同一个（见 submitWrite） */
      private var sessionId:String = "";
      private var opCounter:int = 0;
      /**
       * 这个槽正处于「两半对不上」的重同步状态：丢掉下一个到达的 data 半。
       * 见 submitUserData 里重复半段的处理。
       */
      private var resync:Object = {};

      public function MainTimeline()
      {
         super();
      }

      /** devKey 只为兼容旧签名；身份只认父页面下发的短期会话令牌。 */
      public function init(devKey:String, gameKey:String) : void
      {
         readParameters();
         sessionId = newSessionId();
         // 新游戏的 gameKey 由共用接入表下发；老页面没传时保留 infect-2 作兼容回退。
         gameAccepted = expectedGameKey.length > 0 && gameKey == expectedGameKey;
         if(!gameAccepted)
         {
            /*
               校验失败时整条在线存档链是**静默关闭**的（游戏只会看到 isLoggedIn() 为 false），
               这里留一条能在控制台查到的线索，免得「为什么在线槽不亮」只能靠读源码回答。
            */
            trace("[8bitgo-flash-save] gameKey 不匹配（期望 " + expectedGameKey + "，收到 " + gameKey + "），在线存档已关闭");
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
         if(!loggedIn) notifyLoginRequired();
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
            notifyLoginRequired();
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
            /*
               同一半重复到达 —— 这一次保存的两半已经没法确定谁配谁了。
               所以除了丢掉旧的那一半，还要把**下一个到达的 data 半也丢掉**（resync）：
               「旧 profile + 新 data」拼出来的档表面正常、实际错位，比丢一次保存严重得多
               （游戏每次送的都是全量状态，下一次保存就补回来了）。
               ⚠️ 这是客户端侧的补救：从根上解决需要游戏给每次保存一个 ID，那不在我们手里。
            */
            failPair(slot,state,"duplicate_part");
            state = newPair(slot);
            pendingPairs[slot] = state;
            resync[slot] = true;
         }
         if(parsed.kind == "data" && resync[slot] == true)
         {
            resync[slot] = false;
            failPair(slot,state,"ambiguous_pair");
            callOnce(callback,{"success":false,"error":"ambiguous_pair"});
            return;
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
               // 两半共用同一个操作 ID —— 这就是「共同批次号」；重试复用它，服务端据此去重
               "opId":nextOpId(),
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
         // 先等完整队列和未配对的 profile/data 都结束；超时就明确失败，绝不把旧档伪装成成功。
         waitForWrites(function():void {
            var body:Object = {"sessionToken":sessionToken};
            if(key != null) body.key = key;
            post("/read",body,function(result:Object):void {
               // 先把槽版本对齐，再交给游戏 —— 后续写入要用它做条件更新
               mergeRevisions(result);
               callOnce(callback,result);
            });
         },function():void {
            callOnce(callback,{"success":false,"data":null,"error":"timeout"});
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
         if(!loggedIn)
         {
            notifyLoginRequired();
            return;
         }
         var parsed:Object = parseKey(key);
         if(!parsed) return;
         var slot:int = int(parsed.slot);
         if(deleteQueued[slot] === true) return;
         deleteQueued[slot] = true;
         if(!enqueue(slot,{"kind":"delete"})) return;
         // 先把删除计入屏障，再通知未配对保存失败；回调若立即读档，也必须排在删除之后。
         if(pendingPairs[slot]) failPair(slot,pendingPairs[slot],"deleted");
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
         saveMode = stringValue(params.eightbitgo_save_mode);
         loginCallback = stringValue(params.eightbitgo_login_callback);
         var configuredGameKey:String = stringValue(params.eightbitgo_agi_game_key);
         if(configuredGameKey.length > 0) expectedGameKey = configuredGameKey;
      }

      /**
       * 只在「确实是游客 + gameKey 对得上 + 玩家主动用在线槽」时告诉页面。
       * unavailable 是已登录但会话服务出错，不能误弹登录；gameKey 错了则说明本来就不该由这个桥接管。
       */
      private function notifyLoginRequired() : void
      {
         if(loginPromptSent || saveMode != "guest" || !gameAccepted || loginCallback.length == 0) return;
         if(!/^[A-Za-z_$][A-Za-z0-9_$.]{0,127}$/.test(loginCallback)) return;
         try
         {
            if(ExternalInterface.available)
            {
               ExternalInterface.call(loginCallback,"login_required");
               loginPromptSent = true;
            }
         }
         catch(error:Error)
         {
            // 登录提示失败不能影响游戏原有的本地存档。
         }
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

      /** 会话前缀：同一页面会话里唯一就够 —— 跨会话的先后顺序由服务端的版本号解决，不靠这个 */
      private function newSessionId() : String
      {
         var now:String = new Date().getTime().toString(16);
         var noise:String = Math.floor(Math.random() * 0x1000000).toString(16);
         return "s" + now + noise;
      }

      /** 服务端只接受 ^[A-Za-z0-9_-]{8,64}$，这里拼出来的长度在十几位 */
      private function nextOpId() : String
      {
         opCounter++;
         return sessionId + "-" + opCounter;
      }

      /**
       * 记下服务端下发的槽版本（读档响应顶层的 revisions）。
       *
       * 读档是客户端唯一能「对齐版本」的时机：页面刷新后本地版本是空的，
       * 不读一次就写入等于没有并发保护（见 revisions 的注释）。
       */
      private function mergeRevisions(result:Object) : void
      {
         try
         {
            if(result == null || result.revisions == null) return;
            for(var key:String in result.revisions)
            {
               var value:Number = Number(result.revisions[key]);
               if(!isNaN(value)) revisions[key] = value;
            }
         }
         catch(error:Error)
         {
            // 版本号只影响并发保护，读坏了也不能影响这次读档的结果
         }
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
         notifyDrainWaiters();
      }

      private function enqueue(slot:int, task:Object) : Boolean
      {
         if(!queues[slot]) queues[slot] = [];
         var queue:Array = queues[slot] as Array;
         var i:int = 0;
         var pending:Object = null;
         var callbacks:Array = null;
         if(task.kind == "write")
         {
            // 同槽待发送写入是完整快照；合并为最新状态，避免游戏高频自动保存堆出大块 JSON。
            // 删除是顺序边界，不能把删除前的保存合并到删除之后。
            for(i = queue.length - 1; i >= 0; i--)
            {
               pending = queue[i];
               if(pending.kind == "delete") break;
               if(pending.kind == "write")
               {
                  pending.profile = task.profile;
                  pending.data = task.data;
                  pending.opId = task.opId;
                  pending.callbacks = pending.callbacks.concat(task.callbacks);
                  // 有效的新快照打断「删除去重」区间，后续再次删除仍须真的发请求。
                  deleteQueued[slot] = false;
                  return true;
               }
            }
         }
         if(pendingMutations >= MAX_PENDING_MUTATIONS)
         {
            callbacks = task.callbacks as Array;
            if(callbacks)
            {
               for each(var rejected:Function in callbacks)
               {
                  callOnce(rejected,{"success":false,"error":"queue_full"});
               }
            }
            if(task.kind == "delete") deleteQueued[slot] = false;
            trace("[8bitgo-flash-save] 在线存档待发送任务已满，拒绝新增槽 " + slot + " 的任务");
            return false;
         }
         // 只有任务确实进入队列后才推进删除去重状态；被保护拒绝的写入不能抹掉删除标记。
         if(task.kind == "write") deleteQueued[slot] = false;
         queue.push(task);
         pendingMutations++;
         pump(slot);
         return true;
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
               /*
                 删除也会推进服务端的版本号。把它记下来，否则删档之后的第一次正常保存
                 会带着删除前的版本撞条件更新，白丢一次（游戏忽略错误，玩家只看到「刚才那关没存上」）。
                 删除失败时本地版本同样不可信，直接丢掉 —— 下一次保存退回无保护写入。
               */
               if(result != null && result.success === true && result.data != null && result.data.revision != null)
               {
                  revisions[slot] = Number(result.data.revision);
               }
               else
               {
                  delete revisions[slot];
               }
               // 删除任务结束（成功或失败）就清标记，之后单独的一次删除还能正常发出去
               deleteQueued[slot] = false;
               finishTask(slot);
            });
         }
      }

      /** 读档必须经过写入/删除屏障；30 秒仍未排空就失败关闭，不返回可能过期的快照。 */
      private function waitForWrites(proceed:Function, fail:Function) : void
      {
         if(mutationsDrained())
         {
            proceed();
            return;
         }
         var waiter:Object = {"proceed":proceed,"fail":fail};
         var timer:Timer = new Timer(30000,1);
         waiter.timer = timer;
         waiter.onTimeout = function(event:TimerEvent):void {
            removeDrainWaiter(waiter);
            callOnce(fail,{"success":false,"data":null,"error":"timeout"});
         };
         timer.addEventListener(TimerEvent.TIMER_COMPLETE,waiter.onTimeout);
         drainWaiters.push(waiter);
         if(mutationsDrained())
         {
            removeDrainWaiter(waiter);
            callOnce(proceed,null,false);
         }
         else
         {
            timer.start();
         }
      }

      private function mutationsDrained() : Boolean
      {
         if(pendingMutations > 0) return false;
         for(var slot:String in pendingPairs)
         {
            if(pendingPairs[slot] != null) return false;
         }
         return true;
      }

      private function removeDrainWaiter(waiter:Object) : void
      {
         if(waiter == null) return;
         if(waiter.timer != null)
         {
            waiter.timer.stop();
            waiter.timer.removeEventListener(TimerEvent.TIMER_COMPLETE,waiter.onTimeout);
         }
         var index:int = drainWaiters.indexOf(waiter);
         if(index >= 0) drainWaiters.splice(index,1);
      }

      private function notifyDrainWaiters() : void
      {
         if(!mutationsDrained() || drainWaiters.length == 0) return;
         var waiters:Array = drainWaiters.concat();
         drainWaiters = [];
         for each(var waiter:Object in waiters)
         {
            removeDrainWaiter(waiter);
            callOnce(waiter.proceed,null,false);
         }
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
         var body:Object = {
            "sessionToken":sessionToken,
            "slot":slot,
            "profile":task.profile,
            "data":task.data
         };
         /*
            幂等重放：重试复用同一个操作 ID，服务端认出「这份档已经写过了」就回当前版本、
            不再写一遍。没有它的话，一次超时重试就会变成两次写入（写和读之间还可能被别的东西插进来）。
         */
         if(task.opId != null) body.opId = task.opId;
         /*
            条件更新：服务端当前版本就是我们知道的这个才允许落库。
            不知道（这次会话还没读过档、或者服务端没下发 revisions）就不带 —— 退化成原来的
            「谁来谁覆盖」。这条降级路径是给旧库 / 旧响应的，正常路径一定会带上。
         */
         if(revisions[slot] != null) body.expectedRevision = revisions[slot];
         post("/write-slot",body,function(result:Object):void {
            var ok:Boolean = result != null && result.success === true;
            if(ok && result.data != null && result.data.revision != null)
            {
               revisions[slot] = Number(result.data.revision);
            }
            else if(result != null && errorCode(result) == "stale_write")
            {
               /*
                  版本对不上：这个槽已经被推到更新的版本（另一次保存、或另一台设备），
                  而这次写入基于一份旧状态 —— 被拒掉是对的。
                  新服务端把当前代次一起返回，直接对齐后续条件更新。只有旧服务端没有这个字段时
                  才删除本地值；不能一律删掉，否则下一次保存会退化成无条件覆盖，等于把保护拆了。
               */
               if(result.error != null && result.error.currentRevision != null &&
                  !isNaN(Number(result.error.currentRevision)))
               {
                  revisions[slot] = Number(result.error.currentRevision);
               }
               else
               {
                  delete revisions[slot];
               }
               trace("[8bitgo-flash-save] 槽 " + slot + " 的保存基于旧版本，已丢弃");
            }
            if(!ok && loggedIn && attempt < 1 && retriable(result))
            {
               var timer:Timer = new Timer(800,1);
               timer.addEventListener(TimerEvent.TIMER_COMPLETE,function(event:TimerEvent):void {
                  submitWrite(slot,task,attempt + 1);
               });
               timer.start();
               return;
            }
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
         if(pendingMutations > 0) pendingMutations--;
         busy[slot] = false;
         pump(slot);
         notifyDrainWaiters();
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

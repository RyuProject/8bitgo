package com.spilgames.bs
{
   import com.spilgames.api.SpilGamesServices;
   import flash.display.MovieClip;
   import flash.events.Event;
   import flash.events.EventDispatcher;
   import flash.utils.getDefinitionByName;
   
   public class BrandingManager extends EventDispatcher
   {
      
      private static var _instance:BrandingManager;
      
      public static const BRANDING_READY:String = "brandingReady";
      
      public static const DEFAULT_MORE_GAMES_LINK:String = "http://www.agame.com";
      
      private var _brandingSystem:*;
      
      private var _componentsReady:Boolean = false;

      private var _offlineLocalization:*;

      private var _offlineLanguage:String = "en-US";
      
      public function BrandingManager(param1:Private = null)
      {
         super();
         this.initConstructor(param1);
      }
      
      public static function getInstance() : BrandingManager
      {
         if(!_instance)
         {
            _instance = new BrandingManager(new Private());
         }
         return _instance;
      }
      
      public function createComponent(param1:String) : MovieClip
      {
         var _loc2_:MovieClip = null;
         if(Boolean(param1) && param1 != "")
         {
            if(this._componentsReady)
            {
               try
               {
                  _loc2_ = this._brandingSystem.createComponent(param1);
               }
               catch(e:Error)
               {
               }
            }
            else if(this._offlineLocalization)
            {
               // 离线版没有发行商按钮；返回空容器，避免旧组件对 null 调 addChild。
               _loc2_ = new MovieClip();
            }
         }
         return _loc2_;
      }
      
      public function isAvailable() : Boolean
      {
         return this.isReady();
      }
      
      public function isReady() : Boolean
      {
         return this._componentsReady || Boolean(this._offlineLocalization);
      }
      
      public function getAddToSiteLink() : String
      {
         if(this._componentsReady && Boolean(this._brandingSystem))
         {
            return this._brandingSystem.getAddToSiteLink();
         }
         return DEFAULT_MORE_GAMES_LINK;
      }
      
      public function getMoreGamesLink() : String
      {
         var _loc1_:String = DEFAULT_MORE_GAMES_LINK;
         if(this.isReady() && Boolean(this._brandingSystem))
         {
            _loc1_ = this._brandingSystem.getMoreGamesLink();
         }
         return _loc1_;
      }
      
      public function getTrackedLink(param1:String, param2:String) : String
      {
         var _loc3_:String = null;
         if(this.isReady() && Boolean(this._brandingSystem))
         {
            _loc3_ = this._brandingSystem.getTrackedLink(param1,param2);
         }
         return _loc3_;
      }
      
      public function getLocalizedString(param1:String, param2:String = "SpilGames_Game") : String
      {
         var _loc3_:Object = this.getLocalizedObject(param1,param2);
         return _loc3_.value;
      }
      
      public function getLocalizedObject(param1:String, param2:String = "SpilGames_Game") : Object
      {
         var _loc3_:XML = null;
         var _loc4_:XMLList = null;
         var _loc5_:XMLList = null;
         if(this._componentsReady && Boolean(this._brandingSystem))
         {
            return this._brandingSystem.getString(param1,param2);
         }
         if(this._offlineLocalization)
         {
            _loc4_ = this._offlineLocalization.item.(@id == param1);
            if(_loc4_.length() > 0)
            {
               _loc3_ = _loc4_[0];
               _loc5_ = _loc3_.child(this._offlineLanguage);
               if(_loc5_.length() == 0 || String(_loc5_[0]).length == 0)
               {
                  _loc5_ = _loc3_.child("en-US");
               }
               if(_loc5_.length() > 0)
               {
                  return {"value":String(_loc5_[0]),"fontName":String(_loc5_[0].@fontName)};
               }
            }
         }
         // 缺失键显示键名比抛 #1010 并让教程每帧中断更容易诊断，也不会拖垮 Ruffle。
         return {"value":param1,"fontName":"arial bold"};
      }
      
      public function showBrandingBar() : Boolean
      {
         return this._componentsReady && Boolean(this._brandingSystem) ? this._brandingSystem.showBrandingBar() : false;
      }
      
      public function hideBrandingBar() : Boolean
      {
         return this._componentsReady && Boolean(this._brandingSystem) ? this._brandingSystem.hideBrandingBar() : false;
      }
      
      public function getCurrentLanguage() : String
      {
         if(this._componentsReady && Boolean(this._brandingSystem))
         {
            return this._brandingSystem.getCurrentLanguage();
         }
         return this._offlineLanguage;
      }
      
      public function setLanguage(param1:String) : void
      {
         if(this._componentsReady && Boolean(this._brandingSystem))
         {
            this._brandingSystem.setLanguage(param1);
         }
         else if(Boolean(param1) && param1.length > 0)
         {
            this._offlineLanguage = param1;
            dispatchEvent(new Event(SpilGamesServices.LOCALE_CHANGED));
         }
      }
      
      public function getPortalGroup() : uint
      {
         var _loc1_:uint = 1;
         if(this.isReady() && Boolean(this._brandingSystem))
         {
            _loc1_ = uint(this._brandingSystem.portalGroup);
         }
         return _loc1_;
      }
      
      private function initConstructor(param1:Private) : void
      {
         if(!param1)
         {
            throw new Error("Cannot instantiate this class directly. Use BrandingManager.getInstance() instead.");
         }
         try
         {
            // LocalizationPack 在默认包里，带包名的类不能直接 import，只能从当前应用域取。
            var _loc2_:Class = getDefinitionByName("LocalizationPack") as Class;
            this._offlineLocalization = new _loc2_().translation;
         }
         catch(e:Error)
         {
            this._offlineLocalization = null;
         }
         SpilGamesServices.getInstance().addEventListener(SpilGamesServices.COMPONENTS_READY,this.onComponentsReady);
      }
      
      private function onComponentsReady(param1:Event) : void
      {
         this._brandingSystem = SpilGamesServices.getInstance().connection.getComponentSystem(BrandingComponentTypes.BRAND_SYSTEM);
         this._brandingSystem.flashVars = SpilGamesServices.getInstance().flashVars;
         if(!this._brandingSystem)
         {
            return;
         }
         this._brandingSystem.addEventListener(BRANDING_READY,this.brandingReady);
         if(SpilGamesServices.getInstance().flashVars.siteID > 0)
         {
            this._brandingSystem.useGoogleAnalytics = false;
         }
         SpilGamesServices.getInstance().connection.addEventListener(SpilGamesServices.LOCALE_CHANGED,this.onLocaleChanged);
         this._componentsReady = true;
         dispatchEvent(new Event(SpilGamesServices.COMPONENTS_READY,true));
      }
      
      private function brandingReady(param1:Event) : void
      {
         dispatchEvent(new Event(BRANDING_READY));
      }
      
      private function onLocaleChanged(param1:Event) : void
      {
         if(hasEventListener(SpilGamesServices.LOCALE_CHANGED))
         {
            dispatchEvent(new Event(SpilGamesServices.LOCALE_CHANGED));
         }
      }
   }
}

class Private
{
   
   public function Private()
   {
      super();
   }
}

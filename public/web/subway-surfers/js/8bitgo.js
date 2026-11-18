/*
 * 只在 8BitGo 嵌入时为 WebGL 保留可读帧，并把游戏采集和生命周期交给 8BitGo SDK。
 * 媒体桥在 index.html 中先于本脚本加载，确保游戏创建 AudioContext 前已接好录音音轨。
 */
(function ()
{
    'use strict';

    var sdkUrl = '/html5-api/8bitgo-game-sdk.min.js';
    var gameReady = false;
    var reportedPlayable = false;
    var gameCanvas = null;

    function is8BitGoParent()
    {
        try
        {
            var parent = new URL(document.referrer);
            var allowedHosts = ['8bitgo.com', 'www.8bitgo.com', 'cn.8bitgo.com', 'tv.8bitgo.com'];
            return parent.protocol === 'https:' && allowedHosts.indexOf(parent.hostname.toLowerCase()) >= 0;
        }
        catch (error)
        {
            return false;
        }
    }

    var embeddedIn8BitGo = is8BitGoParent();

    function getCanvasArea(canvas)
    {
        return (Number(canvas && canvas.width) || 0) * (Number(canvas && canvas.height) || 0);
    }

    function isConnected(canvas)
    {
        if (!canvas) return false;
        if (typeof canvas.isConnected === 'boolean') return canvas.isConnected;
        return !!(document.documentElement && document.documentElement.contains(canvas));
    }

    function selectGameCanvas(canvas)
    {
        if (!canvas) return;
        if (!gameCanvas || (isConnected(canvas) && !isConnected(gameCanvas)) ||
            (isConnected(canvas) === isConnected(gameCanvas) && getCanvasArea(canvas) >= getCanvasArea(gameCanvas)))
        {
            gameCanvas = canvas;
        }
    }

    function reportPlayableWhenReady()
    {
        if (reportedPlayable) return;

        var sdk = window.EightBitGoGameSDK;
        var sdkState = sdk && typeof sdk.getState === 'function' ? sdk.getState() : null;
        if (!gameReady || !sdk || !sdkState || sdkState.ready !== true) return;

        reportedPlayable = true;
        sdk.reportFirstFrame();
        sdk.reportPlayable();
    }

    function registerGameCanvas()
    {
        var sdk = window.EightBitGoGameSDK;
        if (!sdk || !gameCanvas || typeof sdk.registerCanvas !== 'function') return;

        sdk.registerCanvas(gameCanvas);
        reportPlayableWhenReady();
    }

    function installWebGLCaptureSupport()
    {
        if (!embeddedIn8BitGo) return;

        var prototype = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
        if (!prototype || typeof prototype.getContext !== 'function' || prototype.getContext.__8bitGoWrapped) return;

        var originalGetContext = prototype.getContext;
        var wrappedGetContext = function ()
        {
            var args = Array.prototype.slice.call(arguments);
            var type = typeof args[0] === 'string' ? args[0].toLowerCase() : '';
            var isWebGL = type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl';

            if (isWebGL)
            {
                var attributes = args[1];
                var captureAttributes = attributes && typeof attributes === 'object'
                    ? Object.assign({}, attributes)
                    : {};
                captureAttributes.preserveDrawingBuffer = true;
                args[1] = captureAttributes;
            }

            var context = originalGetContext.apply(this, args);
            if (context && isWebGL)
            {
                selectGameCanvas(this);
                registerGameCanvas();
            }
            return context;
        };
        wrappedGetContext.__8bitGoWrapped = true;
        prototype.getContext = wrappedGetContext;
    }

    function connectSdk()
    {
        var sdk = window.EightBitGoGameSDK;
        if (!sdk) return;

        if (gameCanvas && typeof sdk.registerCanvas === 'function') sdk.registerCanvas(gameCanvas);
        if (typeof sdk.on === 'function') sdk.on('ready', reportPlayableWhenReady);
        reportPlayableWhenReady();
    }

    function installGameReadyHook()
    {
        var loadingBar = window.loadingBar;
        if (!loadingBar || typeof loadingBar.hide !== 'function' || loadingBar.hide.__8bitGoWrapped) return;

        var originalHide = loadingBar.hide;
        var wrappedHide = function ()
        {
            var result = originalHide.apply(this, arguments);
            gameReady = true;
            reportPlayableWhenReady();
            return result;
        };
        wrappedHide.__8bitGoWrapped = true;
        loadingBar.hide = wrappedHide;
    }

    installWebGLCaptureSupport();
    installGameReadyHook();

    var script = document.createElement('script');
    script.src = sdkUrl;
    script.async = true;
    script.onload = connectSdk;
    script.onerror = function ()
    {
        console.warn('[8BitGo SDK] SDK 加载失败，游戏继续运行');
    };
    document.head.appendChild(script);
}());

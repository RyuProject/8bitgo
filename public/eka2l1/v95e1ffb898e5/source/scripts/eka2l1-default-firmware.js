/*
 * 8BitGo 的设备默认 ROM 引导。
 *
 * 用户从 /symbian 点击启动后，说明页把管理员配置的 ROM URL 暂存到 sessionStorage。
 * 只在当前浏览器没有已安装设备时才自动下载并走 EKA2L1 原有的 ROM 安装流程；
 * 已有设备不被覆盖，固件内容仍只写入玩家自己的浏览器存储。
 */
(function () {
    'use strict';

    var URL_KEY = '8bitgo.eka2l1.defaultFirmwareUrl';
    var MAX_ROM_BYTES = 128 * 1024 * 1024;
    var url = '';

    try {
        url = sessionStorage.getItem(URL_KEY) || '';
        sessionStorage.removeItem(URL_KEY);
    } catch (e) {}
    if (!url) return;

    try {
        var target = new URL(url, location.href);
        if ((target.protocol !== 'https:' && target.origin !== location.origin)
            || target.username || target.password) {
            throw new Error('不安全的固件地址');
        }
        url = target.href;
    } catch (err) {
        showFailure(err);
        return;
    }

    // 设备列表缓存可覆盖旧版未写入标记的情况；不要因为配置了默认项覆盖玩家原有设备。
    try {
        var cachedApps = JSON.parse(localStorage.getItem('eka2l1_apps_cache') || '[]');
        if (localStorage.getItem('eka2l1_has_device') === '1'
            || (Array.isArray(cachedApps) && cachedApps.length > 0)) return;
    } catch (e) {}

    var input = document.getElementById('romInput');
    var status = document.getElementById('coreStatusText');
    if (!input || typeof window.installDevice !== 'function' || typeof DataTransfer !== 'function') {
        showFailure(new Error('当前模拟器页面不支持自动安装'));
        return;
    }

    setStatus('yellow', localized('正在下载诺基亚 N-Gage QD 固件…', 'Downloading Nokia N-Gage QD firmware…'));
    fetch(url, { credentials: 'omit', cache: 'default' })
        .then(function (response) {
            if (!response.ok) throw new Error('固件服务器返回 HTTP ' + response.status);
            var contentLength = Number(response.headers.get('content-length')) || 0;
            if (contentLength > MAX_ROM_BYTES) throw new Error('固件文件超过 128 MiB，已停止自动安装');
            if (!response.body || typeof response.body.getReader !== 'function') return response.blob();

            var reader = response.body.getReader();
            var chunks = [];
            var loaded = 0;
            function readNext() {
                return reader.read().then(function (part) {
                    if (part.done) return new Blob(chunks, { type: 'application/octet-stream' });
                    loaded += part.value.byteLength;
                    if (loaded > MAX_ROM_BYTES) {
                        reader.cancel();
                        throw new Error('固件文件超过 128 MiB，已停止自动安装');
                    }
                    chunks.push(part.value);
                    if (status) {
                        var mb = (loaded / 1048576).toFixed(1);
                        var pct = contentLength ? ' ' + Math.floor(loaded * 100 / contentLength) + '%' : '';
                        status.textContent = localized('正在下载 N-Gage QD 固件：' + mb + ' MB' + pct,
                            'Downloading N-Gage QD firmware: ' + mb + ' MB' + pct);
                    }
                    return readNext();
                });
            }
            return readNext();
        })
        .then(function (blob) {
            if (!blob || !blob.size) throw new Error('固件文件为空');
            if (blob.size > MAX_ROM_BYTES) throw new Error('固件文件超过 128 MiB，已停止自动安装');
            var file = new File([blob], 'N-Gage-QD.rom', { type: 'application/octet-stream' });
            var transfer = new DataTransfer();
            transfer.items.add(file);
            input.files = transfer.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            setStatus('yellow', localized('固件已下载，正在安装到此浏览器…', 'Firmware downloaded; installing in this browser…'));
            window.installDevice();
        })
        .catch(showFailure);

    function setStatus(color, text) {
        var dot = document.getElementById('coreStatusDot');
        if (dot) dot.className = 'status-dot ' + color;
        if (status) status.textContent = text;
    }

    function localized(zh, en) {
        var locale = window.EKA2L1 && EKA2L1.getLocale ? EKA2L1.getLocale() : '';
        return String(locale).toLowerCase().indexOf('zh') === 0 ? zh : en;
    }

    function showFailure(err) {
        console.error('[8BitGo] N-Gage QD 固件自动安装失败：', err);
        var error = document.getElementById('bootError');
        if (error) {
            error.textContent = localized(
                'N-Gage QD 固件未能自动安装。请在「安装设备固件」中手动选择 .rom 文件。',
                'N-Gage QD firmware could not be installed automatically. Choose a .rom file in “Install device firmware”.'
            );
            error.style.display = '';
        }
        setStatus('red', localized('固件自动安装失败', 'Automatic firmware installation failed'));
    }
})();

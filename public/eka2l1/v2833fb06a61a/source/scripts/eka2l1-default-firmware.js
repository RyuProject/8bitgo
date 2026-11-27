/*
 * 8BitGo 的 EKA2L1 默认固件和站内游戏引导。
 *
 * 用户从本站页面进入时，说明页把管理员配置的固件和当前游戏 URL 暂存到 sessionStorage。
 * 仅首次在本浏览器安装设备 ROM；游戏包随后写入浏览器自己的 EKA2L1 虚拟磁盘，
 * 这样同一设备可重复玩，且已安装的其它设备不会被默认固件覆盖。
 */
(function () {
    'use strict';

    var FIRMWARE_URL_KEY = '8bitgo.eka2l1.defaultFirmwareUrl';
    var FIRMWARE_INTEGRITY_URL_KEY = '8bitgo.eka2l1.defaultFirmwareIntegrityUrl';
    var GAME_URL_KEY = '8bitgo.eka2l1.gameUrl';
    var GAME_NAME_KEY = '8bitgo.eka2l1.gameName';
    var GAME_TITLE_KEY = '8bitgo.eka2l1.gameTitle';
    var MAX_ROM_BYTES = 128 * 1024 * 1024;
    var MAX_GAME_BYTES = 256 * 1024 * 1024;
    var firmwareUrl = consume(FIRMWARE_URL_KEY);
    var firmwareIntegrityUrl = consume(FIRMWARE_INTEGRITY_URL_KEY);
    var gameUrl = read(GAME_URL_KEY);
    var gameName = read(GAME_NAME_KEY) || 'ngage-game.n-gage';
    var gameTitle = read(GAME_TITLE_KEY) || gameName;

    if (!firmwareUrl && !gameUrl) return;
    firmwareUrl = safeUrl(firmwareUrl);
    firmwareIntegrityUrl = safeUrl(firmwareIntegrityUrl);
    gameUrl = safeUrl(gameUrl);
    if (firmwareUrl === false) {
        showFailure('固件地址无效', 'The firmware URL is invalid.');
        firmwareUrl = '';
    }
    if (firmwareIntegrityUrl === false) {
        showFailure('固件完整性清单地址无效，已停止自动安装。', 'The firmware integrity manifest URL is invalid; automatic installation was stopped.');
        return;
    }
    if (gameUrl === false) {
        showFailure('游戏地址无效', 'The game URL is invalid.');
        clearGameRequest();
        gameUrl = '';
    }

    var input = document.getElementById('romInput');
    var status = document.getElementById('coreStatusText');
    if ((firmwareUrl || gameUrl)
        && (typeof DataTransfer !== 'function' || typeof window.installDevice !== 'function')) {
        showFailure('当前模拟器页面不支持自动导入，请手动选择固件或游戏文件。',
            'This browser cannot import files automatically. Choose the firmware or game file manually.');
        return;
    }

    if (gameUrl && !firmwareUrl && !hasStoredDevice()) {
        setStatus('yellow', localized('请先安装设备固件；完成后会继续导入这款游戏。',
            'Install device firmware first; this game will be imported afterward.'));
    }

    var devicePromise;
    if (firmwareUrl && !hasStoredDevice()) {
        devicePromise = downloadFile(firmwareUrl, 'N-Gage-QD.rom', MAX_ROM_BYTES, true, firmwareIntegrityUrl)
            .then(installDeviceRom)
            .catch(function (err) {
                showFailure('N-Gage QD 固件自动安装失败。请在「安装设备固件」中手动选择 .rom 文件。',
                    'N-Gage QD firmware could not be installed automatically. Choose a .rom file in “Install device firmware”.', err);
                if (gameUrl) return waitForDeviceReady(10 * 60 * 1000);
                // 独立说明页没有后续消费者；把失败显示给玩家即可，避免留下未处理的 Promise 拒绝。
                return undefined;
            });
    } else if (firmwareUrl && hasStoredDevice()) {
        if (!gameUrl) return;
        // 旧标记偶尔会残留，但 IDBFS 里的设备已被删除；核心完成自检后可安全补装默认 ROM。
        devicePromise = waitForDeviceReady(90 * 1000, true).catch(function () {
            if (!isOnboardingReady()) throw new Error('当前设备启动失败，未自动替换固件');
            return downloadFile(firmwareUrl, 'N-Gage-QD.rom', MAX_ROM_BYTES, true, firmwareIntegrityUrl).then(installDeviceRom);
        });
    } else if (gameUrl) {
        devicePromise = waitForDeviceReady(10 * 60 * 1000);
    } else {
        return;
    }

    if (gameUrl) {
        devicePromise.then(function () {
            return downloadFile(gameUrl, safeFileName(gameName), MAX_GAME_BYTES, false);
        }).then(importGame).catch(function (err) {
            showFailure('这款游戏未能自动导入；可在模拟器「文件管理」中手动添加。',
                'This game could not be imported automatically. Add it manually from the emulator file manager.', err);
        });
    }

    function installDeviceRom(file) {
        if (!input) throw new Error('ROM 文件选择器不可用');
        assignFile(input, file);
        setStatus('yellow', localized('固件已下载，正在安装到此浏览器…', 'Firmware downloaded; installing in this browser…'));
        window.installDevice();
        return waitForDeviceReady(10 * 60 * 1000);
    }

    function importGame(file) {
        var ext = (gameName.split('.').pop() || '').toLowerCase();
        if (ext === 'sis' || ext === 'sisx') {
            var sisInput = document.getElementById('sisInput');
            if (!sisInput) throw new Error('SIS 文件选择器不可用');
            assignFile(sisInput, file);
        } else if (ext === 'n-gage') {
            var target = document.getElementById('fileUpTarget');
            var uploadInput = document.getElementById('fileUpInput');
            if (!target || !uploadInput) throw new Error('N-Gage 文件导入控件不可用');
            target.value = 'e:\\n-gage\\';
            assignFile(uploadInput, file);
            if (window.EKA2L1 && EKA2L1.toast) {
                EKA2L1.toast(localized('游戏包已放入 E:\\n-gage；请打开 Games 应用完成安装。',
                    'Game package added to E:\\n-gage. Open the Games app to finish installing it.'), 5000);
            }
        } else {
            throw new Error('不支持的塞班游戏格式：' + ext);
        }
        clearGameRequest();
    }

    function downloadFile(url, name, maxBytes, isFirmware, integrityUrl) {
        var label = isFirmware ? localized('N-Gage QD 固件', 'N-Gage QD firmware') : gameTitle;
        setStatus('yellow', localized('正在下载 ' + label + '…', 'Downloading ' + label + '…'));
        var transferController = new AbortController();
        var manifestTask = isFirmware && integrityUrl
            ? fetchIntegrityManifest(integrityUrl).catch(function (error) {
                transferController.abort();
                throw error;
            })
            : Promise.resolve(null);
        var downloadTask = fetch(url, { credentials: 'omit', cache: 'default', signal: transferController.signal }).then(function (response) {
            if (!response.ok) throw new Error('服务器返回 HTTP ' + response.status);
            var contentLength = Number(response.headers.get('content-length')) || 0;
            if (contentLength > maxBytes) throw new Error('文件过大，已停止下载');
            var integrityRequired = response.headers.get('X-8BitGo-Integrity-Required') === 'sha256-v1';
            var responseMeta = {
                status: response.status,
                etag: response.headers.get('ETag') || '',
                encoding: response.headers.get('Content-Encoding') || '',
                contentType: response.headers.get('Content-Type') || '',
                contentLength: contentLength,
                integrityRequired: integrityRequired,
            };
            var bodyTask;
            if (!response.body || typeof response.body.getReader !== 'function') {
                bodyTask = response.blob();
            } else {
                var reader = response.body.getReader();
                var chunks = [];
                var loaded = 0;
                function readNext() {
                    return reader.read().then(function (part) {
                        if (part.done) return new Blob(chunks, { type: 'application/octet-stream' });
                        loaded += part.value.byteLength;
                        if (loaded > maxBytes) {
                            reader.cancel();
                            throw new Error('文件超过 ' + Math.floor(maxBytes / 1048576) + ' MiB，已停止下载');
                        }
                        chunks.push(part.value);
                        if (status) {
                            var mb = (loaded / 1048576).toFixed(1);
                            var pct = contentLength ? ' ' + Math.floor(loaded * 100 / contentLength) + '%' : '';
                            status.textContent = localized('正在下载 ' + label + '：' + mb + ' MB' + pct,
                                'Downloading ' + label + ': ' + mb + ' MB' + pct);
                        }
                        return readNext();
                    });
                }
                bodyTask = readNext();
            }
            return bodyTask.then(function (blob) { return { blob: blob, meta: responseMeta }; });
        });
        return Promise.all([downloadTask, manifestTask]).then(function (results) {
            var asset = results[0];
            var blob = asset.blob;
            if (!blob || !blob.size) throw new Error('文件为空');
            if (blob.size > maxBytes) throw new Error('文件过大，已停止下载');
            if (isFirmware) return verifyFirmwareBlob(blob, asset.meta, url, results[1]).then(function () { return blob; });
            return blob;
        }).then(function (blob) {
            return new File([blob], name, { type: 'application/octet-stream' });
        });
    }

    function fetchIntegrityManifest(url) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, 2500);
        return fetch(url, { credentials: 'omit', cache: 'no-store', signal: controller.signal }).then(function (response) {
            if (response.status === 404 || response.status === 405) return null;
            if (response.status === 503 || response.status === 412) {
                var error = new Error('ROM / BIOS SHA-256 清单不可用（HTTP ' + response.status + '）');
                error.integrityManifestFailure = true;
                throw error;
            }
            if (!response.ok) return null;
            return response.json().then(function (value) {
                if (!value || typeof value.etag !== 'string' || !Number.isSafeInteger(value.size) ||
                    !value.manifest || typeof value.manifest !== 'object') return null;
                return Object.assign({}, value.manifest, { etag: value.etag, size: value.size });
            }).catch(function () { return null; });
        }).catch(function (error) {
            if (error && error.integrityManifestFailure) throw error;
            return null;
        }).finally(function () {
            clearTimeout(timer);
        });
    }

    function verifyFirmwareBlob(blob, meta, assetUrl, manifest) {
        var required = Boolean(meta.integrityRequired);
        if (!manifest) {
            if (required) throw new Error('本站要求校验此固件，但没有可用的 SHA-256 清单');
            return Promise.resolve();
        }
        var asset;
        try { asset = new URL(assetUrl, location.href); } catch (e) { throw new Error('固件地址无效，无法核对 SHA-256 清单'); }
        var key;
        try {
            var parts = asset.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            key = parts.join('/');
        } catch (e) { throw new Error('固件对象 key 无效，无法核对 SHA-256 清单'); }
        var expectedVersion = asset.searchParams.get('romv') || '';
        var manifestVersion = String(manifest.etag || '').replace(/^W\//, '').replace(/"/g, '').trim();
        var count = Math.ceil(Number(manifest.size) / 2097152);
        if (manifest.v !== 1 || manifest.alg !== 'sha256' || manifest.key !== key ||
            !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size !== blob.size ||
            manifest.blockBytes !== 2097152 || !Array.isArray(manifest.blocks) || manifest.blocks.length !== count ||
            manifest.blocks.some(function (hash) { return typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash); }) ||
            typeof manifest.etag !== 'string' || !manifest.etag || (expectedVersion && manifestVersion !== expectedVersion)) {
            throw new Error('固件 SHA-256 清单与当前文件版本或长度不一致');
        }
        if (meta.status !== 200 || meta.encoding || meta.etag !== manifest.etag ||
            (meta.contentLength && meta.contentLength !== manifest.size) ||
            /text\/html|application\/(?:json|xhtml)/i.test(meta.contentType)) {
            throw new Error('固件响应版本、编码、类型或长度与 SHA-256 清单不匹配');
        }
        var subtle = window.crypto && window.crypto.subtle;
        if (!subtle) throw new Error('浏览器不支持 SHA-256，已停止自动安装未校验的固件');
        return (async function () {
            for (var first = 0; first < manifest.blocks.length; first += 4) {
                var checks = await Promise.all(manifest.blocks.slice(first, first + 4).map(async function (expected, offset) {
                    var index = first + offset;
                    var start = index * manifest.blockBytes;
                    var bytes = new Uint8Array(await blob.slice(start, Math.min(blob.size, start + manifest.blockBytes)).arrayBuffer());
                    var digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
                    var actual = Array.from(digest, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
                    return actual === expected;
                }));
                if (checks.some(function (valid) { return !valid; })) throw new Error('固件 SHA-256 不匹配，已停止安装');
            }
        })();
    }

    function waitForDeviceReady(timeoutMs, rejectOnboarding) {
        return new Promise(function (resolve, reject) {
            var deadline = Date.now() + timeoutMs;
            function poll() {
                if (isDeviceReady()) { resolve(); return; }
                if (rejectOnboarding && isOnboardingReady()) { reject(new Error('设备尚未安装')); return; }
                if (Date.now() >= deadline) { reject(new Error('等待设备安装超时')); return; }
                setTimeout(poll, 500);
            }
            poll();
        });
    }

    function isDeviceReady() {
        var dot = document.getElementById('coreStatusDot');
        try {
            return localStorage.getItem('eka2l1_has_device') === '1'
                && Boolean(dot && dot.classList.contains('green'))
                && Boolean(window.EKA2L1 && EKA2L1.module && EKA2L1.module.FS);
        } catch (e) { return false; }
    }

    function isOnboardingReady() {
        var progress = document.getElementById('bootProgress');
        var card = document.getElementById('onboardCard');
        return Boolean(progress && progress.classList.contains('done') && card
            && window.getComputedStyle(card).display !== 'none');
    }

    function hasStoredDevice() {
        try {
            if (localStorage.getItem('eka2l1_has_device') === '1') return true;
            var apps = JSON.parse(localStorage.getItem('eka2l1_apps_cache') || '[]');
            return Array.isArray(apps) && apps.length > 0;
        } catch (e) { return false; }
    }

    function assignFile(inputEl, file) {
        var transfer = new DataTransfer();
        transfer.items.add(file);
        inputEl.files = transfer.files;
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function safeUrl(raw) {
        if (!raw) return '';
        try {
            var target = new URL(raw, location.href);
            if ((target.protocol !== 'https:' && target.origin !== location.origin)
                || target.username || target.password) return false;
            return target.href;
        } catch (e) { return false; }
    }

    function safeFileName(name) {
        var clean = String(name || 'ngage-game.n-gage').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
        return clean.slice(-120) || 'ngage-game.n-gage';
    }

    function read(key) {
        try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
    }

    function consume(key) {
        try {
            var value = sessionStorage.getItem(key) || '';
            sessionStorage.removeItem(key);
            return value;
        } catch (e) { return ''; }
    }

    function clearGameRequest() {
        try {
            sessionStorage.removeItem(GAME_URL_KEY);
            sessionStorage.removeItem(GAME_NAME_KEY);
            sessionStorage.removeItem(GAME_TITLE_KEY);
        } catch (e) {}
    }

    function setStatus(color, text) {
        var dot = document.getElementById('coreStatusDot');
        if (dot) dot.className = 'status-dot ' + color;
        if (status) status.textContent = text;
    }

    function localized(zh, en) {
        var locale = window.EKA2L1 && EKA2L1.getLocale ? EKA2L1.getLocale() : '';
        return String(locale).toLowerCase().indexOf('zh') === 0 ? zh : en;
    }

    function showFailure(zh, en, err) {
        console.error('[8BitGo] EKA2L1 导入失败：', err || zh);
        var error = document.getElementById('bootError');
        if (error) {
            error.textContent = localized(zh, en);
            error.style.display = '';
        }
        setStatus('red', localized('导入失败', 'Import failed'));
    }
})();

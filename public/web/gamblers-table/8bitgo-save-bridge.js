/*
 * Gamblers Table 的 Godot Web 存档接入。
 *
 * Godot 把 user:// 写进 IDBFS 的 /userfs；这里在主站登录态仍留在父页时，
 * 只交换这棵目录的文件快照。页面不读取登录令牌，也不自行调用存档 API。
 */
(function () {
	'use strict';

	const SOURCE = '8bitgo-save-bridge';
	const VERSION = 1;
	const DATABASE = '/userfs';
	const STORE = 'FILE_DATA';
	const DATABASE_VERSION = 21;
	const FORMAT = '8bitgo-gamblers-table-idbfs';
	const REQUEST_TIMEOUT_MS = 15_000;
	const AUTO_SAVE_DEBOUNCE_MS = 5_000;
	const AUTO_SAVE_POLL_MS = 15_000;
	const MAX_FILE_COUNT = 2048;
	const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
	const AUTO_PAUSE_KEY = '8bitgo.gamblers-table.cloud-save-paused';
	const SYNCED_KEY_PREFIX = '8bitgo.gamblers-table.cloud-synced.v1:';
	const DIRECTORY_MODE = 0x4000;
	const FILE_MODE = 0x8000;

	let hostOrigin = '';
	let requestId = 0;
	let gameStarted = false;
	let autoSaveEnabled = false;
	let autoSavePaused = readExplicitPause();
	let autoSaveTimer = 0;
	let autoSavePollTimer = 0;
	let autoSaveInFlight = null;
	let autoSaveQueued = false;
	let lastAutoSaveFingerprint = '';
	/** 主站给的账号摘要标签；「上次同步的指纹」按它分账号记。 */
	let account = '';
	let syncInFlight = null;
	const pending = new Map();

	function readExplicitPause() {
		try {
			return window.localStorage.getItem(AUTO_PAUSE_KEY) === '1';
		} catch (_) {
			/* 隐私模式禁用存储时仍保留当前文档内的暂停状态。 */
			return false;
		}
	}

	function writeExplicitPause(paused) {
		try {
			if (paused) window.localStorage.setItem(AUTO_PAUSE_KEY, '1');
			else window.localStorage.removeItem(AUTO_PAUSE_KEY);
		} catch (_) {
			/* 存储不可用不应阻止游戏启动或本机存档。 */
		}
	}

	function allowedHostOrigin() {
		if (window.parent === window) return '';
		try {
			const origin = new URL(document.referrer).origin;
			const host = new URL(origin).hostname.toLowerCase();
			if (origin === location.origin) return origin;
			if (new URL(origin).protocol === 'https:' && [
				'8bitgo.com', 'www.8bitgo.com', 'cn.8bitgo.com', 'tv.8bitgo.com',
			].includes(host)) return origin;
		} catch (_) {
			/* 嵌入来源不可信时只保留本地存档。 */
		}
		return '';
	}

	function post(message, transfer) {
		if (!hostOrigin) return false;
		try {
			window.parent.postMessage(Object.assign({ source: SOURCE, version: VERSION }, message), hostOrigin, transfer || []);
			return true;
		} catch (error) {
			console.warn('[Gamblers Table] 无法连接 8BitGo 存档桥', error);
			return false;
		}
	}

	function request(type, fields, transfer) {
		if (!hostOrigin) return Promise.reject(new Error('8BitGo 存档桥未连接'));
		const id = ++requestId;
		return new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => {
				pending.delete(id);
				reject(new Error('8BitGo 自动云存档响应超时'));
			}, REQUEST_TIMEOUT_MS);
			pending.set(id, { resolve, reject, timer });
			if (!post(Object.assign({ type, requestId: id }, fields || {}), transfer)) {
				pending.delete(id);
				window.clearTimeout(timer);
				reject(new Error('无法向 8BitGo 播放器发送存档请求'));
			}
		});
	}

	function openDatabase() {
		return new Promise((resolve, reject) => {
			let req;
			try {
				req = indexedDB.open(DATABASE, DATABASE_VERSION);
			} catch (error) {
				reject(error);
				return;
			}
			req.onupgradeneeded = () => {
				const db = req.result;
				const store = db.objectStoreNames.contains(STORE)
					? req.transaction.objectStore(STORE)
					: db.createObjectStore(STORE);
				if (!store.indexNames.contains('timestamp')) store.createIndex('timestamp', 'timestamp', { unique: false });
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error || new Error('无法打开 Godot 本地存档库'));
		});
	}

	function requestResult(req) {
		return new Promise((resolve, reject) => {
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error || new Error('读取 Godot 本地存档失败'));
		});
	}

	function validPath(path) {
		return typeof path === 'string' &&
			(path === '/userfs' || path.startsWith('/userfs/')) &&
			!path.split('/').some((part) => part === '.' || part === '..') &&
			!/[\u0000-\u001f\u007f]/.test(path);
	}

	function bytesToBase64(bytes) {
		let binary = '';
		const chunkSize = 0x8000;
		for (let offset = 0; offset < bytes.length; offset += chunkSize) {
			binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
		}
		return btoa(binary);
	}

	function base64ToBytes(value) {
		if (typeof value !== 'string' || value.length > MAX_SNAPSHOT_BYTES * 2) {
			throw new Error('云存档中的 Godot 文件内容无效');
		}
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	async function readRecords() {
		const db = await openDatabase();
		try {
			if (!db.objectStoreNames.contains(STORE)) return [];
			const tx = db.transaction(STORE, 'readonly');
			const store = tx.objectStore(STORE);
			const keys = await requestResult(store.getAllKeys());
			const values = await requestResult(store.getAll());
			return keys.map((key, index) => ({ path: key, value: values[index] }));
		} finally {
			db.close();
		}
	}

	function hasGameFiles(records) {
		return records.some(({ path, value }) => path !== '/userfs' &&
			validPath(path) && value && (Number(value.mode) & 0xf000) === FILE_MODE);
	}

	function encodeSnapshot(records) {
		const files = [];
		let rawBytes = 0;
		for (const { path, value } of records) {
			if (!validPath(path) || !value || !Number.isInteger(Number(value.mode))) continue;
			const mode = Number(value.mode);
			const kind = mode & 0xf000;
			if (kind !== DIRECTORY_MODE && kind !== FILE_MODE) continue;
			const contents = kind === FILE_MODE
				? new Uint8Array(value.contents || 0)
				: new Uint8Array(0);
			rawBytes += contents.byteLength;
			if (rawBytes > MAX_SNAPSHOT_BYTES || files.length >= MAX_FILE_COUNT) {
				throw new Error('Gamblers Table 本地存档超过自动云存档限制');
			}
			const timestamp = value.timestamp instanceof Date
				? value.timestamp.getTime()
				: Number(value.timestamp) || Date.now();
			files.push({ path, mode, timestamp, contents: bytesToBase64(contents) });
		}
		if (!hasGameFiles(records)) return null;
		return new TextEncoder().encode(JSON.stringify({ format: FORMAT, version: 1, files }));
	}

	function decodeSnapshot(bytes) {
		if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MAX_SNAPSHOT_BYTES) {
			throw new Error('Gamblers Table 云存档大小无效');
		}
		const snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (!snapshot || snapshot.format !== FORMAT || snapshot.version !== 1 || !Array.isArray(snapshot.files) ||
			snapshot.files.length === 0 || snapshot.files.length > MAX_FILE_COUNT) {
			throw new Error('Gamblers Table 云存档格式不兼容');
		}
		let rawBytes = 0;
		const records = snapshot.files.map((item) => {
			const mode = Number(item && item.mode);
			const kind = mode & 0xf000;
			if (!validPath(item && item.path) || (kind !== DIRECTORY_MODE && kind !== FILE_MODE)) {
				throw new Error('Gamblers Table 云存档路径无效');
			}
			const contents = kind === FILE_MODE ? base64ToBytes(item.contents || '') : new Uint8Array(0);
			rawBytes += contents.byteLength;
			if (rawBytes > MAX_SNAPSHOT_BYTES) throw new Error('Gamblers Table 云存档展开后过大');
			return {
				path: item.path,
				value: {
					timestamp: new Date(Number(item.timestamp) || Date.now()),
					mode,
					...(kind === FILE_MODE ? { contents } : {}),
				},
			};
		});
		if (!hasGameFiles(records)) throw new Error('Gamblers Table 云存档没有游戏文件');
		return records;
	}

	async function replaceSnapshot(bytes) {
		const records = decodeSnapshot(bytes);
		const db = await openDatabase();
		try {
			if (!db.objectStoreNames.contains(STORE)) throw new Error('Godot 存档库结构不兼容');
			await new Promise((resolve, reject) => {
				const tx = db.transaction(STORE, 'readwrite');
				const store = tx.objectStore(STORE);
				store.clear();
				for (const item of records) store.put(item.value, item.path);
				tx.oncomplete = () => resolve();
				tx.onerror = tx.onabort = () => reject(tx.error || new Error('写入 Godot 云存档失败'));
			});
		} finally {
			db.close();
		}
	}

	function validAccount(value) {
		return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '';
	}

	function readSyncedFingerprint() {
		if (!account) return '';
		try {
			return window.localStorage.getItem(SYNCED_KEY_PREFIX + account) || '';
		} catch (_) {
			return '';
		}
	}

	function writeSyncedFingerprint(value) {
		if (!account || !value) return;
		try {
			window.localStorage.setItem(SYNCED_KEY_PREFIX + account, value);
		} catch (_) {
			/* 存不下只会让下次开局多一次「从没同步过」的比较，不会丢档。 */
		}
	}

	/**
	 * 只看路径、类型和文件内容的指纹。快照里的 timestamp 每次 Godot 落盘都会变，
	 * 用整份快照字节比较会把「内容没变」误判成「改过」，开局比较就会凭空制造冲突。
	 */
	async function contentFingerprint(records) {
		const items = [];
		for (const { path, value } of records) {
			if (!validPath(path) || !value || !Number.isInteger(Number(value.mode))) continue;
			const kind = Number(value.mode) & 0xf000;
			if (kind !== DIRECTORY_MODE && kind !== FILE_MODE) continue;
			let digest = '';
			if (kind === FILE_MODE) {
				const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value.contents || 0)));
				digest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
			}
			items.push(path + '\u0000' + kind + '\u0000' + digest);
		}
		if (!hasGameFiles(records)) return '';
		items.sort();
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(items.join('\n'))));
		return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	}

	/**
	 * 开局谁赢：和模拟器电池存档（src/emulator/batterySync.ts）、PvZ 同一套规则，比「上次和云端同步时的内容指纹」：
	 *   本地没变、云端变了 → 用云端；本地变了、云端没变 → 留本地并推上去；
	 *   两边都变了（含这台浏览器从没同步过、两边又都有存档）→ 冲突，留本地，不自动覆盖云端。
	 * pending：主站给的是它自己待补传的本机快照，本地有档时一律留本地。
	 */
	function decideSync(localFp, cloudFp, lastFp, pendingCopy) {
		if (!cloudFp) return localFp ? 'keep-local' : 'none';
		if (!localFp) return 'use-cloud';
		if (localFp === cloudFp) return 'in-sync';
		if (pendingCopy) return 'keep-local';
		if (lastFp && localFp === lastFp) return 'use-cloud';
		if (lastFp && cloudFp === lastFp) return 'keep-local';
		return 'conflict';
	}

	async function snapshotWithRecords() {
		const engine = window.gamblersTableEngine;
		const runtime = engine && engine.rtenv;
		const sync = runtime && runtime['8bitgoSyncPersistentFS'];
		if (typeof sync === 'function') {
			if (!syncInFlight) {
				syncInFlight = Promise.resolve(sync()).finally(() => { syncInFlight = null; });
			}
			await syncInFlight;
		}
		const records = await readRecords();
		return { bytes: encodeSnapshot(records), records };
	}

	async function snapshot() {
		return (await snapshotWithRecords()).bytes;
	}

	function scheduleAutoSave(delay) {
		if (!gameStarted || !autoSaveEnabled || autoSavePaused) return;
		window.clearTimeout(autoSaveTimer);
		autoSaveTimer = window.setTimeout(() => {
			autoSaveTimer = 0;
			void checkAutoSave(false);
		}, Number.isFinite(delay) ? delay : AUTO_SAVE_DEBOUNCE_MS);
	}

	function syncAutoSavePolling() {
		const shouldPoll = gameStarted && autoSaveEnabled && !autoSavePaused;
		if (shouldPoll && !autoSavePollTimer) {
			autoSavePollTimer = window.setInterval(() => scheduleAutoSave(0), AUTO_SAVE_POLL_MS);
		} else if (!shouldPoll && autoSavePollTimer) {
			window.clearInterval(autoSavePollTimer);
			autoSavePollTimer = 0;
		}
	}

	async function checkAutoSave(force) {
		if ((!gameStarted && !force) || !autoSaveEnabled || autoSavePaused) return;
		if (autoSaveInFlight) {
			if (force) return autoSaveInFlight.then(() => checkAutoSave(true));
			autoSaveQueued = true;
			return autoSaveInFlight;
		}
		autoSaveInFlight = (async () => {
			try {
				const taken = await snapshotWithRecords();
				const bytes = taken.bytes;
				if (!bytes) return;
				const current = await contentFingerprint(taken.records);
				if (!current || current === lastAutoSaveFingerprint) return;
				const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
				const response = await request('auto-snapshot-request', { data: buffer }, [buffer]);
				const status = response && response.status;
				if (status === 'saved' || status === 'queued') {
					lastAutoSaveFingerprint = current;
					// queued 还在主站待补传队列里，云端未必有这一份，不能记成「同步过」。
					if (status === 'saved') writeSyncedFingerprint(current);
					return;
				}
				if (status === 'conflict' || status === 'blocked') {
					lastAutoSaveFingerprint = current;
					autoSavePaused = true;
					autoSaveEnabled = false;
					syncAutoSavePolling();
					console.warn('[Gamblers Table] 云存档自动同步已暂停：', status);
					return;
				}
				if (status === 'disabled') {
					autoSaveEnabled = false;
					syncAutoSavePolling();
				}
			} catch (error) {
				// 本地 IDBFS 仍保留进度；下次轮询会再次尝试。
				console.warn('[Gamblers Table] 自动云存档失败，稍后重试：', error);
			}
		})().finally(() => {
			autoSaveInFlight = null;
			if (autoSaveQueued) {
				autoSaveQueued = false;
				scheduleAutoSave(0);
			}
		});
		return autoSaveInFlight;
	}

	async function initializeBeforeStart() {
		hostOrigin = allowedHostOrigin();
		if (!hostOrigin) return;
		post({ type: 'ready' });
		try {
			const localRecords = await readRecords();
			const local = encodeSnapshot(localRecords);
			const response = await request('auto-restore-request', {
				localSaveBytes: local ? local.byteLength : 0,
				pausedByUserChoice: autoSavePaused,
			});
			if (response && response.paused) {
				autoSavePaused = true;
				autoSaveEnabled = false;
				return;
			}
			if (!response || response.enabled !== true) return;
			account = validAccount(response.account);
			const pendingCopy = response.pending === true;
			const cloud = response.data instanceof ArrayBuffer && response.data.byteLength > 0 ? response.data : null;
			const cloudFp = cloud ? await contentFingerprint(decodeSnapshot(cloud)) : '';
			const localFp = local ? await contentFingerprint(localRecords) : '';
			const decision = decideSync(localFp, cloudFp, readSyncedFingerprint(), pendingCopy);
			if (decision === 'conflict') {
				// 两份都留着：本地继续玩，云端不动；本地那份交给主站记成冲突待同步档，由玩家在存档面板处理。
				autoSavePaused = true;
				autoSaveEnabled = false;
				console.warn('[Gamblers Table] 本地与云端存档都改过，保留本地进度并暂停自动同步');
				try {
					const buffer = local.buffer.slice(local.byteOffset, local.byteOffset + local.byteLength);
					await request('auto-conflict', { data: buffer }, [buffer]);
				} catch (error) {
					console.warn('[Gamblers Table] 无法向 8BitGo 报告存档冲突', error);
				}
				return;
			}
			if (decision === 'use-cloud') {
				await replaceSnapshot(cloud);
				lastAutoSaveFingerprint = await contentFingerprint(await readRecords());
				if (!pendingCopy) writeSyncedFingerprint(lastAutoSaveFingerprint);
			} else if (decision === 'in-sync') {
				lastAutoSaveFingerprint = localFp;
				if (!pendingCopy) writeSyncedFingerprint(localFp);
			} else {
				// keep-local：基线设成云端那份，开局后的检查发现本地不同就推上去；none：两边都没有。
				lastAutoSaveFingerprint = pendingCopy ? '' : cloudFp;
			}
			autoSaveEnabled = true;
			autoSavePaused = false;
		} catch (error) {
			// 读云端结果不确定时继续用本地进度，并暂停上传以免覆盖远端新档。
			autoSavePaused = true;
			autoSaveEnabled = false;
			syncAutoSavePolling();
			console.warn('[Gamblers Table] 云存档读取失败，继续使用本地进度：', error);
		}
	}

	window.addEventListener('message', (event) => {
		if (!hostOrigin || event.source !== window.parent || event.origin !== hostOrigin) return;
		const message = event.data;
		if (!message || message.source !== SOURCE || message.version !== VERSION) return;
		if (message.type === 'auto-mode') {
			window.clearTimeout(autoSaveTimer);
			autoSaveTimer = 0;
			if (message.clearPaused === true) writeExplicitPause(false);
			if (validAccount(message.account)) account = message.account;
			autoSaveEnabled = message.enabled === true;
			autoSavePaused = message.paused === true;
			// 只有播放器明确要求暂停（例如玩家选了本地档）才跨重载保留；
			// 自动冲突和临时网络错误由主站的存档状态决定，不能留下陈旧的本地标记。
			if (message.paused === true) writeExplicitPause(true);
			syncAutoSavePolling();
			if (autoSaveEnabled && !autoSavePaused) scheduleAutoSave(0);
			return;
		}
		if (message.type === 'auto-final-snapshot') {
			// 主站要拆播放器：交出最后一份自动快照（内容没变就不发），然后回 auto-final-done。
			void (async () => {
				try {
					await checkAutoSave(true);
				} catch (_) {
					/* 交不出去也要回执，主站最多等 1.5 秒 */
				}
				post({ type: 'auto-final-done' });
			})();
			return;
		}
		if (!Number.isInteger(message.requestId)) return;
		if (message.type === 'auto-restore-response' || message.type === 'auto-snapshot-response') {
			const item = pending.get(message.requestId);
			if (!item) return;
			pending.delete(message.requestId);
			window.clearTimeout(item.timer);
			item.resolve(message);
			return;
		}
		if (message.type !== 'export' && message.type !== 'import') return;
		void (async () => {
			try {
				if (message.type === 'export') {
					const bytes = await snapshot();
					if (!bytes) throw new Error('Gamblers Table 还没有可保存的游戏进度');
					const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
					post({ type: 'response', requestId: message.requestId, ok: true, data }, [data]);
					return;
				}
				if (!(message.data instanceof ArrayBuffer) || message.data.byteLength === 0) {
					throw new Error('Gamblers Table 收到的云存档为空');
				}
				await replaceSnapshot(message.data);
				post({ type: 'response', requestId: message.requestId, ok: true });
			} catch (error) {
				post({
					type: 'response',
					requestId: message.requestId,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	});

	window.GamblersTableCloudSave = Object.freeze({
		initializeBeforeStart,
		markStarted() {
			gameStarted = true;
			syncAutoSavePolling();
			if (autoSaveEnabled && !autoSavePaused) scheduleAutoSave(0);
		},
	});

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') void checkAutoSave(true);
		else if (autoSaveEnabled && !autoSavePaused) scheduleAutoSave(0);
	});
	window.addEventListener('pagehide', () => { void checkAutoSave(true); });
}());

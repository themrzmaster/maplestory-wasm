/**
 * LazyFS - True Lazy Filesystem for WebAssembly
 * WebSocket-based asset streaming with IndexedDB persistent caching
 * 
 * This file is loaded via --pre-js before Module initialization
 * 
 * Features:
 * - IndexedDB persistent cache (survives browser restarts!)
 * - WebSocket connection for streaming file chunks
 * - Batched chunk requests for efficient pipelining
 * - In-memory chunk caching for current session
 * - First load: Download from server, cache locally
 * - Future loads: Instant from local cache
 */

// Define LazyFS before Module is initialized
var LazyFS = {
	// Configuration
	CHUNK_SIZE: 0, // Set dynamically from C++
	HTTP_CHUNK_SIZE: 2097152, // 2 MiB — balance HTTP overhead vs chunk size in Range mode
	ASSETS_WS_URL: null, // Set from C++ or auto-detect
	NxBaseUrl: null, // If set, fetch NX assets via HTTPS Range (e.g. R2) instead of the WS protocol
	DB_NAME: 'LazyFS_Cache',
	DB_VERSION: 1,
	STORE_NAME: 'chunks',

	// Transport mode helper — true when NxBaseUrl is configured
	isHttpMode: function () {
		return typeof this.NxBaseUrl === 'string' && this.NxBaseUrl.length > 0;
	},

	// Effective chunk size for the current transport. HTTP Range benefits from smaller
	// chunks: nlnx often reads a few hundred bytes of header, so the default 2 MiB
	// over-fetches by ~8000×. 256 KiB gives ~130 ms chunk time at 15 Mbps instead of 1 s.
	getChunkSize: function () {
		return this.isHttpMode() ? this.HTTP_CHUNK_SIZE : this.CHUNK_SIZE;
	},

	getHttpUrl: function (filename) {
		var base = this.NxBaseUrl.replace(/\/+$/, '');
		return base + '/' + filename.replace(/^\/+/, '');
	},

	// IndexedDB connection
	db: null,
	dbReady: false,
	dbInitPromise: null,

	// WebSocket connection
	ws: null,
	wsConnected: false,
	wsConnecting: false,
	wsQueue: [], // Queued requests while connecting

	// Pending requests: Map<requestId, {resolve, reject}>
	pendingRequests: new Map(),
	requestIdCounter: 0,

	// In-memory chunk cache: Map<"file:size:chunk", Uint8Array>
	chunkCache: new Map(),

	// File registry: Map<filepath, { size }>
	files: new Map(),

	// ========== FETCH STATISTICS ==========
	stats: {
		totalRequests: 0,
		totalBytes: 0,
		cacheHits: 0,
		cacheMisses: 0,
		startTime: null,
	},

	logFetch: function (filepath, chunkIndex, bytes, fromCache) {
		if (!this.stats.startTime) {
			this.stats.startTime = performance.now();
		}

		if (fromCache) {
			this.stats.cacheHits++;
		} else {
			this.stats.cacheMisses++;
			this.stats.totalRequests++;
			this.stats.totalBytes += bytes;
		}

		const elapsed = ((performance.now() - this.stats.startTime) / 1000).toFixed(2);
		const source = fromCache ? '💾 CACHE' : '🌐 NET';
		console.debug(`[LazyFS] [${elapsed}s] ${source}: ${filepath} chunk ${chunkIndex} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
	},

	printStats: function () {
		console.log('========== LazyFS Statistics ==========');
		console.log('Network requests:', this.stats.totalRequests);
		console.log('Network data:', (this.stats.totalBytes / 1024 / 1024).toFixed(2), 'MB');
		console.log('Cache hits:', this.stats.cacheHits);
		console.log('Cache misses:', this.stats.cacheMisses);
		console.log('Cache hit rate:', ((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100).toFixed(1), '%');
		if (this.stats.startTime) {
			console.log('Time since first fetch:', ((performance.now() - this.stats.startTime) / 1000).toFixed(2), 's');
		}
		console.log('========================================');
	},

	// ========== INDEXEDDB CACHE ==========

	/**
	 * Build a cache key scoped by file version so swapped files with the same
	 * filename don't reuse stale chunks from older versions.
	 */
	getChunkCacheKey: function (filename, versionTag, chunkIndex) {
		return `${filename}:${versionTag}:${chunkIndex}`;
	},

	getFileVersionTag: function (fileEntry) {
		if (!fileEntry) {
			return 'unknown';
		}
		// Cache keys include the chunk size so entries from an older build with a
		// different chunk granularity don't alias new requests.
		const chunkTag = `c${this.getChunkSize()}`;
		if (fileEntry.version !== null && fileEntry.version !== undefined) {
			return `v${fileEntry.version}:${chunkTag}`;
		}
		if (fileEntry.size !== null && fileEntry.size !== undefined) {
			return `s${fileEntry.size}:${chunkTag}`;
		}
		return 'unknown';
	},

	/**
	 * Initialize IndexedDB cache
	 */
	initDB: function () {
		if (this.dbInitPromise) {
			return this.dbInitPromise;
		}

		this.dbInitPromise = new Promise((resolve, reject) => {
			console.log('[LazyFS] Initializing IndexedDB cache...');

			const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

			request.onerror = (event) => {
				console.error('[LazyFS] IndexedDB error:', event.target.error);
				this.dbReady = false;
				resolve(false); // Don't reject, just continue without cache
			};

			request.onsuccess = (event) => {
				this.db = event.target.result;
				this.dbReady = true;
				console.log('[LazyFS] IndexedDB cache ready');
				resolve(true);
			};

			request.onupgradeneeded = (event) => {
				const db = event.target.result;
				// Create object store for chunks: key = "filename:chunkIndex"
				if (!db.objectStoreNames.contains(this.STORE_NAME)) {
					db.createObjectStore(this.STORE_NAME);
					console.log('[LazyFS] Created IndexedDB object store');
				}
			};
		});

		return this.dbInitPromise;
	},

	/**
	 * Get chunk from IndexedDB cache
	 */
	getCachedChunk: function (filename, versionTag, chunkIndex) {
		if (!this.dbReady || !this.db) {
			return Promise.resolve(null);
		}

		return new Promise((resolve) => {
			try {
				const tx = this.db.transaction(this.STORE_NAME, 'readonly');
				const store = tx.objectStore(this.STORE_NAME);
				const key = this.getChunkCacheKey(filename, versionTag, chunkIndex);
				const request = store.get(key);

				request.onsuccess = () => {
					resolve(request.result || null);
				};

				request.onerror = () => {
					resolve(null);
				};
			} catch (e) {
				resolve(null);
			}
		});
	},

	/**
	 * Store chunk in IndexedDB cache
	 */
	setCachedChunk: function (filename, versionTag, chunkIndex, data) {
		if (!this.dbReady || !this.db) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			try {
				const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
				const store = tx.objectStore(this.STORE_NAME);
				const key = this.getChunkCacheKey(filename, versionTag, chunkIndex);
				store.put(data, key);

				tx.oncomplete = () => resolve(true);
				tx.onerror = () => resolve(false);
			} catch (e) {
				resolve(false);
			}
		});
	},

	/**
	 * Clear the entire IndexedDB cache
	 */
	clearCache: function () {
		if (!this.dbReady || !this.db) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			try {
				const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
				const store = tx.objectStore(this.STORE_NAME);
				store.clear();

				tx.oncomplete = () => {
					console.log('[LazyFS] Cache cleared');
					resolve(true);
				};
				tx.onerror = () => resolve(false);
			} catch (e) {
				resolve(false);
			}
		});
	},

	// ========== WEBSOCKET CONNECTION ==========

	/**
	 * Initialize WebSocket connection to assets server
	 */
	connect: function () {
		// HTTP mode — no persistent connection needed, each chunk is a Range request
		if (this.isHttpMode()) {
			return Promise.resolve();
		}

		if (this.wsConnected || this.wsConnecting) {
			return Promise.resolve();
		}

		if (!this.ASSETS_WS_URL) {
			// Auto-detect URL based on page location
			const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
			const host = window.location.hostname;
			this.ASSETS_WS_URL = `${protocol}//${host}:8765`;
		}

		console.log('[LazyFS] Connecting to assets server:', this.ASSETS_WS_URL);
		this.wsConnecting = true;

		return new Promise((resolve, reject) => {
			try {
				this.ws = new WebSocket(this.ASSETS_WS_URL);
				this.ws.binaryType = 'arraybuffer'; // Receive binary as ArrayBuffer

				this.ws.onopen = () => {
					console.log('[LazyFS] WebSocket connected');
					this.wsConnected = true;
					this.wsConnecting = false;

					// Process queued requests
					while (this.wsQueue.length > 0) {
						const msg = this.wsQueue.shift();
						this.ws.send(msg);
					}

					resolve();
				};

				this.ws.onmessage = (event) => {
					this.handleMessage(event.data);
				};

				this.ws.onerror = (error) => {
					console.error('[LazyFS] WebSocket error:', error);
					this.wsConnecting = false;
					reject(error);
				};

				this.ws.onclose = () => {
					console.log('[LazyFS] WebSocket disconnected');
					this.wsConnected = false;
					this.ws = null;
				};
			} catch (e) {
				console.error('[LazyFS] Failed to create WebSocket:', e);
				this.wsConnecting = false;
				reject(e);
			}
		});
	},

	/**
	 * Send a message (queue if not connected)
	 */
	send: function (msg) {
		const msgStr = JSON.stringify(msg);
		if (this.wsConnected && this.ws) {
			this.ws.send(msgStr);
		} else {
			this.wsQueue.push(msgStr);
			this.connect();
		}
	},

	/**
	 * Handle incoming WebSocket message (text or binary)
	 */
	handleMessage: function (data) {
		// Check if binary frame
		if (data instanceof ArrayBuffer) {
			this.handleBinaryChunk(data);
			return;
		}

		// Text frame - parse as JSON
		try {
			const msg = JSON.parse(data);

			if (msg.type === 'size') {
				if (this.files.has(msg.file)) {
					const fileEntry = this.files.get(msg.file);
					fileEntry.version = msg.version;
				}
				// File size response
				const key = `size:${msg.file}`;
				const pending = this.pendingRequests.get(key);
				if (pending) {
					this.pendingRequests.delete(key);
					pending.resolve(msg.size);
				}
			} else if (msg.type === 'chunks_done') {
				// Batch request completed
				const key = `batch:${msg.file}:${msg.start}:${msg.end}`;
				const pending = this.pendingRequests.get(key);
				if (pending) {
					this.pendingRequests.delete(key);
					pending.resolve();
				}
			} else if (msg.type === 'error') {
				console.error('[LazyFS] Server error:', msg.message);
			}
		} catch (e) {
			console.error('[LazyFS] Error parsing message:', e);
		}
	},

	/**
	 * Handle binary chunk data
	 * Format: [4 bytes: chunk index LE] [1 byte: filename len] [filename] [data]
	 */
	handleBinaryChunk: function (buffer) {
		const view = new DataView(buffer);

		// Parse header
		const chunkIndex = view.getUint32(0, true); // little-endian
		const filenameLen = view.getUint8(4);
		const filenameBytes = new Uint8Array(buffer, 5, filenameLen);
		const filename = new TextDecoder().decode(filenameBytes);

		// Extract chunk data
		const dataStart = 5 + filenameLen;
		const chunkData = new Uint8Array(buffer, dataStart);

		// Store in cache (memory)
		const fileEntry = this.files.get(filename);
		const versionTag = this.getFileVersionTag(fileEntry);
		const cacheKey = this.getChunkCacheKey(filename, versionTag, chunkIndex);
		this.chunkCache.set(cacheKey, chunkData);

		// Store in cache (persistent)
		if (versionTag !== 'unknown') {
			this.setCachedChunk(filename, versionTag, chunkIndex, chunkData);
		}

		// Log
		this.logFetch(filename, chunkIndex, chunkData.length, false);

		// Resolve any pending request for this specific chunk
		const pendingKey = `chunk:${filename}:${chunkIndex}`;
		const pending = this.pendingRequests.get(pendingKey);
		if (pending) {
			this.pendingRequests.delete(pendingKey);
			pending.resolve(chunkData);
		}
	},

	// ========== FILE OPERATIONS ==========

	/**
	 * Register a file for lazy loading
	 */
	registerFile: function (filepath, url) {
		console.log('[LazyFS] Registering file:', filepath);
		this.files.set(filepath, {
			size: null,
			version: null,
		});
	},

	/**
	 * Get file size via WebSocket or HTTP HEAD
	 */
	getFileSize: async function (filepath) {
		if (this.isHttpMode()) {
			const url = this.getHttpUrl(filepath);
			const response = await fetch(url, { method: 'HEAD' });
			if (!response.ok) {
				throw new Error(`HEAD ${url} -> ${response.status}`);
			}
			const size = parseInt(response.headers.get('content-length') || '0', 10);
			const etag = response.headers.get('etag');
			const lastModified = response.headers.get('last-modified');
			const versionTag = etag
				? etag.replace(/"/g, '')
				: lastModified
					? Date.parse(lastModified).toString()
					: null;
			if (this.files.has(filepath)) {
				this.files.get(filepath).version = versionTag;
			}
			return size;
		}

		await this.connect();

		const key = `size:${filepath}`;

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(key, { resolve, reject });
			this.send({
				type: 'get_size',
				file: filepath
			});

			// Timeout after 10 seconds
			setTimeout(() => {
				if (this.pendingRequests.has(key)) {
					this.pendingRequests.delete(key);
					reject(new Error('Timeout getting file size'));
				}
			}, 10000);
		});
	},

	/**
	 * Fetch a batch of chunks [startChunk, endChunk] inclusive via a single HTTP Range request.
	 * Splits the response into per-chunk buffers and seeds both memory + IndexedDB caches
	 * so the rest of LazyFS doesn't need to know which transport was used.
	 */
	fetchChunksHttp: async function (filepath, startChunk, endChunk) {
		const fileEntry = this.files.get(filepath);
		if (!fileEntry) {
			throw new Error(`File not registered: ${filepath}`);
		}
		if (fileEntry.size === null || fileEntry.size === undefined) {
			// Ensure we know the total size before computing the tail range
			fileEntry.size = await this.getFileSize(filepath);
		}

		const chunkSize = this.getChunkSize();
		const rangeStart = startChunk * chunkSize;
		const rangeEnd = Math.min((endChunk + 1) * chunkSize, fileEntry.size) - 1;
		const url = this.getHttpUrl(filepath);
		const response = await fetch(url, {
			headers: { 'Range': `bytes=${rangeStart}-${rangeEnd}` }
		});
		if (!response.ok && response.status !== 206) {
			throw new Error(`GET ${url} Range bytes=${rangeStart}-${rangeEnd} -> ${response.status}`);
		}
		const buffer = new Uint8Array(await response.arrayBuffer());

		const versionTag = this.getFileVersionTag(fileEntry);
		let offset = 0;
		for (let chunkIdx = startChunk; chunkIdx <= endChunk; chunkIdx++) {
			const remaining = buffer.length - offset;
			if (remaining <= 0) break;
			const len = Math.min(chunkSize, remaining);
			const chunkData = buffer.slice(offset, offset + len);
			offset += len;

			const cacheKey = this.getChunkCacheKey(filepath, versionTag, chunkIdx);
			this.chunkCache.set(cacheKey, chunkData);
			if (versionTag !== 'unknown') {
				this.setCachedChunk(filepath, versionTag, chunkIdx, chunkData);
			}
			this.logFetch(filepath, chunkIdx, chunkData.length, false);
		}
	},

	/**
	 * Fetch a batch of chunks
	 */
	fetchChunks: async function (filepath, startChunk, endChunk) {
		if (this.isHttpMode()) {
			return this.fetchChunksHttp(filepath, startChunk, endChunk);
		}

		await this.connect();

		const key = `batch:${filepath}:${startChunk}:${endChunk}`;

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(key, { resolve, reject });
			this.send({
				type: 'get_chunks',
				file: filepath,
				start: startChunk,
				end: endChunk,
				chunk_size: this.CHUNK_SIZE
			});

			// Timeout after 60 seconds for large batches
			setTimeout(() => {
				if (this.pendingRequests.has(key)) {
					this.pendingRequests.delete(key);
					reject(new Error('Timeout fetching chunks'));
				}
			}, 60000);
		});
	},

	/**
	 * Get a chunk from cache or fetch it
	 */
	getChunk: async function (filepath, chunkIndex) {
		const fileEntry = this.files.get(filepath);
		const versionTag = this.getFileVersionTag(fileEntry);
		const cacheKey = this.getChunkCacheKey(filepath, versionTag, chunkIndex);

		// Check cache first
		if (this.chunkCache.has(cacheKey)) {
			return this.chunkCache.get(cacheKey);
		}

		// HTTP mode — single-chunk path reuses the batch implementation
		if (this.isHttpMode()) {
			await this.fetchChunksHttp(filepath, chunkIndex, chunkIndex);
			return this.chunkCache.get(cacheKey) || null;
		}

		// Fetch single chunk
		await this.connect();

		const key = `chunk:${filepath}:${chunkIndex}`;

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(key, { resolve, reject });
			this.send({
				type: 'get_chunk',
				file: filepath,
				index: chunkIndex,
				chunk_size: this.CHUNK_SIZE
			});

			// Timeout
			setTimeout(() => {
				if (this.pendingRequests.has(key)) {
					this.pendingRequests.delete(key);
					reject(new Error('Timeout fetching chunk'));
				}
			}, 30000);
		});
	},

	/**
	 * Read data from a file at a specific offset
	 * This is called by Emscripten's FS when the file is read
	 */
	readFileData: async function (filepath, offset, length) {
		const fileEntry = this.files.get(filepath);
		if (!fileEntry) {
			console.error('[LazyFS] File not registered:', filepath);
			return null;
		}

		// Initialize DB if needed
		if (!this.dbReady && !this.dbInitPromise) {
			await this.initDB();
		} else if (this.dbInitPromise) {
			await this.dbInitPromise;
		}

		// Fetch file size if not already known
		if (fileEntry.size === null) {
			try {
				fileEntry.size = await this.getFileSize(filepath);
				if (fileEntry.size < 0) {
					console.error('[LazyFS] File not found:', filepath);
					return null;
				}
				console.log('[LazyFS] File size:', filepath, fileEntry.size, 'bytes');
			} catch (e) {
				console.error('[LazyFS] Failed to get file size:', e);
				return null;
			}
		}

		// Calculate which chunks we need — HTTP and WS modes use different chunk sizes
		const chunkSize = this.getChunkSize();
		const startChunk = Math.floor(offset / chunkSize);
		const endChunk = Math.floor((offset + length - 1) / chunkSize);

		// Identify chunks that need fetching
		let needsFetch = false;
		let missingStart = -1;
		let missingEnd = -1;
		const batches = []; // Array of {start, end}

		for (let chunkIdx = startChunk; chunkIdx <= endChunk; chunkIdx++) {
			const versionTag = this.getFileVersionTag(fileEntry);
			const cacheKey = this.getChunkCacheKey(filepath, versionTag, chunkIdx);

			// Check memory cache first
			if (this.chunkCache.has(cacheKey)) {
				this.logFetch(filepath, chunkIdx, chunkSize, true); // Log cache hit

				// End current missing range if any
				if (missingStart !== -1) {
					batches.push({ start: missingStart, end: missingEnd });
					missingStart = -1;
					missingEnd = -1;
				}
				continue;
			}

			// Check IndexedDB
			const cachedData = await this.getCachedChunk(filepath, versionTag, chunkIdx);
			if (cachedData) {
				// Success! Load to memory
				this.chunkCache.set(cacheKey, cachedData);
				this.logFetch(filepath, chunkIdx, cachedData.length, true); // Log cache hit

				// End current missing range
				if (missingStart !== -1) {
					batches.push({ start: missingStart, end: missingEnd });
					missingStart = -1;
					missingEnd = -1;
				}
				continue;
			}

			// Not in any cache - needs fetch
			if (missingStart === -1) {
				missingStart = chunkIdx;
				missingEnd = chunkIdx;
			} else {
				missingEnd = chunkIdx;
			}
			needsFetch = true;
		}

		// Push final batch if open
		if (missingStart !== -1) {
			batches.push({ start: missingStart, end: missingEnd });
		}

		// Fetch missing batches
		if (needsFetch) {
			try {
				// Fetch all batches in parallel
				await Promise.all(batches.map(batch =>
					this.fetchChunks(filepath, batch.start, batch.end)
				));
			} catch (e) {
				console.error('[LazyFS] Failed to fetch chunks:', e);
				return null;
			}
		}

		// Buffer for result
		const result = new Uint8Array(length);
		let resultOffset = 0;

		// Assemble from cached chunks
		for (let chunkIdx = startChunk; chunkIdx <= endChunk; chunkIdx++) {
			const versionTag = this.getFileVersionTag(fileEntry);
			const cacheKey = this.getChunkCacheKey(filepath, versionTag, chunkIdx);
			const chunk = this.chunkCache.get(cacheKey);

			if (!chunk) {
				console.error('[LazyFS] Chunk not in cache after fetch:', cacheKey);
				return null;
			}

			const chunkStart = chunkIdx * chunkSize;

			// Calculate what part of this chunk we need. Clamp by `chunkSize` so stale
			// cache entries that happen to be larger (e.g. from a previous build with a
			// bigger chunk) can't spill data meant for later chunks.
			const chunkEnd = Math.min(chunk.length, chunkSize);
			const readStart = Math.max(0, offset - chunkStart);
			const readEnd = Math.min(chunkEnd, offset + length - chunkStart);
			const readLength = readEnd - readStart;

			// Copy only the needed bytes
			result.set(chunk.subarray(readStart, readEnd), resultOffset);
			resultOffset += readLength;
		}

		return result;
	}
};

// Expose LazyFS on Module (will be merged when Module is created)
if (typeof Module === 'undefined') {
	Module = {};
}
// Merge existing configuration if it was defined in index.html before this script loaded
if (Module.LazyFS) {
	Object.assign(LazyFS, Module.LazyFS);
}
Module.LazyFS = LazyFS;

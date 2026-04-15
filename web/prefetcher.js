/**
 * Prefetcher — downloads NX files (or heads of them) into the same IndexedDB
 * cache that LazyFS will later read from. Runs before the WASM client loads so
 * registerFile/readFileData calls hit the cache instantly.
 *
 * Must stay in lockstep with src/client/LazyFS/lazyfs.js on:
 *   - DB_NAME, DB_VERSION, STORE_NAME
 *   - chunk size (HTTP_CHUNK_SIZE)
 *   - cache key scheme: `${filename}:v${etag}:c${chunkSize}:${chunkIndex}`
 */
(function () {
    const DB_NAME = 'LazyFS_Cache';
    const DB_VERSION = 1;
    const STORE_NAME = 'chunks';
    const CHUNK_SIZE = 2097152; // 2 MiB — must equal LazyFS HTTP_CHUNK_SIZE

    // file -> either "full" (download entire file) or { first: bytes }
    const PREFETCH_PLAN = {
        'Base.nx':      'full',
        'String.nx':    'full',
        'Etc.nx':       'full',
        'Quest.nx':     'full',
        'Morph.nx':     'full',
        'TamingMob.nx': 'full',
        'Item.nx':      { first: 5 * 1024 * 1024 },
        'Reactor.nx':   { first: 5 * 1024 * 1024 },
        'Skill.nx':     { first: 5 * 1024 * 1024 },
        'Effect.nx':    { first: 5 * 1024 * 1024 },
        'Npc.nx':       { first: 5 * 1024 * 1024 },
        'Character.nx': { first: 10 * 1024 * 1024 },
        'Sound.nx':     { first: 2 * 1024 * 1024 },
        'UI.nx':        { first: 20 * 1024 * 1024 },
        'Map.nx':       { first: 2 * 1024 * 1024 },
        'Mob.nx':       { first: 2 * 1024 * 1024 },
    };

    function cacheKey(filename, etag, chunkIdx) {
        return `${filename}:v${etag}:c${CHUNK_SIZE}:${chunkIdx}`;
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function hasChunk(db, key) {
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const r = tx.objectStore(STORE_NAME).getKey(key);
            r.onsuccess = () => resolve(!!r.result);
            r.onerror = () => resolve(false);
        });
    }

    function putChunk(db, key, data) {
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(data, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    }

    async function headFile(baseUrl, filename) {
        const res = await fetch(`${baseUrl}/${filename}`, { method: 'HEAD' });
        if (!res.ok) throw new Error(`HEAD ${filename} -> ${res.status}`);
        const size = parseInt(res.headers.get('content-length') || '0', 10);
        const etag = (res.headers.get('etag') || '').replace(/"/g, '');
        const lastModified = res.headers.get('last-modified');
        const version = etag || (lastModified ? Date.parse(lastModified).toString() : String(size));
        return { size, version };
    }

    async function rangeFetch(baseUrl, filename, start, end) {
        const res = await fetch(`${baseUrl}/${filename}`, {
            headers: { 'Range': `bytes=${start}-${end}` },
        });
        if (!res.ok && res.status !== 206) {
            throw new Error(`GET ${filename} bytes=${start}-${end} -> ${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
    }

    /**
     * Download the requested byte range for a file and split it into 2 MiB chunks
     * aligned at CHUNK_SIZE boundaries, writing each to IndexedDB under the same
     * key LazyFS uses. Chunk 0 of a file always starts at file offset 0.
     */
    async function prefetchFile(db, baseUrl, filename, plan, onBytes) {
        const info = await headFile(baseUrl, filename);
        const bytesNeeded = plan === 'full' ? info.size : Math.min(plan.first, info.size);
        if (bytesNeeded <= 0) return { skipped: true, size: 0 };

        // Chunk-aligned range: download whole chunks so cache keys line up.
        const startByte = 0;
        const endChunk = Math.floor((bytesNeeded - 1) / CHUNK_SIZE);
        const endByte = Math.min((endChunk + 1) * CHUNK_SIZE, info.size) - 1;
        const totalBytes = endByte - startByte + 1;

        // Skip chunks already in IDB from a previous visit.
        const missing = [];
        for (let idx = 0; idx <= endChunk; idx++) {
            const key = cacheKey(filename, info.version, idx);
            if (!(await hasChunk(db, key))) missing.push(idx);
        }
        if (missing.length === 0) {
            onBytes(totalBytes); // count as satisfied for progress
            return { skipped: false, size: totalBytes, cached: true };
        }

        // Download missing chunks. Fetch contiguous runs in a single Range to cut overhead.
        let runStart = -1, runEnd = -1;
        const runs = [];
        for (const idx of missing) {
            if (runStart === -1) { runStart = idx; runEnd = idx; }
            else if (idx === runEnd + 1) { runEnd = idx; }
            else { runs.push([runStart, runEnd]); runStart = idx; runEnd = idx; }
        }
        if (runStart !== -1) runs.push([runStart, runEnd]);

        for (const [a, b] of runs) {
            const byteA = a * CHUNK_SIZE;
            const byteB = Math.min((b + 1) * CHUNK_SIZE, info.size) - 1;
            const buf = await rangeFetch(baseUrl, filename, byteA, byteB);
            let off = 0;
            for (let idx = a; idx <= b; idx++) {
                const remaining = buf.length - off;
                if (remaining <= 0) break;
                const len = Math.min(CHUNK_SIZE, remaining);
                const data = buf.slice(off, off + len);
                off += len;
                await putChunk(db, cacheKey(filename, info.version, idx), data);
                onBytes(data.length);
            }
        }
        return { skipped: false, size: totalBytes, cached: false };
    }

    /**
     * Runs prefetch for every file in PREFETCH_PLAN in parallel (bounded).
     * Calls opts.onProgress({ loadedBytes, totalBytes, file }) as data arrives.
     */
    async function prefetchAll({ baseUrl, onProgress }) {
        const db = await openDb();

        // Compute total bytes by HEADing every file first.
        const entries = Object.entries(PREFETCH_PLAN);
        const sized = await Promise.all(entries.map(async ([filename, plan]) => {
            const info = await headFile(baseUrl, filename);
            const need = plan === 'full' ? info.size : Math.min(plan.first, info.size);
            const endChunk = Math.floor((need - 1) / CHUNK_SIZE);
            const totalForFile = Math.min((endChunk + 1) * CHUNK_SIZE, info.size);
            return { filename, plan, totalForFile };
        }));
        const totalBytes = sized.reduce((a, s) => a + s.totalForFile, 0);
        let loadedBytes = 0;

        onProgress({ loadedBytes: 0, totalBytes, file: null, phase: 'starting' });

        // Run with bounded concurrency to avoid spraying connections.
        const CONCURRENCY = 4;
        let cursor = 0;
        async function worker() {
            while (cursor < sized.length) {
                const mine = sized[cursor++];
                await prefetchFile(db, baseUrl, mine.filename, mine.plan, (bytes) => {
                    loadedBytes += bytes;
                    onProgress({ loadedBytes, totalBytes, file: mine.filename, phase: 'downloading' });
                });
            }
        }
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        onProgress({ loadedBytes, totalBytes, file: null, phase: 'done' });
    }

    /**
     * Full-file background prefill. After the blocking foreground prefetch finishes
     * and the game is playable, this runs silently to download every remaining chunk
     * of every registered NX file. Uses low concurrency so it doesn't compete with
     * on-demand reads the game makes during play.
     */
    async function prefetchBackground({ baseUrl, files, onProgress, concurrency = 2, delayMs = 5000 }) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        const db = await openDb();

        // HEAD every file first to know total byte count.
        const infos = await Promise.all(files.map(async (filename) => {
            try {
                const info = await headFile(baseUrl, filename);
                return { filename, ...info };
            } catch (e) {
                console.warn('[prefill] HEAD failed:', filename, e.message);
                return null;
            }
        }));
        const valid = infos.filter(Boolean);
        const totalBytes = valid.reduce((a, f) => a + f.size, 0);

        // Figure out per-file missing chunks.
        const jobs = [];
        for (const f of valid) {
            const lastChunk = Math.floor((f.size - 1) / CHUNK_SIZE);
            const missing = [];
            for (let idx = 0; idx <= lastChunk; idx++) {
                const key = cacheKey(f.filename, f.version, idx);
                if (!(await hasChunk(db, key))) missing.push(idx);
            }
            if (missing.length > 0) jobs.push({ file: f, missing });
        }

        let loadedBytes = valid.reduce((a, f) => {
            // Account for chunks already cached as "loaded" for the progress bar.
            const lastChunk = Math.floor((f.size - 1) / CHUNK_SIZE);
            const totalChunks = lastChunk + 1;
            const job = jobs.find((j) => j.file.filename === f.filename);
            const missingCount = job ? job.missing.length : 0;
            const cachedChunks = totalChunks - missingCount;
            // Approximation: cached chunks contribute chunkSize bytes, last cached chunk may be partial.
            return a + Math.min(cachedChunks * CHUNK_SIZE, f.size);
        }, 0);
        onProgress({ loadedBytes, totalBytes, file: null, phase: 'starting' });

        // Flatten missing chunks into individual fetch jobs grouped by contiguous run.
        const chunkJobs = [];
        for (const { file, missing } of jobs) {
            let runStart = -1, runEnd = -1;
            for (const idx of missing) {
                if (runStart === -1) { runStart = idx; runEnd = idx; }
                else if (idx === runEnd + 1) { runEnd = idx; }
                else { chunkJobs.push({ file, a: runStart, b: runEnd }); runStart = idx; runEnd = idx; }
            }
            if (runStart !== -1) chunkJobs.push({ file, a: runStart, b: runEnd });
        }

        // Consume jobs with bounded concurrency.
        let cursor = 0;
        async function worker() {
            while (cursor < chunkJobs.length) {
                const { file, a, b } = chunkJobs[cursor++];
                const byteA = a * CHUNK_SIZE;
                const byteB = Math.min((b + 1) * CHUNK_SIZE, file.size) - 1;
                try {
                    const buf = await rangeFetch(baseUrl, file.filename, byteA, byteB);
                    let off = 0;
                    for (let idx = a; idx <= b; idx++) {
                        const remaining = buf.length - off;
                        if (remaining <= 0) break;
                        const len = Math.min(CHUNK_SIZE, remaining);
                        const data = buf.slice(off, off + len);
                        off += len;
                        await putChunk(db, cacheKey(file.filename, file.version, idx), data);
                        loadedBytes += data.length;
                        onProgress({ loadedBytes, totalBytes, file: file.filename, phase: 'downloading' });
                    }
                } catch (e) {
                    console.warn('[prefill] chunk run failed:', file.filename, a, b, e.message);
                }
            }
        }
        await Promise.all(Array.from({ length: concurrency }, worker));
        onProgress({ loadedBytes, totalBytes, file: null, phase: 'done' });
    }

    window.AugurPrefetch = { prefetchAll, prefetchBackground };
})();

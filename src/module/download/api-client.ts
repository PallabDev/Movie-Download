/**
 * API Client for dl.pallabdev.in
 * Search and resolve 10Gbps CDN download links for movies and TV series
 */

export const DL_API_BASE_URL = process.env.DL_API_BASE_URL || "http://localhost:8000";

export interface SearchResultItem {
    name: string;
    url: string;
    thumbnail?: string;
    category?: string[];
    director?: string[];
    stars?: string[];
    imdb_id?: string;
    post_date?: string;
    source?: string;
    sourceType?: string;
    source_type?: string;
    qualityTags?: string[];
    quality_tags?: string[];
    score?: number;
}

export interface ScraperSourceConfig {
    name: string;
    type: string;
    baseUrl: string;
    enabled: boolean;
    priority?: number;
    headers?: Record<string, string>;
}

export interface DownloadServer {
    server_name: string;
    server_type: string;
    download_url: string;
    file_size?: string;
}

export interface DownloadDetails {
    name: string;
    url: string;
    thumbnail?: string;
    synopsis?: string;
    category?: string[];
    screenshots?: string[];
    downloads: Record<string, DownloadServer[]>;
}

export interface SelectedQualityResult {
    qualityKey: string;
    isBatchPack: boolean;
    isEpisodeList: boolean;
    servers: DownloadServer[];
    episodes?: { episodeKey: string; episodeNum: number; servers: DownloadServer[] }[];
    fileSize?: string;
    title: string;
}

/**
 * Tests connectivity and latency to a scraper source mirror
 */
export async function testScraperSource(url: string, sourceType = "hdhub4u"): Promise<{
    success: boolean;
    status: string;
    latency_ms: number;
    message?: string;
    resolved_mirror?: string;
}> {
    try {
        const endpoint = `${DL_API_BASE_URL}/api/sources/test`;
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ url, source_type: sourceType }),
            signal: AbortSignal.timeout(15000)
        });
        if (res.ok) {
            return await res.json();
        }
        return { success: false, status: "error", latency_ms: 0, message: `Scraper test returned status ${res.status}` };
    } catch (err: any) {
        return { success: false, status: "offline", latency_ms: 0, message: err.message || "Connection timed out" };
    }
}

/**
 * Searches across all enabled scraper sources (HDHub4u, Modlist, Vegamovies, etc.) with auto-retry
 */
export async function searchMedia(query: string, sources?: ScraperSourceConfig[], maxRetries = 2): Promise<SearchResultItem[]> {
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) return [];

    // 1. If multi-sources provided, attempt POST /api/scrape/multi-search first
    if (sources && Array.isArray(sources) && sources.length > 0) {
        const multiUrl = `${DL_API_BASE_URL}/api/scrape/multi-search`;
        console.log(`[DL-API] Multi-Source Searching (${sources.length} sources): "${cleanQuery}"`);

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                const res = await fetch(multiUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    },
                    body: JSON.stringify({
                        query: cleanQuery,
                        sources: sources.map(s => ({
                            name: s.name,
                            type: s.type,
                            base_url: s.baseUrl,
                            enabled: s.enabled
                        }))
                    }),
                    signal: AbortSignal.timeout(35000)
                });

                if (res.ok) {
                    const data = await res.json();
                    const list = Array.isArray(data) ? data : (Array.isArray(data?.results) ? data.results : []);
                    if (list.length > 0) {
                        return list.map((r: any) => ({
                            ...r,
                            source: r.source || "HDHub4u",
                            sourceType: r.source_type || r.sourceType || "hdhub4u",
                            qualityTags: r.quality_tags || r.qualityTags || []
                        }));
                    }
                }
            } catch (err: any) {
                if (attempt <= maxRetries) {
                    console.warn(`[DL-API] Multi-search attempt ${attempt} failed (${err.message}). Retrying in 1.5s...`);
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        }
    }

    // 2. Fallback to standard GET /search?param=...
    const url = `${DL_API_BASE_URL}/search?param=${encodeURIComponent(cleanQuery)}`;
    console.log(`[DL-API] Searching standard: ${url}`);

    let lastError: any = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            const res = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "application/json"
                },
                signal: AbortSignal.timeout(35000)
            });

            if (!res.ok) {
                throw new Error(`Search API returned status ${res.status}: ${res.statusText}`);
            }

            const data = await res.json();
            if (!Array.isArray(data)) {
                return [];
            }

            return data.map((r: any) => ({
                ...r,
                source: r.source || "HDHub4u",
                sourceType: r.source_type || r.sourceType || "hdhub4u",
                qualityTags: r.quality_tags || r.qualityTags || []
            }));
        } catch (err: any) {
            lastError = err;
            if (attempt <= maxRetries) {
                console.warn(`[DL-API] Search attempt ${attempt} failed (${err.message}). Retrying in 1.5s...`);
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }

    throw lastError || new Error(`Search failed for query "${cleanQuery}"`);
}

// In-memory cache for resolved download links (10 min TTL)
const downloadLinksCache = new Map<string, { data: DownloadDetails; timestamp: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Extracts direct download links for a specific movie or series permalink URL with auto-retry
 */
export async function getDownloadLinks(targetUrl: string, bypassCache = false, maxRetries = 2): Promise<DownloadDetails> {
    if (!targetUrl) throw new Error("Target URL is required to fetch download links");

    const cacheKey = targetUrl.trim();
    if (!bypassCache) {
        const cached = downloadLinksCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            console.log(`[DL-API] Returning cached download links for: ${cacheKey}`);
            return cached.data;
        }
    }

    const url = `${DL_API_BASE_URL}/download?param=${encodeURIComponent(targetUrl)}`;
    console.log(`[DL-API] Resolving download links: ${url}`);

    let lastError: any = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            const res = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "application/json"
                },
                signal: AbortSignal.timeout(120000)
            });

            if (!res.ok) {
                throw new Error(`Download API returned status ${res.status}: ${res.statusText}`);
            }

            const data: DownloadDetails = await res.json();
            if (data && data.downloads && Object.keys(data.downloads).length > 0) {
                downloadLinksCache.set(cacheKey, { data, timestamp: Date.now() });
            }
            return data;
        } catch (err: any) {
            lastError = err;
            if (attempt <= maxRetries) {
                console.warn(`[DL-API] Download resolution attempt ${attempt} failed (${err.message}). Retrying in 2s...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }

    throw lastError || new Error(`Download link resolution failed for "${targetUrl}"`);
}

/**
 * Resolves ONLY the specific format or video link selected by the user,
 * avoiding slow full-page scraping of 20+ other qualities/episodes.
 */
export async function resolveSpecificFormatLink(
    targetUrl: string,
    qualityKey?: string,
    linkUrl?: string
): Promise<{ name: string; servers: DownloadServer[]; fileSize?: string }> {
    if (!targetUrl && !linkUrl) {
        throw new Error("Target URL or Link URL is required to resolve download links");
    }

    // 1. Instant Cache Check: If full movie details were recently resolved during search/chat, reuse them in 0ms
    const cacheKey = targetUrl?.trim();
    if (cacheKey) {
        const cached = downloadLinksCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS && cached.data?.downloads) {
            let cachedServers: DownloadServer[] = [];
            if (qualityKey && cached.data.downloads[qualityKey]?.length > 0) {
                cachedServers = cached.data.downloads[qualityKey];
            } else if (linkUrl) {
                for (const srvs of Object.values(cached.data.downloads)) {
                    const match = srvs.find(s => s.download_url === linkUrl);
                    if (match) { cachedServers = srvs; break; }
                }
            }

            if (cachedServers.length > 0) {
                console.log(`[DL-API] Instantly returning cached format servers for: ${cacheKey}`);
                let sSize = "";
                for (const s of cachedServers) {
                    const sz = cleanFileSize(s.file_size || "") || cleanFileSize(s.server_name || "");
                    if (sz) { sSize = sz; break; }
                }
                return {
                    name: cached.data.name || "Media File",
                    servers: sortServersByPriority(cachedServers),
                    fileSize: sSize || cachedServers[0]?.file_size || ""
                };
            }
        }
    }

    // 2. Direct CDN Link Check: If linkUrl is already a final direct download CDN stream (0ms)
    if (linkUrl && /video-downloads\.googleusercontent\.com|pixeldrain\.com|r2\.cloudflarestorage\.com|workers\.dev|r2\.dev|pub-/i.test(linkUrl)) {
        console.log(`[DL-API] Link URL is already a direct CDN download stream`);
        return {
            name: "Direct Download File",
            servers: [{
                server_name: "Download [Server : 10Gbps]",
                server_type: "⚡ Server : 10Gbps High Speed (Google CDN)",
                download_url: linkUrl,
                file_size: ""
            }]
        };
    }

    // 3. If direct intermediate linkUrl is provided, resolve directly via /api/resolve (1.5s)
    if (linkUrl && /hubcloud|hubdrive|hblinks|greenmount|greenmotors|unblockedgames|leechpro|modpro|links\.|techmny|fastdl|fast-dl|vcloud|hubcdn|drive/i.test(linkUrl)) {
        const resolveUrl = `${DL_API_BASE_URL}/api/resolve?url=${encodeURIComponent(linkUrl)}`;
        console.log(`[DL-API] Fast single-link resolution: ${resolveUrl}`);
        try {
            const res = await fetch(resolveUrl, {
                headers: { "Accept": "application/json" },
                signal: AbortSignal.timeout(15000)
            });
            if (res.ok) {
                const data: any = await res.json();
                const rawServers: DownloadServer[] = data.final_downloads || [];
                const servers = sortServersByPriority(rawServers);
                if (servers.length > 0) {
                    let sSize = "";
                    for (const s of servers) {
                        const sz = cleanFileSize(s.file_size || "") || cleanFileSize(s.server_name || "");
                        if (sz) { sSize = sz; break; }
                    }
                    return {
                        name: data.filename || "Direct Download File",
                        servers,
                        fileSize: sSize || data.file_size || ""
                    };
                }
            }
        } catch (e: any) {
            console.warn(`[DL-API] Direct resolve fallback: ${e.message}`);
        }
    }

    // 4. Targeted query via /download?param=...&quality_key=... (3s)
    const params = new URLSearchParams();
    if (targetUrl) params.set("param", targetUrl);
    if (qualityKey) params.set("quality_key", qualityKey);
    // Only pass link_url if it's an intermediate redirect URL, avoid confusing scraper with final URLs
    if (linkUrl && /hubcloud|hubdrive|hblinks|greenmount|greenmotors|unblockedgames|leechpro|modpro|links\.|techmny|fastdl|fast-dl|vcloud|hubcdn|drive/i.test(linkUrl)) {
        params.set("link_url", linkUrl);
    }

    const targetEndpoint = `${DL_API_BASE_URL}/download?${params.toString()}`;
    console.log(`[DL-API] Targeted format resolution: ${targetEndpoint}`);

    const res = await fetch(targetEndpoint, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json"
        },
        signal: AbortSignal.timeout(25000)
    });

    if (!res.ok) {
        throw new Error(`Download API returned status ${res.status}: ${res.statusText}`);
    }

    const data: any = await res.json();
    let servers: DownloadServer[] = [];
    let detectedSize = "";

    if (data.downloads) {
        if (qualityKey && data.downloads[qualityKey]) {
            servers = data.downloads[qualityKey];
        } else {
            // Find in any returned key
            const keys = Object.keys(data.downloads);
            if (keys.length > 0) {
                servers = data.downloads[keys[0]];
            }
        }
    } else if (data.final_downloads) {
        servers = data.final_downloads;
    }

    const sortedServers = sortServersByPriority(servers);
    if (sortedServers.length === 0) {
        throw new Error("This download link is currently unavailable or has expired on the upstream server. Please try selecting another quality or release.");
    }

    for (const s of sortedServers) {
        const sSize = cleanFileSize(s.file_size || "") || cleanFileSize(s.server_name || "");
        if (sSize) {
            detectedSize = sSize;
            break;
        }
    }

    return {
        name: data.name || data.filename || "Download",
        servers: sortedServers,
        fileSize: detectedSize || data.file_size || ""
    };
}

/**
 * Normalizes direct streamable URLs (e.g. Pixeldrain /u/ID -> /api/file/ID)
 */
export function normalizeDirectStreamUrl(url: string): string {
    if (!url) return url;
    // Convert pixeldrain /u/ID to direct streamable API endpoint /api/file/ID
    const pdMatch = url.match(/pixeldrain\.(?:dev|com)\/u\/([a-zA-Z0-9_-]+)/i);
    if (pdMatch) {
        return `https://pixeldrain.com/api/file/${pdMatch[1]}`;
    }
    return url;
}

/**
 * Sorts server list by speed and reliability priority:
 * 1. Google 10Gbps Video CDN (*.googleusercontent.com, *.googleapis.com)
 * 2. Cloudflare R2 / Workers CDN (*.r2.cloudflarestorage.com, *.r2.dev, *.workers.dev)
 * 3. Fast direct CDNs (cdn.cocktail.beer, cdn.bunker.monster, cdn.pongala.life)
 * 4. Pixeldrain (pixeldrain.com/api/file)
 * 5. Other Direct Servers
 */
export function sortServersByPriority(servers: DownloadServer[]): DownloadServer[] {
    if (!servers || !Array.isArray(servers)) return [];

    const scored = servers.map(srv => {
        let score = 0;
        const name = (srv.server_name || "").toLowerCase();
        const type = (srv.server_type || "").toLowerCase();
        const url = (srv.download_url || "").toLowerCase();

        if (url.includes("googleusercontent.com") || url.includes("googleapis.com")) score += 120;
        if (url.includes("r2.cloudflarestorage.com") || url.includes("r2.dev") || url.includes("workers.dev")) score += 110;
        if (url.includes("cdn.cocktail.beer") || url.includes("cdn.bunker.monster") || url.includes("cdn.pongala.life")) score += 90;
        if (name.includes("fsl") || type.includes("fast cdn")) score += 80;
        if (name.includes("10gbps") || type.includes("10gbps")) score += 75;
        if (url.includes("pixeldrain")) score += 60;
        if (url.includes("hubcdn") || url.includes("fuckingfast")) score += 40;
        if (url.includes("hubcloud")) score += 30;
        if (url.includes("hubdrive")) score += 10;

        return { srv, score };
    });

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    // Deduplicate normalized URLs
    const seen = new Set<string>();
    const result: DownloadServer[] = [];

    for (const item of scored) {
        const directUrl = normalizeDirectStreamUrl(item.srv.download_url);
        if (directUrl && !seen.has(directUrl)) {
            seen.add(directUrl);
            result.push({
                ...item.srv,
                download_url: directUrl
            });
        }
    }

    return result;
}

/**
 * Autonomously selects the best 720p quality download option
 * - For TV Series: Prefers 720p batch pack, else all 720p individual episodes
 * - For Movies: Prefers format_720p_h264 / format_720p_hevc / 720p
 */
export function selectBest720pQuality(details: DownloadDetails): SelectedQualityResult | null {
    if (!details || !details.downloads) return null;

    const downloadKeys = Object.keys(details.downloads);
    if (downloadKeys.length === 0) return null;

    // Check if it's a TV Series (has batch_season_pack or episode_ keys)
    const isSeries = downloadKeys.some(k => k.startsWith("batch_") || k.startsWith("episode_") || k.startsWith("bonus_"));

    if (isSeries) {
        // 1. Try to find a 720p HEVC Batch Season Pack first (1.8GB compact direct file), then standard 720p Batch Pack
        const batch720Key = downloadKeys.find(k => k.startsWith("batch_") && (k.includes("720p_hevc") || k.includes("720p_x265")))
            || downloadKeys.find(k => k.startsWith("batch_") && k.includes("720p"));

        if (batch720Key && details.downloads[batch720Key]?.length > 0) {
            const servers = sortServersByPriority(details.downloads[batch720Key]);
            const fileSize = servers[0]?.file_size || details.downloads[batch720Key][0]?.file_size;
            return {
                qualityKey: batch720Key,
                isBatchPack: true,
                isEpisodeList: false,
                servers,
                fileSize,
                title: details.name
            };
        }

        // 2. Try any other Batch Season Pack if 720p not available (1080p, 480p, 4k)
        const anyBatchKey = downloadKeys.find(k => k.startsWith("batch_") && (k.includes("1080p") || k.includes("480p") || k.includes("4k")));
        if (anyBatchKey && details.downloads[anyBatchKey]?.length > 0) {
            const servers = sortServersByPriority(details.downloads[anyBatchKey]);
            const fileSize = servers[0]?.file_size || details.downloads[anyBatchKey][0]?.file_size;
            return {
                qualityKey: anyBatchKey,
                isBatchPack: true,
                isEpisodeList: false,
                servers,
                fileSize,
                title: details.name
            };
        }

        // 3. Extract all 720p episodes chronologically (deduplicate by episode number)
        const ep720Keys = downloadKeys.filter(k => k.startsWith("episode_") && k.includes("720p"));
        if (ep720Keys.length > 0) {
            const epMap = new Map<number, { key: string; servers: DownloadServer[] }>();
            for (const k of ep720Keys) {
                const epNum = parseInt((k.match(/\d+/) || ["1"])[0], 10);
                const current = epMap.get(epNum);
                const srvs = sortServersByPriority(details.downloads[k]);
                if (!current) {
                    epMap.set(epNum, { key: k, servers: srvs });
                } else {
                    // Combine unique servers
                    const existingUrls = new Set(current.servers.map(s => s.download_url));
                    for (const s of srvs) {
                        if (!existingUrls.has(s.download_url)) {
                            current.servers.push(s);
                            existingUrls.add(s.download_url);
                        }
                    }
                }
            }

            const sortedEpNums = Array.from(epMap.keys()).sort((a, b) => a - b);
            const episodes = sortedEpNums.map(num => {
                const item = epMap.get(num)!;
                return {
                    episodeKey: item.key,
                    episodeNum: num,
                    servers: sortServersByPriority(item.servers)
                };
            });

            return {
                qualityKey: "episodes_720p",
                isBatchPack: false,
                isEpisodeList: true,
                servers: episodes[0]?.servers || [],
                episodes,
                title: details.name
            };
        }

        // 4. Fallback: all episodes of any quality available
        const allEpKeys = downloadKeys.filter(k => k.startsWith("episode_"));
        if (allEpKeys.length > 0) {
            // Group by episode number, preferring 1080p over 480p
            const epMap = new Map<number, { key: string; servers: DownloadServer[] }>();
            for (const k of allEpKeys) {
                const epNum = parseInt((k.match(/\d+/) || ["1"])[0], 10);
                const current = epMap.get(epNum);
                if (!current || k.includes("1080p")) {
                    epMap.set(epNum, { key: k, servers: sortServersByPriority(details.downloads[k]) });
                }
            }

            const sortedEpNums = Array.from(epMap.keys()).sort((a, b) => a - b);
            const episodes = sortedEpNums.map(num => {
                const item = epMap.get(num)!;
                return {
                    episodeKey: item.key,
                    episodeNum: num,
                    servers: item.servers
                };
            });

            return {
                qualityKey: "episodes_all",
                isBatchPack: false,
                isEpisodeList: true,
                servers: episodes[0]?.servers || [],
                episodes,
                title: details.name
            };
        }
    }

    // Movie Handling: Look for 720p keys
    // Priority: format_720p_hevc > format_720p_h264 > 720p > format_1080p_hevc > format_1080p_h264 > 480p
    const preferredMovieKeys = [
        downloadKeys.find(k => k.includes("720p") && (k.includes("hevc") || k.includes("x265"))),
        downloadKeys.find(k => k.includes("720p") && (k.includes("h264") || k.includes("x264") || !k.includes("hevc"))),
        downloadKeys.find(k => k.includes("720p")),
        downloadKeys.find(k => k.includes("1080p") && (k.includes("hevc") || k.includes("x265"))),
        downloadKeys.find(k => k.includes("1080p")),
        downloadKeys.find(k => k.includes("480p")),
        downloadKeys[0]
    ].filter(Boolean) as string[];

    const chosenKey = preferredMovieKeys[0];
    if (chosenKey && details.downloads[chosenKey]?.length > 0) {
        const servers = sortServersByPriority(details.downloads[chosenKey]);
        const fileSize = servers[0]?.file_size || details.downloads[chosenKey][0]?.file_size;
        return {
            qualityKey: chosenKey,
            isBatchPack: false,
            isEpisodeList: false,
            servers,
            fileSize,
            title: details.name
        };
    }

    return null;
}

export interface ParsedMovieFormat {
    qualityKey: string;
    label: string;
    resolution: string;
    fileSize: string;
    isRecommended: boolean;
    serverCount: number;
    linkUrl?: string;
}

export interface ParsedSeriesBatch {
    qualityKey: string;
    label: string;
    resolution: string;
    fileSize: string;
    isRecommended: boolean;
    serverCount: number;
    linkUrl?: string;
}

export interface ParsedSeriesEpisodeQuality {
    qualityKey: string;
    label: string;
    resolution: string;
    fileSize: string;
    serverCount: number;
    linkUrl?: string;
}

export interface ParsedSeriesEpisode {
    episodeNum: number;
    title: string;
    qualities: ParsedSeriesEpisodeQuality[];
}

export interface ParsedMediaDetails {
    name: string;
    url: string;
    thumbnail?: string;
    synopsis?: string;
    category?: string[];
    isSeries: boolean;
    source?: string;
    movieFormats?: ParsedMovieFormat[];
    seriesBatches?: ParsedSeriesBatch[];
    seriesEpisodes?: ParsedSeriesEpisode[];
}

/**
 * Parses all download keys into structured movie formats or series batch/episode collections
 */
export function cleanFileSize(rawSize: string): string {
    if (!rawSize) return "";

    // Bracketed file size like [2.57 GB] (ignoring speed tags like [10Gbps])
    const bracketMatch = rawSize.match(/\[\s*([\d\.]+\s*(?:GB|MB|KB))(?!\s*ps)\s*\]/i);
    if (bracketMatch) return bracketMatch[1].toUpperCase();

    const cleanMatch = rawSize.trim().match(/^([\d\.]+\s*(?:GB|MB|KB))(?!\s*ps)$/i);
    if (cleanMatch) return cleanMatch[1].toUpperCase();

    // Look for file size prefixes like "file size: 1.2 GB" or standalone "1.2 GB" not followed by ps
    const sizeMatch = rawSize.match(/(?:file\s*size:?\s*|size:?\s*)([\d\.]+\s*(?:gb|mb|kb))(?!\s*ps)\b/i)
        || rawSize.match(/(?:^|[^\w])([\d\.]+\s*(?:gb|mb|kb))(?!\s*ps)\b/i);
    if (sizeMatch) return sizeMatch[1].toUpperCase();

    return "";
}

/**
 * Parses all download keys into structured movie formats or series batch/episode collections
 */
export function parseAvailableMediaFormats(details: DownloadDetails): ParsedMediaDetails | null {
    if (!details || !details.downloads) return null;
    const downloadKeys = Object.keys(details.downloads);
    if (downloadKeys.length === 0) return null;

    const isSeries = downloadKeys.some(k => k.startsWith("batch_") || k.startsWith("episode_") || k.startsWith("bonus_"));

    if (isSeries) {
        // Parse batches
        const batchKeys = downloadKeys.filter(k => k.startsWith("batch_"));
        const seriesBatches: ParsedSeriesBatch[] = batchKeys.map(k => {
            const srvs = details.downloads[k] || [];
            let fileSize = "";
            for (const s of srvs) {
                const sSize = cleanFileSize(s.file_size || "") || cleanFileSize(s.server_name || "");
                if (sSize) {
                    fileSize = sSize;
                    break;
                }
            }
            let res = "720p";
            if (k.includes("4k") || k.includes("2160p")) res = "4K";
            else if (k.includes("1080p")) res = "1080p";
            else if (k.includes("480p")) res = "480p";

            let label = k.replace(/^batch_(?:season_pack_)?/, "").replace(/_/g, " ").toUpperCase() + " Batch Pack";
            if (k.includes("720p_hevc") || k.includes("720p_x265")) label = "720p HEVC Season Batch (Compact)";
            else if (k.includes("720p")) label = "720p Season Batch";
            else if (k.includes("1080p_hevc") || k.includes("1080p_x265")) label = "1080p HEVC Season Batch";
            else if (k.includes("1080p")) label = "1080p Full HD Season Batch";
            else if (k.includes("480p")) label = "480p Season Batch";
            else if (k.includes("4k")) label = "4K UHD Season Batch";

            return {
                qualityKey: k,
                label,
                resolution: res,
                fileSize,
                isRecommended: k.includes("720p_hevc") || (k.includes("720p") && !batchKeys.some(b => b.includes("720p_hevc"))),
                serverCount: srvs.length,
                linkUrl: srvs[0]?.download_url || (srvs[0] as any)?.link_url || ""
            };
        });

        // Parse episodes
        const epKeys = downloadKeys.filter(k => k.startsWith("episode_"));
        const epMap = new Map<number, ParsedSeriesEpisodeQuality[]>();
        for (const k of epKeys) {
            const match = k.match(/episode_(\d+)/i);
            const epNum = match ? parseInt(match[1], 10) : 1;
            const srvs = details.downloads[k] || [];
            let fileSize = "";
            for (const s of srvs) {
                const sSize = cleanFileSize(s.file_size || "") || cleanFileSize(s.server_name || "");
                if (sSize) {
                    fileSize = sSize;
                    break;
                }
            }
            if (!fileSize) fileSize = cleanFileSize(k);

            const rawSrvText = srvs[0]?.file_size || "";
            const raw = (k + " " + rawSrvText + " " + (srvs[0]?.download_url || "")).toLowerCase();

            let resolution = "720p";
            let label = "720p HD";

            if (raw.includes("4k") || raw.includes("2160p")) {
                resolution = "4K";
                label = "4K UHD";
            } else if (raw.includes("1080p")) {
                resolution = "1080p";
                label = (raw.includes("hevc") || raw.includes("x265")) ? "1080p HEVC" : "1080p FHD";
            } else if (raw.includes("720p")) {
                resolution = "720p";
                label = (raw.includes("hevc") || raw.includes("x265")) ? "720p HEVC" : "720p HD";
            } else if (raw.includes("480p")) {
                resolution = "480p";
                label = "480p SD";
            }

            if (!epMap.has(epNum)) {
                epMap.set(epNum, []);
            }
            const existing = epMap.get(epNum)!;
            if (!existing.some(q => q.label === label)) {
                existing.push({
                    qualityKey: k,
                    label,
                    resolution,
                    fileSize,
                    serverCount: srvs.length,
                    linkUrl: srvs[0]?.download_url || (srvs[0] as any)?.link_url || ""
                });
            }
        }

        for (const [, quals] of epMap) {
            const qualOrder: Record<string, number> = { "4K": 4, "1080p": 3, "720p": 2, "480p": 1 };
            quals.sort((a, b) => (qualOrder[b.resolution] || 0) - (qualOrder[a.resolution] || 0));
        }

        const sortedEpNums = Array.from(epMap.keys()).sort((a, b) => a - b);
        const seriesEpisodes: ParsedSeriesEpisode[] = sortedEpNums.map(num => ({
            episodeNum: num,
            title: `Episode ${num}`,
            qualities: epMap.get(num)!
        }));

        return {
            name: details.name,
            url: details.url,
            thumbnail: details.thumbnail,
            synopsis: details.synopsis,
            category: details.category,
            isSeries: true,
            seriesBatches,
            seriesEpisodes
        };
    } else {
        // Movies: Group and deduplicate format keys (e.g. format_1080p and format_1080p_h264 merge into format_1080p)
        const formatGroups = new Map<string, {
            groupKey: string;
            primaryKey: string;
            res: string;
            label: string;
            servers: DownloadServer[];
            isRecommended: boolean;
        }>();

        const getCanonicalGroup = (k: string): { groupKey: string; res: string; label: string } => {
            if (k.includes("4k") || k.includes("2160p")) {
                return { groupKey: "4k", res: "4K", label: "4K Ultra HD HDR" };
            }
            if (k.includes("1080p_hevc") || k.includes("1080p_x265")) {
                return { groupKey: "1080p_hevc", res: "1080p", label: "1080p Full HD HEVC" };
            }
            if (k.includes("1080p_60fps")) {
                return { groupKey: "1080p_60fps", res: "1080p", label: "1080p 60FPS High Frame" };
            }
            if (k.includes("1080p")) {
                return { groupKey: "1080p", res: "1080p", label: "1080p Full HD" };
            }
            if (k.includes("720p_hevc") || k.includes("720p_x265")) {
                return { groupKey: "720p_hevc", res: "720p", label: "720p HEVC (10-Bit x265)" };
            }
            if (k.includes("720p")) {
                return { groupKey: "720p", res: "720p", label: "720p HD" };
            }
            if (k.includes("480p")) {
                return { groupKey: "480p", res: "480p", label: "480p SD (Compact)" };
            }
            return {
                groupKey: k,
                res: "Direct",
                label: k.replace(/^format_/, "").replace(/_/g, " ").toUpperCase()
            };
        };

        for (const k of downloadKeys) {
            const { groupKey, res, label } = getCanonicalGroup(k);
            const srvs = details.downloads[k] || [];
            if (!formatGroups.has(groupKey)) {
                formatGroups.set(groupKey, {
                    groupKey,
                    primaryKey: k,
                    res,
                    label,
                    servers: [...srvs],
                    isRecommended: false
                });
            } else {
                const group = formatGroups.get(groupKey)!;
                for (const s of srvs) {
                    if (!group.servers.some(existing => existing.download_url === s.download_url)) {
                        group.servers.push(s);
                    }
                }
                // Keep both keys in sync in details.downloads
                details.downloads[group.primaryKey] = group.servers;
                details.downloads[k] = group.servers;
            }
        }

        const has720pHevc = formatGroups.has("720p_hevc");
        const movieFormats: ParsedMovieFormat[] = Array.from(formatGroups.values()).map(group => {
            // Find size from ANY server in this merged group
            let fileSize = "";
            for (const s of group.servers) {
                const sSize = cleanFileSize(s.file_size || "") || cleanFileSize(s.server_name || "");
                if (sSize) {
                    fileSize = sSize;
                    break;
                }
            }

            // Propagate discovered fileSize to all servers in this group
            if (fileSize) {
                for (const s of group.servers) {
                    if (!s.file_size) s.file_size = fileSize;
                }
                details.downloads[group.primaryKey] = group.servers;
            }

            const isRec = group.groupKey === "720p_hevc" || (group.groupKey === "720p" && !has720pHevc);

            return {
                qualityKey: group.primaryKey,
                label: group.label,
                resolution: group.res,
                fileSize,
                isRecommended: isRec,
                serverCount: group.servers.length,
                linkUrl: group.servers[0]?.download_url || (group.servers[0] as any)?.link_url || ""
            };
        });

        return {
            name: details.name,
            url: details.url,
            thumbnail: details.thumbnail,
            synopsis: details.synopsis,
            category: details.category,
            isSeries: false,
            movieFormats
        };
    }
}

const mediaDetailsFormatCache = new Map<string, { data: ParsedMediaDetails; timestamp: number }>();

export function parseRawScrapedDetails(raw: any, targetUrl: string): ParsedMediaDetails | null {
    if (!raw) return null;
    const options: any[] = raw.download_options || raw.download_links || [];
    if (options.length === 0) return null;

    const isSeries = Boolean(
        raw.is_tv_series ||
        options.some(o => o.is_batch || o.category_type === 'batch_pack' || o.category_type === 'episode' || /episode|season|batch/i.test(o.label || ''))
    );

    const title = raw.title || raw.name || "Media";

    const qualOrder: Record<string, number> = { "4K": 4, "1080p": 3, "720p": 2, "480p": 1 };

    if (isSeries) {
        // 1. Batches (Deduplicate and sort 4K -> 1080p -> 720p -> 480p)
        const batchOpts = options.filter(o => o.is_batch || o.category_type === 'batch_pack' || /batch|pack|zip/i.test(o.label || ''));
        const seenBatches = new Set<string>();
        const seriesBatches: ParsedSeriesBatch[] = [];

        for (const b of batchOpts) {
            let res = b.quality || "720p";
            if (/4k|2160p/i.test(b.label || "")) res = "4K";
            else if (/1080p/i.test(b.label || "")) res = "1080p";
            else if (/720p/i.test(b.label || "")) res = "720p";
            else if (/480p/i.test(b.label || "")) res = "480p";

            const sz = b.size || cleanFileSize(b.label);
            const bKey = `${res}_${sz}_${b.label}`.toLowerCase();
            if (seenBatches.has(bKey)) continue;
            seenBatches.add(bKey);

            const qKey = "batch_" + (b.label || "pack").toLowerCase().replace(/[^a-z0-9]/g, "_");
            const isRec = /720p.*hevc|hevc.*720p/i.test(b.label) || (!batchOpts.some(x => /hevc/i.test(x.label)) && /720p/i.test(b.label));

            seriesBatches.push({
                qualityKey: qKey,
                label: b.label,
                resolution: res,
                fileSize: sz,
                isRecommended: isRec,
                serverCount: 1,
                linkUrl: b.link_url || ""
            });
        }

        seriesBatches.sort((a, b) => (qualOrder[b.resolution] || 0) - (qualOrder[a.resolution] || 0));

        // 2. Episodes (Deduplicate per episode and sort qualities 4K -> 1080p -> 720p -> 480p)
        const epOpts = options.filter(o => o.category_type === 'episode' || /episode\s*\d+/i.test(o.label || ''));
        const epMap = new Map<number, ParsedSeriesEpisode>();

        for (const ep of epOpts) {
            const m = (ep.label || "").match(/episode\s*(\d+)/i) || (ep.episode_num ? [null, String(ep.episode_num)] : null);
            const epNum = m ? parseInt(m[1], 10) : (ep.episode_num || 1);
            if (!epMap.has(epNum)) {
                epMap.set(epNum, {
                    episodeNum: epNum,
                    title: `Episode ${epNum < 10 ? '0' + epNum : epNum}`,
                    qualities: []
                });
            }

            let res = ep.quality || "720p";
            if (/4k|2160p/i.test(ep.label || "")) res = "4K";
            else if (/1080p/i.test(ep.label || "")) res = "1080p";
            else if (/720p/i.test(ep.label || "")) res = "720p";
            else if (/480p/i.test(ep.label || "")) res = "480p";

            const existingQuals = epMap.get(epNum)!.qualities;
            // Only add if this resolution is not already present or if this one is a better server
            if (!existingQuals.some(q => q.resolution === res)) {
                const qKey = `episode_${epNum}_` + res.toLowerCase().replace(/[^a-z0-9]/g, "_");
                existingQuals.push({
                    qualityKey: qKey,
                    label: res,
                    resolution: res,
                    fileSize: ep.size || cleanFileSize(ep.label),
                    serverCount: 1,
                    linkUrl: ep.link_url || ""
                });
            }
        }

        // Sort episode qualities
        for (const [, epObj] of epMap) {
            epObj.qualities.sort((a, b) => (qualOrder[b.resolution] || 0) - (qualOrder[a.resolution] || 0));
        }

        const sortedEpisodes = Array.from(epMap.values()).sort((a, b) => a.episodeNum - b.episodeNum);

        return {
            name: title,
            url: targetUrl,
            thumbnail: raw.poster || raw.thumbnail,
            synopsis: raw.synopsis,
            category: raw.category,
            isSeries: true,
            source: raw.source || raw.source_name || "",
            seriesBatches,
            seriesEpisodes: sortedEpisodes
        };
    } else {
        // Movie formats (Deduplicate and sort 4K -> 1080p -> 720p -> 480p)
        const seenMovieFormats = new Set<string>();
        const movieFormats: ParsedMovieFormat[] = [];

        options.forEach((opt, idx) => {
            let res = opt.quality || "1080p";
            if (/4k|2160p/i.test(opt.label || "")) res = "4K";
            else if (/1080p/i.test(opt.label || "")) res = "1080p";
            else if (/720p/i.test(opt.label || "")) res = "720p";
            else if (/480p/i.test(opt.label || "")) res = "480p";

            const sz = opt.size || cleanFileSize(opt.label);
            const mKey = `${res}_${sz}_${opt.label}`.toLowerCase();
            if (seenMovieFormats.has(mKey)) return;
            seenMovieFormats.add(mKey);

            const qKey = "format_" + (opt.label || `opt_${idx}`).toLowerCase().replace(/[^a-z0-9]/g, "_");
            const isRec = /720p.*hevc|hevc.*720p/i.test(opt.label) || (!options.some(x => /hevc/i.test(x.label)) && /720p/i.test(opt.label));

            movieFormats.push({
                qualityKey: qKey,
                label: opt.label,
                resolution: res,
                fileSize: sz,
                isRecommended: isRec,
                serverCount: 1,
                linkUrl: opt.link_url || ""
            });
        });

        movieFormats.sort((a, b) => (qualOrder[b.resolution] || 0) - (qualOrder[a.resolution] || 0));

        return {
            name: title,
            url: targetUrl,
            thumbnail: raw.poster || raw.thumbnail,
            synopsis: raw.synopsis,
            category: raw.category,
            isSeries: false,
            source: raw.source || raw.source_name || "",
            movieFormats
        };
    }
}

/**
 * Fast resolution of format/download options for a media release.
 * Tries the lightweight /details endpoint (1s), falling back to full /download if unavailable.
 */
export async function getMediaFormatDetails(targetUrl: string, bypassCache = false): Promise<ParsedMediaDetails | null> {
    if (!targetUrl) return null;
    const cacheKey = targetUrl.trim();

    if (!bypassCache) {
        const cached = mediaDetailsFormatCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            console.log(`[DL-API] Returning cached format details for: ${cacheKey}`);
            return cached.data;
        }
    }

    // 1. Try lightweight /details endpoint (1-2s response time)
    try {
        const detailsUrl = `${DL_API_BASE_URL}/details?param=${encodeURIComponent(targetUrl)}`;
        console.log(`[DL-API] Fetching fast page details: ${detailsUrl}`);
        const res = await fetch(detailsUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "application/json"
            },
            signal: AbortSignal.timeout(12000)
        });

        if (res.ok) {
            const rawData = await res.json();
            const parsed = parseRawScrapedDetails(rawData, targetUrl);
            if (parsed && ((parsed.seriesBatches && parsed.seriesBatches.length > 0) || (parsed.seriesEpisodes && parsed.seriesEpisodes.length > 0) || (parsed.movieFormats && parsed.movieFormats.length > 0))) {
                mediaDetailsFormatCache.set(cacheKey, { data: parsed, timestamp: Date.now() });
                console.log(`[DL-API] Fast page details resolved successfully (${(parsed.seriesBatches?.length || 0) + (parsed.seriesEpisodes?.length || 0) + (parsed.movieFormats?.length || 0)} options)`);
                return parsed;
            }
        }
    } catch (fastErr: any) {
        console.warn(`[DL-API] Fast details extraction fallback: ${fastErr.message}`);
    }

    // 2. Fallback to full getDownloadLinks
    try {
        console.log(`[DL-API] Falling back to standard getDownloadLinks for: ${targetUrl}`);
        const fullDetails = await getDownloadLinks(targetUrl, bypassCache);
        const parsed = parseAvailableMediaFormats(fullDetails);
        if (parsed) {
            mediaDetailsFormatCache.set(cacheKey, { data: parsed, timestamp: Date.now() });
        }
        return parsed;
    } catch (e: any) {
        console.error(`[DL-API] getMediaFormatDetails failed:`, e.message);
        throw e;
    }
}


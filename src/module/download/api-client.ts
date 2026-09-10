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
 * Searches dl.pallabdev.in for any movie or web series with auto-retry
 */
export async function searchMedia(query: string, maxRetries = 2): Promise<SearchResultItem[]> {
    const cleanQuery = (query || "").trim();
    if (!cleanQuery) return [];

    const url = `${DL_API_BASE_URL}/search?param=${encodeURIComponent(cleanQuery)}`;
    console.log(`[DL-API] Searching: ${url}`);

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

            return data;
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
}

export interface ParsedSeriesBatch {
    qualityKey: string;
    label: string;
    resolution: string;
    fileSize: string;
    isRecommended: boolean;
    serverCount: number;
}

export interface ParsedSeriesEpisodeQuality {
    qualityKey: string;
    label: string;
    resolution: string;
    fileSize: string;
    serverCount: number;
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
    movieFormats?: ParsedMovieFormat[];
    seriesBatches?: ParsedSeriesBatch[];
    seriesEpisodes?: ParsedSeriesEpisode[];
}

/**
 * Parses all download keys into structured movie formats or series batch/episode collections
 */
export function cleanFileSize(rawSize: string): string {
    if (!rawSize) return "";
    const cleanMatch = rawSize.trim().match(/^([\d\.]+\s*(?:GB|MB|KB))$/i);
    if (cleanMatch) return cleanMatch[1].toUpperCase();

    const sizeMatch = rawSize.match(/(?:file\s*size:?\s*|size:?\s*)([\d\.]+\s*(?:gb|mb|kb))/i)
        || rawSize.match(/([\d\.]+\s*(?:gb|mb|kb))/i);
    if (sizeMatch) return sizeMatch[1].toUpperCase();

    return rawSize.length <= 10 && /[\d\.]+\s*(?:gb|mb|kb)/i.test(rawSize) ? rawSize.trim() : "";
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
            const fileSize = cleanFileSize(srvs[0]?.file_size || "");
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
                serverCount: srvs.length
            };
        });

        // Parse episodes
        const epKeys = downloadKeys.filter(k => k.startsWith("episode_"));
        const epMap = new Map<number, ParsedSeriesEpisodeQuality[]>();
        for (const k of epKeys) {
            const match = k.match(/episode_(\d+)/i);
            const epNum = match ? parseInt(match[1], 10) : 1;
            const srvs = details.downloads[k] || [];
            const rawSrvText = srvs[0]?.file_size || "";
            const raw = (k + " " + rawSrvText + " " + (srvs[0]?.download_url || "")).toLowerCase();
            const fileSize = cleanFileSize(rawSrvText) || cleanFileSize(k);

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
                    serverCount: srvs.length
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
        // Movies
        const movieFormats: ParsedMovieFormat[] = downloadKeys.map(k => {
            const srvs = details.downloads[k] || [];
            const fileSize = cleanFileSize(srvs[0]?.file_size || "");
            let res = "720p";
            if (k.includes("4k") || k.includes("2160p")) res = "4K";
            else if (k.includes("1080p")) res = "1080p";
            else if (k.includes("480p")) res = "480p";

            let label = k.replace(/^format_/, "").replace(/_/g, " ").toUpperCase();
            if (k.includes("720p_hevc") || k.includes("720p_x265")) label = "720p HEVC (10-Bit x265)";
            else if (k.includes("720p_h264") || k === "720p") label = "720p HD";
            else if (k.includes("1080p_hevc") || k.includes("1080p_x265")) label = "1080p Full HD HEVC";
            else if (k.includes("1080p_60fps")) label = "1080p 60FPS High Frame";
            else if (k.includes("1080p_h264") || k === "1080p") label = "1080p Full HD";
            else if (k.includes("480p")) label = "480p SD (Compact)";
            else if (k.includes("4k") || k.includes("2160p")) label = "4K Ultra HD HDR";

            return {
                qualityKey: k,
                label,
                resolution: res,
                fileSize,
                isRecommended: k.includes("720p_hevc") || (k.includes("720p") && !downloadKeys.some(dk => dk.includes("720p_hevc"))),
                serverCount: srvs.length
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


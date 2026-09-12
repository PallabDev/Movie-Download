import { getHarness } from "../../../command/harness.js";
import { db, schema } from "../../common/db/index.js";
import { desc, eq, and, or } from "drizzle-orm";
import { checkMovieExists, checkSeriesExists, checkMediaExists } from "../../common/jellyfin/client.js";
import { downloadQueue } from "../queue/queue.js";
import {
    searchMedia,
    getDownloadLinks,
    selectBest720pQuality,
    sortServersByPriority,
    parseAvailableMediaFormats,
    type SearchResultItem,
    type DownloadDetails,
    type SelectedQualityResult
} from "../download/api-client.js";
import {
    lookupMedia,
    getSeriesSeasonsAndEpisodes,
    cleanMediaTitle,
} from "../../common/tmdb/client.js";
import { cleanSeriesTitleAndSeason } from "../download/downloader.js";
import { broadcastNewDownload, broadcastAiStatus } from "./ws.js";
import { parseMediaWithAI, formatMediaJobTitle, formatMediaFileName } from "../ai/cleaner.js";

function safeHarness() {
    try {
        return getHarness();
    } catch {
        return {
            logActivity: (msg: string) => console.log(msg),
            logError: (msg: string) => console.error(msg),
        } as any;
    }
}

// ─── TYPES & INTERFACES ───

export interface ToolResult {
    success: boolean;
    message: string;
    data?: any;
}

export interface SearchSessionData {
    query: string;
    title: string;
    year?: string;
    type?: "movie" | "series";
    results: SearchResultItem[];
    createdAt: number;
}

// ─── IN-MEMORY STATE ───

export const searchSessions = new Map<string, SearchSessionData>();

export function cleanOldSessions() {
    for (const [k, v] of searchSessions) {
        if (Date.now() - v.createdAt > 30 * 60 * 1000) searchSessions.delete(k);
    }
}

export function clearWorkflow(sessionId: string) {
    searchSessions.delete(`session_${sessionId}`);
}

// ─── SYSTEM PROMPT ───

export const SYSTEM_PROMPT = `You are CineGrab AI, an autonomous, expert movie & web series download assistant connected to high-speed 10Gbps CDN servers (via dl.pallabdev.in) and TMDB.

## AUTONOMOUS & STREAMLINED BEHAVIOR (CRITICAL):
1. **Fully Autonomous Execution**:
   - When a user asks to find, get, or download any movie or TV series / show (e.g. "Download Bahubali", "Get Panchayat", "India's Got Latent", "Stree 2", "Inception"):
     - **DO NOT** block or ask the user which option to choose.
     - You must execute the entire flow autonomously in one smooth turn:
       1. Search for the title using 'search_media' (or 'search_movie' / 'search_series').
       2. Immediately resolve direct download links and queue the **720p** release using 'download_media' (or 'download_movie' / 'download_series').
     - In your final response:
       - Show all matching search results with their thumbnails, categories, and years.
       - Clearly confirm that the optimal **720p** release (or 720p batch pack for web series) has been queued and is downloading in the background.
2. **ALWAYS 720p QUALITY PRIORITY**:
   - Always prioritize and select the **720p** release (720p Batch Season Pack or 720p episodes for series; 720p WEB-DL / BluRay for movies).
3. **ALL MEDIA SUPPORTED**:
   - Both **Movies** and **Web Series / TV Shows** are fully supported for search and download!
4. **RICH VISUAL PRESENTATION**:
   - If posters or thumbnails are available from the search results, present them visually using Markdown image tags: \`![Title](thumbnail_url)\`.
   - Include category tags, stars, release date, and download details.
5. **GREETINGS & GENERAL CONVERSATION**:
   - If the user sends a greeting (e.g. "hi", "hello", "how are you"), reply warmly and tell them you're ready to find and download any movies or web series in 720p!

## AVAILABLE TOOLS:

### search_media(query)
Searches dl.pallabdev.in for any movie or web series.
- query: e.g. "Bahubali", "India's Got Latent", "Panchayat", "Stree 2"

### download_media(targetUrl, title, year, optionIndex)
Resolves direct download links for the selected search result and starts high-speed background downloading in 720p.
- targetUrl: optional permalink URL returned by search (e.g. "https://new5.hdhub4u.cl/...")
- title: title of the movie or series
- year: optional release year
- optionIndex: 1-based index of the search result if targetUrl is not provided

### check_jellyfin(title, type, year)
Checks if media is already present in your Jellyfin media library.

### list_downloads
Lists active and completed download jobs.
`;

// ─── TOOL IMPLEMENTATIONS ───

/**
 * 1. SEARCH MEDIA (Movies & Series via dl.pallabdev.in)
 */
export async function toolSearchMedia(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const query = (args.query || args.title || "").trim();
    if (!query) return { success: false, message: "Query or title is required" };

    const harness = safeHarness();
    harness.logActivity(`[TOOL search_media] Searching dl.pallabdev.in for: "${query}"`);

    try {
        broadcastAiStatus(sessionId, { step: "searching", label: `Searching releases for "${query}"...` });
    } catch {}

    try {
        const cleaned = cleanMediaTitle(query);
        const searchTitle = cleaned.title || query;

        const results = await searchMedia(searchTitle);

        if (!results || results.length === 0) {
            harness.logActivity(`[TOOL search_media] No results found for "${query}"`);
            return {
                success: true,
                message: `NO_RESULTS: No releases found for "${query}"`,
                data: { results: [], query }
            };
        }

        const sessionData: SearchSessionData = {
            query,
            title: searchTitle,
            year: cleaned.year || undefined,
            results,
            createdAt: Date.now()
        };

        const sessionKey = `srch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        searchSessions.set(sessionKey, sessionData);
        if (sessionId) searchSessions.set(`session_${sessionId}`, sessionData);
        searchSessions.set(`title_${searchTitle.toLowerCase()}`, sessionData);

        harness.logActivity(`[TOOL search_media] Found ${results.length} results for "${query}"`);

        return {
            success: true,
            message: `FOUND_RESULTS: Found ${results.length} matching releases for "${query}"`,
            data: {
                results: results.map((r, i) => ({
                    index: i + 1,
                    name: r.name,
                    url: r.url,
                    thumbnail: r.thumbnail || "",
                    category: r.category || [],
                    director: r.director || [],
                    stars: r.stars || [],
                    imdb_id: r.imdb_id || "",
                    post_date: r.post_date || ""
                })),
                totalResults: results.length,
                query,
                sessionKey
            }
        };
    } catch (err: any) {
        harness.logError(`[TOOL search_media] Error: ${err.message}`);
        return {
            success: false,
            message: `SEARCH_ERROR: Failed to search for "${query}": ${err.message}`,
            data: { error: err.message }
        };
    }
}

export async function toolSearchMovie(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    return toolSearchMedia(args, sessionId);
}

export async function toolSearchSeries(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    return toolSearchMedia(args, sessionId);
}

/**
 * 2. DOWNLOAD MEDIA (Resolves direct links & queues 720p download)
 */
/**
 * 2. GET MEDIA FORMATS (Resolves all formats, series batches & episodes)
 */
export async function toolGetMediaFormats(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const harness = safeHarness();
    let { targetUrl, url, title, optionIndex, sessionKey } = args;

    let targetLink = targetUrl || url;
    let targetTitle = title;

    let session = sessionKey ? searchSessions.get(sessionKey) : null;
    if (!session && sessionId) session = searchSessions.get(`session_${sessionId}`);
    if (!session && title) session = searchSessions.get(`title_${title.toLowerCase().trim()}`);

    if (!targetLink && session && session.results.length > 0) {
        const idx = typeof optionIndex === "number" && optionIndex >= 1 && optionIndex <= session.results.length
            ? optionIndex - 1
            : 0;
        const item = session.results[idx];
        if (item) {
            targetLink = item.url;
            targetTitle = targetTitle || item.name;
        }
    }

    if (!targetLink && targetTitle) {
        try {
            const sRes = await searchMedia(targetTitle);
            if (sRes && sRes.length > 0) {
                targetLink = sRes[0].url;
                targetTitle = targetTitle || sRes[0].name;
            }
        } catch {}
    }

    if (!targetLink) {
        return {
            success: false,
            message: "MISSING_URL: Target URL or title could not be resolved."
        };
    }

    try {
        broadcastAiStatus(sessionId, { step: "resolving_links", label: `Resolving available formats & episodes...` });
        const details = await getDownloadLinks(targetLink);
        const parsed = parseAvailableMediaFormats(details);
        return {
            success: true,
            message: `Available formats for "${details.name}" resolved successfully.`,
            data: { details: parsed }
        };
    } catch (err: any) {
        harness.logError(`[TOOL get_media_formats] Error: ${err.message}`);
        return {
            success: false,
            message: `FORMAT_RESOLVE_ERROR: Failed to resolve formats: ${err.message}`
        };
    }
}

/**
 * 3. DOWNLOAD MEDIA (Resolves direct links & queues selected format or 720p)
 */
export async function toolDownloadMedia(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const harness = safeHarness();
    let { targetUrl, url, title, year, optionIndex, sessionKey, qualityKey, isBatch, episodeNum, fileSize } = args;

    let targetLink = targetUrl || url;
    let targetTitle = title;
    let targetYear = year;

    let session = sessionKey ? searchSessions.get(sessionKey) : null;
    if (!session && sessionId) session = searchSessions.get(`session_${sessionId}`);
    if (!session && title) session = searchSessions.get(`title_${title.toLowerCase().trim()}`);

    if (!targetLink && session && session.results.length > 0) {
        const idx = typeof optionIndex === "number" && optionIndex >= 1 && optionIndex <= session.results.length
            ? optionIndex - 1
            : 0;
        const item = session.results[idx];
        if (item) {
            targetLink = item.url;
            targetTitle = targetTitle || item.name;
        }
    }

    if (!targetLink && targetTitle) {
        // Run quick search to find targetUrl
        try {
            const sRes = await searchMedia(targetTitle);
            if (sRes && sRes.length > 0) {
                targetLink = sRes[0].url;
                targetTitle = targetTitle || sRes[0].name;
            }
        } catch {}
    }

    if (!targetLink) {
        return {
            success: false,
            message: "MISSING_URL: Target URL or title could not be resolved for download."
        };
    }

    try {
        broadcastAiStatus(sessionId, { step: "resolving_links", label: `Resolving 10Gbps direct download links...` });
    } catch {}

    harness.logActivity(`[TOOL download_media] Fetching download links for: ${targetLink}`);

    try {
        const details: DownloadDetails = await getDownloadLinks(targetLink);
        const cleanName = details.name || targetTitle || "Media";

        // Case 1: Specific qualityKey requested (e.g. format_1080p_hevc, batch_season_pack_720p_hevc, episode_1_720p)
        if (qualityKey && details.downloads[qualityKey]) {
            const rawServers = details.downloads[qualityKey];
            const servers = sortServersByPriority(rawServers);
            const actualSize = fileSize || servers[0]?.file_size || "Direct";

            const isSeriesItem = Boolean(isBatch || episodeNum !== undefined || qualityKey.startsWith("batch_") || qualityKey.startsWith("episode_"));
            let mediaType: "movie" | "series" = isSeriesItem ? "series" : "movie";

            const rawNameToParse = [cleanName, targetLink].filter(Boolean).join(" ");
            const aiMeta = await parseMediaWithAI(rawNameToParse);
            if (isSeriesItem) {
                aiMeta.type = "series";
                if (episodeNum !== undefined) {
                    aiMeta.episode = episodeNum;
                    aiMeta.isBatch = false;
                } else {
                    aiMeta.isBatch = true;
                }
            } else {
                aiMeta.type = "movie";
            }
            mediaType = aiMeta.type;
            const movieYear = aiMeta.year;
            const jobTitle = formatMediaJobTitle(aiMeta);
            const jobFileName = formatMediaFileName(aiMeta);

            // Deduplication check
            try {
                const existing = await db.select()
                    .from(schema.downloads)
                    .where(
                        and(
                            eq(schema.downloads.title, jobTitle),
                            or(
                                eq(schema.downloads.status, "queued"),
                                eq(schema.downloads.status, "downloading")
                            )
                        )
                    )
                    .limit(1);

                if (existing && existing.length > 0) {
                    harness.logActivity(`[TOOL download_media] "${jobTitle}" is already active/queued. Skipping duplicate.`);
                    return {
                        success: true,
                        message: `MEDIA_ALREADY_DOWNLOADING: "${jobTitle}" is already in your download queue!`,
                        data: {
                            requestId: existing[0].requestId,
                            title: jobTitle,
                            type: mediaType,
                            fileSize: actualSize,
                            alreadyActive: true
                        }
                    };
                }
            } catch (dbErr: any) {
                console.warn(`[TOOL download_media] Warning checking existing download: ${dbErr?.message}`);
            }

            const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            try {
                await db.insert(schema.downloads).values({
                    requestId,
                    title: jobTitle,
                    year: movieYear || null,
                    type: mediaType,
                    status: "queued",
                    season: mediaType === "series" ? (aiMeta.season || 1) : null,
                    episode: mediaType === "series" ? (aiMeta.episode ?? null) : null,
                    fileSize: actualSize,
                });
            } catch (dbErr: any) {
                console.warn(`[TOOL download_media] DB insert error: ${dbErr?.message}`);
            }

            downloadQueue.addJob({
                requestId,
                type: mediaType,
                title: jobTitle,
                year: movieYear,
                season: mediaType === "series" ? (aiMeta.season || 1) : undefined,
                episode: mediaType === "series" ? (aiMeta.episode ?? undefined) : undefined,
                servers,
                fileSize: actualSize,
                isBatchPack: Boolean(isBatch || aiMeta.isBatch),
                fileName: jobFileName,
            });

            try { broadcastNewDownload({ jobId: requestId, title: jobTitle, type: mediaType, requestedBy: "ai" }); } catch {}

            return {
                success: true,
                message: `MEDIA_DOWNLOAD_QUEUED: "${jobTitle}" (${actualSize}) added to download queue via high-speed 10Gbps CDN.`,
                data: {
                    requestId,
                    title: jobTitle,
                    type: mediaType,
                    fileSize: actualSize,
                    qualityKey,
                    isBatchPack: Boolean(isBatch || qualityKey.startsWith("batch_")),
                    serversCount: servers.length
                }
            };
        }

        // Case 2: Autonomous best 720p selection fallback
        const quality = selectBest720pQuality(details);

        if (!quality) {
            return {
                success: false,
                message: `NO_DOWNLOAD_LINKS: No active download servers found for "${cleanName}".`,
                data: { details }
            };
        }

        const isSeries = quality.isBatchPack || quality.isEpisodeList;
        let mediaType: "movie" | "series" = isSeries ? "series" : "movie";

        // Check if this media is already active or queued
        try {
            const existing = await db.select()
                .from(schema.downloads)
                .where(
                    and(
                        eq(schema.downloads.title, cleanName),
                        or(
                            eq(schema.downloads.status, "queued"),
                            eq(schema.downloads.status, "downloading")
                        )
                    )
                )
                .limit(1);

            if (existing && existing.length > 0) {
                harness.logActivity(`[TOOL download_media] "${cleanName}" is already active/queued (${existing[0].status}). Skipping duplicate.`);
                return {
                    success: true,
                    message: `MEDIA_ALREADY_DOWNLOADING: "${cleanName}" is already downloading in 720p!`,
                    data: {
                        requestId: existing[0].requestId,
                        title: cleanName,
                        type: mediaType,
                        fileSize: existing[0].fileSize || quality.fileSize,
                        alreadyActive: true
                    }
                };
            }
        } catch (dbErr: any) {
            console.warn(`[TOOL download_media] Warning checking existing download: ${dbErr?.message}`);
        }

        // Check if batch pack vs episode list vs movie
        if (quality.isEpisodeList && quality.episodes && quality.episodes.length > 0) {
            const { title: cleanSeriesTitle, season: cleanSeason } = cleanSeriesTitleAndSeason(cleanName, 1);
            const queuedEpisodes: string[] = [];

            for (const ep of quality.episodes) {
                const epReqId = `ep_${Date.now()}_${ep.episodeNum}_${Math.random().toString(36).slice(2, 6)}`;
                const epTitle = `${cleanSeriesTitle} - S${String(cleanSeason).padStart(2, "0")}E${String(ep.episodeNum).padStart(2, "0")}`;
                const epFileName = `${cleanSeriesTitle} - S${String(cleanSeason).padStart(2, "0")}E${String(ep.episodeNum).padStart(2, "0")}.mkv`;

                try {
                    await db.insert(schema.downloads).values({
                        requestId: epReqId,
                        title: epTitle,
                        type: "series",
                        status: "queued",
                        season: cleanSeason,
                        episode: ep.episodeNum,
                        fileSize: ep.servers[0]?.file_size || "720p",
                    });
                } catch (dbErr: any) {
                    console.warn(`[TOOL download_media] Warning: DB insert failed: ${dbErr?.message || dbErr}`);
                }

                downloadQueue.addJob({
                    requestId: epReqId,
                    type: "series",
                    title: epTitle,
                    season: cleanSeason,
                    episode: ep.episodeNum,
                    servers: ep.servers,
                    fileSize: ep.servers[0]?.file_size || "720p",
                    fileName: epFileName,
                });

                try { broadcastNewDownload({ jobId: epReqId, title: epTitle, type: "series", requestedBy: "ai" }); } catch {}
                queuedEpisodes.push(`Episode ${ep.episodeNum}`);
            }

            harness.logActivity(`[TOOL download_media] Queued ${queuedEpisodes.length} episodes in 720p for "${cleanSeriesTitle}"`);

            return {
                success: true,
                message: `MEDIA_DOWNLOAD_QUEUED: Queued all ${queuedEpisodes.length} episodes for "${cleanSeriesTitle}" in 720p into the background download queue!`,
                data: {
                    type: "series",
                    title: cleanSeriesTitle,
                    queuedEpisodes,
                    quality: "720p"
                }
            };
        }

        // Single movie file or Series Batch Pack
        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const fileSizeStr = quality.fileSize || "720p High Speed";

        const rawNameToParse = [cleanName, targetYear].filter(Boolean).join(" ");
        const aiMeta = await parseMediaWithAI(rawNameToParse);
        if (isSeries) {
            aiMeta.type = "series";
            aiMeta.isBatch = true;
        } else {
            aiMeta.type = "movie";
        }
        mediaType = aiMeta.type;
        const movieYear = aiMeta.year;
        const jobTitle = formatMediaJobTitle(aiMeta);
        const jobFileName = formatMediaFileName(aiMeta);

        try {
            await db.insert(schema.downloads).values({
                requestId,
                title: jobTitle,
                type: mediaType,
                status: "queued",
                season: mediaType === "series" ? (aiMeta.season || 1) : null,
                episode: mediaType === "series" ? (aiMeta.episode ?? null) : null,
                year: movieYear || "",
                fileSize: fileSizeStr,
            });
        } catch (dbErr: any) {
            console.warn(`[TOOL download_media] Warning: DB insert failed: ${dbErr?.message || dbErr}`);
        }

        downloadQueue.addJob({
            requestId,
            type: mediaType,
            title: jobTitle,
            year: movieYear || "",
            season: mediaType === "series" ? (aiMeta.season || 1) : undefined,
            episode: mediaType === "series" ? (aiMeta.episode ?? undefined) : undefined,
            servers: quality.servers,
            fileSize: fileSizeStr,
            isBatchPack: quality.isBatchPack || Boolean(aiMeta.isBatch),
            fileName: jobFileName,
        });

        try { broadcastNewDownload({ jobId: requestId, title: cleanName, type: mediaType, requestedBy: "ai" }); } catch {}
        harness.logActivity(`[TOOL download_media] Queued ${mediaType} "${cleanName}" in 720p [Servers: ${quality.servers.length}, Size: ${fileSizeStr}]`);

        return {
            success: true,
            message: `MEDIA_DOWNLOAD_QUEUED: "${cleanName}" (${fileSizeStr}) added to download queue via high-speed 10Gbps CDN.`,
            data: {
                requestId,
                title: cleanName,
                type: mediaType,
                fileSize: fileSizeStr,
                qualityKey: quality.qualityKey,
                isBatchPack: quality.isBatchPack,
                serversCount: quality.servers.length
            }
        };

    } catch (err: any) {
        harness.logError(`[TOOL download_media] Error: ${err.message}`);
        return {
            success: false,
            message: `DOWNLOAD_ERROR: Failed to initiate download: ${err.message}`,
            data: { error: err.message }
        };
    }
}

export async function toolDownloadMovie(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    return toolDownloadMedia(args, sessionId);
}

export async function toolDownloadSeries(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    return toolDownloadMedia(args, sessionId);
}

export async function toolDownloadEpisode(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    return toolDownloadMedia(args, sessionId);
}

/**
 * 4. CHECK JELLYFIN LIBRARY
 */
export async function toolCheckJellyfin(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title, type, year } = args;
    if (!title) return { success: false, message: "Title is required" };

    const harness = safeHarness();
    harness.logActivity(`[TOOL check_jellyfin] Checking Jellyfin for "${title}"`);

    try {
        const res = await checkMediaExists(title, type, year);
        return {
            success: true,
            message: res.exists
                ? `EXISTS: "${res.item?.Name || title}" is already in your Jellyfin ${res.type || "media"} library! You can stream it directly.`
                : `NOT_IN_LIBRARY: "${title}" is not in your Jellyfin media library.`,
            data: { exists: res.exists, title: res.item?.Name || title, type: res.type, item: res.item }
        };
    } catch (err: any) {
        return { success: false, message: `JELLYFIN_ERROR: ${err.message}` };
    }
}

/**
 * 5. LIST DOWNLOADS
 */
export async function toolListDownloads(): Promise<ToolResult> {
    try {
        const stats = downloadQueue.getStats();
        const recent = await db.select().from(schema.downloads).orderBy(desc(schema.downloads.createdAt)).limit(10);
        return {
            success: true,
            message: `QUEUE_STATS: ${stats.active} active, ${stats.waiting} waiting, ${stats.completed} completed`,
            data: { stats, recent }
        };
    } catch (err: any) {
        return { success: false, message: `LIST_ERROR: ${err.message}` };
    }
}

// ─── TOOL DISPATCHER ───

export async function executeTool(toolName: string, args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    switch (toolName) {
        case "search_media":
        case "search_movie":
        case "search_series":
            return await toolSearchMedia(args, sessionId);
        case "get_media_formats":
        case "get_download_links":
            return await toolGetMediaFormats(args, sessionId);
        case "download_media":
        case "download_movie":
        case "download_series":
        case "download_episode":
            return await toolDownloadMedia(args, sessionId);
        case "check_jellyfin":
            return await toolCheckJellyfin(args, sessionId);
        case "list_downloads":
            return await toolListDownloads();
        default:
            return { success: false, message: `UNKNOWN_TOOL: "${toolName}" is not recognized.` };
    }
}


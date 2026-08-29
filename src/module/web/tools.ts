import { getHarness } from "../../../command/harness.js";
import { db, schema } from "../../common/db/index.js";
import { desc, eq } from "drizzle-orm";
import { checkMovieExists, checkSeriesExists } from "../../common/jellyfin/client.js";
import { downloadQueue } from "../queue/queue.js";
import { isBotConnected, getAuthState, submitPhone, submitCode, submitPassword, startWebAuth } from "../bot/bot.js";
import { webSearch, pickBestResult, groupByEpisode, getSeriesInfo } from "../ai/brain.js";
import {
    lookupMedia,
    getSeriesSeasonsAndEpisodes,
    getSeasonEpisodesList,
    searchMovie as tmdbSearchMovie,
    searchTV as tmdbSearchTV,
    cleanMediaTitle,
} from "../../common/tmdb/client.js";
import { inngest } from "../inngest/client.js";
import { broadcastNewDownload } from "./ws.js";
import { logTelegramAudit } from "../../common/logger/telegram-audit.js";

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

export type WorkflowStep = "idle" | "web_searched" | "telegram_searched" | "user_picked" | "downloading";

export interface WorkflowStateData {
    step: WorkflowStep;
    type: "movie" | "series" | null;
    title: string;
    year: string;
    webResults: any[];
    sessionId: string;
}

// ─── IN-MEMORY STATE ───

export const searchSessions = new Map<string, {
    bot: string;
    btnMsgId: number;
    btnMsg: any;
    buttonMap?: Map<string, { bot: string; btnMsg: any; btnMsgId: number; text: string }>;
    results: { text: string; sizeMB: number }[];
    grouped: any[];
    title: string;
    type: string;
    year: string;
    createdAt: number;
}>();

export function cleanOldSessions() {
    for (const [k, v] of searchSessions) {
        if (Date.now() - v.createdAt > 30 * 60 * 1000) searchSessions.delete(k);
    }
}

export const workflowState = new Map<string, WorkflowStateData>();

export function getWorkflow(sessionId: string): WorkflowStateData | undefined {
    return workflowState.get(sessionId);
}

export function setWorkflow(sessionId: string, state: Partial<WorkflowStateData>) {
    const existing = workflowState.get(sessionId) || {
        step: "idle" as WorkflowStep,
        type: null,
        title: "",
        year: "",
        webResults: [],
        sessionId
    };
    workflowState.set(sessionId, { ...existing, ...state });
}

export function clearWorkflow(sessionId: string) {
    workflowState.delete(sessionId);
}

export function extractSizeMB(text: string): number {
    const match = text.match(/\[([\d.]+)\s*(GB|MB|KB)\]/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit === "GB") return val * 1024;
    if (unit === "MB") return val;
    return val / 1024;
}

// ─── SYSTEM PROMPT ───

export const SYSTEM_PROMPT = `You are an expert movie download copilot connected to The Movie Database (TMDB) and Telegram bot (@ProSearchM11Bot).

## STRICT POLICY:
1. ONLY MOVIES ARE SUPPORTED. TV Series, TV shows, and web series downloading is currently disabled.
2. If the user searches for or asks to download a TV series, TV show, or web series, immediately inform them politely:
   "⚠️ **TV Shows & Series are currently not supported.** Only **Movies** are available for download. Please tell me which movie you would like to search or download! 🎬"
3. When searching movies, ALWAYS prioritize the **720p** release (recommend Option 2 / 720p for best balance of video quality and file size). If 720p is not available, only then recommend the best available higher quality (1080p).
4. When the user confirms with "yes", "download", "download recommend", or chooses an option number (e.g. "1", "2", "download 2"), call 'download_movie' with the corresponding optionIndex.

## 2-STEP WORKFLOW:

### STEP 1: MOVIE SEARCH & PRESENTATION
- When the user asks about a movie (e.g., "Grihapravesh", "Bajrangi Bhaijaan 2015", "Inception"):
  - Call 'search_movie' with title and optional year.
  - Presents available releases (720p, 1080p) from Telegram @ProSearchM11Bot with clear option numbers (#1, #2, #3...).
  - Highlights the recommended 720p option.

### STEP 2: DOWNLOAD EXECUTION
- When the user selects or confirms an option (e.g. "2", "download 2", "yes", "download recommend"):
  - Call 'download_movie' passing title, year, and optionIndex (e.g. {"tool": "download_movie", "args": {"title": "Grihapravesh", "year": "2025", "optionIndex": 2}}).

## RULES:
1. NEVER display raw JSON in your final conversational response. Use clean, beautiful Markdown tables, bullet points, and emojis.
2. If you need to perform an action, output ONLY ONE JSON tool call in format: {"tool": "tool_name", "args": {"key": "value"}}.

## AVAILABLE TOOLS:

### search_movie(title, year)
Searches TMDB and Telegram @ProSearchM11Bot for movie releases.
- title: e.g. "Bajrangi Bhaijaan", "Inception"
- year: optional release year, e.g. "2015"

### download_movie(title, year, optionIndex, buttonText, sessionId)
Downloads a specific movie release. Pass optionIndex (e.g. 1, 2, 3) if the user chose an option number.
- title: movie title (e.g. "Grihapravesh")
- year: optional release year (e.g. "2025")
- optionIndex: optional 1-based number matching the user's choice (e.g. 2)
- buttonText: optional button label text

### check_jellyfin(title, type, year)
Checks if content is already in the Jellyfin media library.

### list_downloads
List recent downloads and active queue status.
`;

// ─── TOOL IMPLEMENTATIONS ───

/**
 * 1. SEARCH SERIES (Disabled - Movies Only)
 */
export async function toolSearchSeries(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title } = args;
    return {
        success: false,
        message: `TV_SHOWS_NOT_SUPPORTED: TV Shows & Series ("${title || "series"}") are currently not supported. Only Movies are available for download.`,
        data: { supported: false }
    };
}

/**
 * 2. DOWNLOAD SERIES (Disabled - Movies Only)
 */
export async function toolDownloadSeries(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title } = args;
    return {
        success: false,
        message: `TV_SHOWS_NOT_SUPPORTED: TV Shows & Series ("${title || "series"}") are currently not supported. Only Movies are available for download.`,
        data: { supported: false }
    };
}

export async function toolDownloadEpisode(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    return {
        success: false,
        message: "TV_SHOWS_NOT_SUPPORTED: TV Shows & Series are currently not supported. Only Movies are available for download.",
        data: { supported: false }
    };
}

/**
 * 3. SEARCH MOVIE (TMDB Validation + Telegram @ProSearchM11Bot Search)
 */
export async function toolSearchMovie(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title, year } = args;
    if (!title) return { success: false, message: "Title is required" };

    const harness = safeHarness();
    const cleaned = cleanMediaTitle(title);
    const cleanTitle = cleaned.title || title.trim();
    const cleanYear = year || cleaned.year || "";

    // Verify with TMDB whether this is actually a TV series
    const mediaMeta = await lookupMedia(cleanTitle);
    if (mediaMeta && mediaMeta.found && mediaMeta.type === "series") {
        harness.logActivity(`[TOOL search_movie] "${cleanTitle}" is a TV series. Redirecting to search_series.`);
        return await toolSearchSeries({ title: cleanTitle }, sessionId);
    }

    if (!isBotConnected()) {
        return { success: false, message: "BOT_DISCONNECTED: Please connect the Telegram bot first." };
    }

    const jf = await checkMovieExists(cleanTitle, cleanYear);
    if (jf.exists) {
        return { success: true, message: `ALREADY_IN_JELLYFIN:${cleanTitle}`, data: { exists: true } };
    }

    const query = `${cleanTitle} ${cleanYear}`.trim();
    harness.logActivity(`[TOOL search_movie] Querying @ProSearchM11Bot for: "${query}"`);

    // Auto-record to requested media
    db.insert(schema.requestedMedia).values({
        title: cleanTitle,
        type: "movie",
        year: cleanYear || null,
        status: "requested",
        requestedBy: sessionId
    }).catch(() => {});

    const botClient = (await import("../bot/bot.js")).default;

    const sent = await botClient.sendMessage("ProSearchM11Bot", { message: query });
    logTelegramAudit({
        action: "SEND_QUERY",
        bot: "ProSearchM11Bot",
        query,
        sentMsgId: sent.id,
        caller: "search_movie"
    });

    await new Promise(r => setTimeout(r, 4000));

    let btnMsg: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const messages = await botClient.getMessages("ProSearchM11Bot", { limit: 10 });
        for (const msg of messages) {
            if (msg.id <= sent.id) continue;
            const buttons = await msg.getButtons();
            if (buttons && buttons.length > 0) { btnMsg = msg; break; }
        }
        if (btnMsg) break;
        await new Promise(r => setTimeout(r, 2500));
    }

    if (!btnMsg) {
        logTelegramAudit({
            action: "NO_RESULTS",
            bot: "ProSearchM11Bot",
            query,
            caller: "search_movie",
            details: { reason: "No buttons message received within timeout" }
        });
        return { success: true, message: `NO_RESULTS:${cleanTitle}`, data: { results: [] } };
    }

    const buttons = (await btnMsg.getButtons())!;
    const results: { text: string; sizeMB: number }[] = [];
    for (const row of buttons) {
        for (const btn of row) {
            const text = (btn as any).text || "";
            if (!text) continue;
            const lower = text.toLowerCase();
            if (lower.includes("srt") || lower.includes("sub")) continue;
            const sizeMB = extractSizeMB(text);
            if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;
            results.push({ text, sizeMB });
        }
    }

    if (results.length === 0) {
        logTelegramAudit({
            action: "NO_RESULTS",
            bot: "ProSearchM11Bot",
            query,
            caller: "search_movie",
            details: { reason: "No valid video options among buttons" }
        });
        return { success: true, message: `NO_RESULTS:${cleanTitle}`, data: { results: [] } };
    }

    logTelegramAudit({
        action: "RECEIVE_RESPONSE",
        bot: "ProSearchM11Bot",
        query,
        responseMsgId: btnMsg.id,
        resultsCount: results.length,
        resultsPreview: results.map(r => r.text),
        caller: "search_movie"
    });

    const sessionKey = `movie_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sessionData = {
        bot: "ProSearchM11Bot", btnMsgId: btnMsg.id, btnMsg, results, grouped: [],
        title: cleanTitle, type: "movie", year: cleanYear, createdAt: Date.now()
    };
    searchSessions.set(sessionKey, sessionData);
    if (sessionId) searchSessions.set(`session_${sessionId}`, sessionData);
    searchSessions.set(`title_${cleanTitle.toLowerCase().trim()}`, sessionData);

    const best = await pickBestResult(cleanTitle, "movie", results);
    setWorkflow(sessionId, { step: "telegram_searched", type: "movie", title: cleanTitle, year: cleanYear });

    return {
        success: true,
        message: `MOVIE_RESULTS:${results.length} results found for "${cleanTitle}"`,
        data: {
            results: results.map((r, i) => ({
                text: r.text, sizeMB: r.sizeMB,
                isBest: i === best.index, reason: i === best.index ? best.reason : ""
            })),
            bestIdx: best.index,
            sessionKey, title: cleanTitle, year: cleanYear
        }
    };
}

/**
 * 4. DOWNLOAD MOVIE
 */
export async function toolDownloadMovie(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title, year, sessionKey } = args;
    let buttonText = args.buttonText;
    let optionIndex = args.optionIndex ?? args.option ?? args.index ?? args.choice;

    if (optionIndex === undefined && typeof buttonText === "string") {
        const numMatch = buttonText.trim().match(/^(?:option\s*)?(\d+)$/i);
        if (numMatch) {
            optionIndex = parseInt(numMatch[1], 10);
            buttonText = undefined;
        }
    }

    let session = sessionKey ? searchSessions.get(sessionKey) : null;
    if (!session && sessionId) session = searchSessions.get(`session_${sessionId}`);
    if (!session && title) session = searchSessions.get(`title_${title.toLowerCase().trim()}`);

    const targetTitle = title || session?.title;
    if (!targetTitle) return { success: false, message: "Title is required for download" };

    const harness = safeHarness();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let targetBtnText = buttonText || "";
    let exactFileSize = "";
    let resolvedOptIdx = typeof optionIndex === "number" ? optionIndex : undefined;

    if (session && session.results && session.results.length > 0) {
        if (typeof optionIndex === "number" && optionIndex >= 1 && optionIndex <= session.results.length) {
            const chosen = session.results[optionIndex - 1];
            targetBtnText = chosen.text;
            exactFileSize = chosen.sizeMB >= 1024
                ? `${(chosen.sizeMB / 1024).toFixed(2)} GB`
                : `${chosen.sizeMB.toFixed(0)} MB`;
        } else if (!targetBtnText) {
            const best = await pickBestResult(targetTitle, "movie", session.results);
            const chosen = session.results[best.index];
            if (chosen) {
                targetBtnText = chosen.text;
                resolvedOptIdx = best.index + 1;
                exactFileSize = chosen.sizeMB >= 1024
                    ? `${(chosen.sizeMB / 1024).toFixed(2)} GB`
                    : `${chosen.sizeMB.toFixed(0)} MB`;
            }
        }
    }

    if (!exactFileSize && targetBtnText) {
        const sizeMatch = targetBtnText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
        if (sizeMatch) exactFileSize = `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}`;
    }

    const fileSize = exactFileSize || "720p WEB-DL";

    try {
        await db.insert(schema.downloads).values({
            requestId,
            title: targetTitle,
            type: "movie",
            status: "queued",
            year: year || session?.year || "",
            fileSize,
        });

        downloadQueue.addJob({
            requestId,
            bot: session?.bot || "ProSearchM11Bot",
            btnMsgId: session?.btnMsgId || 0,
            type: "movie",
            title: targetTitle,
            year: year || session?.year || "",
            fileSize,
            buttonText: targetBtnText,
            optionIndex: resolvedOptIdx,
        });

        try { broadcastNewDownload({ jobId: requestId, title: targetTitle, type: "movie", requestedBy: "ai" }); } catch {}
        harness.logActivity(`[QUEUE] Queued movie "${targetTitle}" (Option #${resolvedOptIdx || "auto"}: ${targetBtnText || fileSize})`);

        return {
            success: true,
            message: `MOVIE_DOWNLOAD_QUEUED: "${targetTitle}" (${fileSize}) added to download queue`,
            data: { requestId, title: targetTitle, fileSize, optionIndex: resolvedOptIdx, buttonText: targetBtnText }
        };
    } catch (err: any) {
        return { success: false, message: `DOWNLOAD_ERROR: ${err.message}` };
    }
}


/**
 * 6. DIRECT TMDB SEARCH TOOL
 */
export async function toolTmdbSearch(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { query } = args;
    if (!query) return { success: false, message: "Query is required" };

    const harness = safeHarness();
    harness.logActivity(`[TMDB] Direct search: "${query}"`);
    const media = await lookupMedia(query);

    if (!media || !media.found) {
        return { success: false, message: `NOT_FOUND: No media found on TMDB for "${query}"` };
    }

    return {
        success: true,
        message: `TMDB_RESULT: Found ${media.type} "${media.title}" (${media.year})`,
        data: media
    };
}

/**
 * 7. GET SERIES SEASONS
 */
export async function toolGetSeriesSeasons(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title } = args;
    if (!title) return { success: false, message: "Title is required" };

    const harness = safeHarness();
    harness.logActivity(`[TMDB] Getting seasons for series: "${title}"`);
    const info = await getSeriesSeasonsAndEpisodes(title);

    if (!info || !info.found) {
        return { success: false, message: `NOT_FOUND: Series "${title}" not found on TMDB` };
    }

    return {
        success: true,
        message: `SERIES_SEASONS: "${info.title}" has ${info.totalSeasons} seasons. Episodes per season: [${info.episodesPerSeason.join(", ")}]`,
        data: info
    };
}

/**
 * 8. GET SEASON EPISODES
 */
export async function toolGetSeasonEpisodes(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title, season } = args;
    if (!title || !season) return { success: false, message: "Title and season are required" };

    const sNum = parseInt(String(season), 10);
    const harness = safeHarness();
    harness.logActivity(`[TMDB] Getting episodes for "${title}" Season ${sNum}`);
    const res = await getSeasonEpisodesList(title, sNum);

    if (!res || !res.found || res.episodes.length === 0) {
        return { success: false, message: `NOT_FOUND: No episodes found for "${title}" Season ${sNum}` };
    }

    return {
        success: true,
        message: `SEASON_EPISODES: Found ${res.episodes.length} episodes for "${title}" Season ${sNum}`,
        data: { title, season: sNum, episodes: res.episodes }
    };
}

/**
 * 9. CHECK JELLYFIN
 */
export async function toolCheckJellyfin(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title, type, year } = args;
    if (!title) return { success: false, message: "Title is required" };

    const harness = safeHarness();
    harness.logActivity(`[JELLYFIN] Checking: "${title}" (${type || "any"})`);

    if (type === "series") {
        const jf = await checkSeriesExists(title);
        return { success: true, message: jf.exists ? `IN_JELLYFIN: "${title}" exists in series library` : `NOT_IN_JELLYFIN: "${title}" not found`, data: jf };
    } else {
        const jf = await checkMovieExists(title, year || "");
        return { success: true, message: jf.exists ? `IN_JELLYFIN: "${title}" exists in movie library` : `NOT_IN_JELLYFIN: "${title}" not found`, data: jf };
    }
}

/**
 * 10. LIST DOWNLOADS
 */
export async function toolListDownloads(): Promise<ToolResult> {
    try {
        const downloads = await db
            .select()
            .from(schema.downloads)
            .orderBy(desc(schema.downloads.createdAt))
            .limit(10);

        return {
            success: true,
            message: `RECENT_DOWNLOADS: ${downloads.length} items found`,
            data: { downloads }
        };
    } catch (err: any) {
        return { success: false, message: `DB_ERROR: ${err.message}` };
    }
}

/**
 * 11. REQUEST MEDIA TOOL
 */
export async function toolRequestMedia(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title, type, year, season, episode } = args;
    if (!title) return { success: false, message: "Title is required" };

    const harness = safeHarness();
    const cleaned = cleanMediaTitle(title);
    const cleanTitle = cleaned.title || title.trim();
    const cleanYear = year || cleaned.year || "";
    const mediaType = type === "series" ? "series" : "movie";

    try {
        await db.insert(schema.requestedMedia).values({
            title: cleanTitle,
            type: mediaType,
            year: cleanYear || null,
            season: season ? Number(season) : null,
            episode: episode ? Number(episode) : null,
            status: "requested",
            requestedBy: sessionId,
        });

        harness.logActivity(`[REQUEST] Added to requested media: "${cleanTitle}" (${mediaType})`);
        return {
            success: true,
            message: `MEDIA_REQUESTED: Added "${cleanTitle}" to requested media list.`,
            data: { title: cleanTitle, type: mediaType, year: cleanYear }
        };
    } catch (e: any) {
        return { success: false, message: `Failed to record request: ${e.message}` };
    }
}

/**
 * 12. BOT AUTHENTICATION TOOLS
 */
export async function toolBotReconnect(): Promise<ToolResult> {
    const harness = safeHarness();
    harness.logActivity("[BOT] Reconnect requested");
    const res = await startWebAuth();
    return { success: res.ok, message: res.ok ? "BOT_RECONNECT_INITIATED" : `BOT_RECONNECT_FAILED: ${res.error || ""}` };
}

export async function toolBotAuthPhone(args: Record<string, any>): Promise<ToolResult> {
    const { phone } = args;
    if (!phone) return { success: false, message: "Phone number required" };
    const res = await submitPhone(phone);
    return { success: res.ok, message: res.ok ? "PHONE_SUBMITTED" : `PHONE_FAILED: ${res.error || ""}` };
}

export async function toolBotAuthCode(args: Record<string, any>): Promise<ToolResult> {
    const { code } = args;
    if (!code) return { success: false, message: "Code required" };
    const res = await submitCode(code);
    return { success: res.ok, message: res.ok ? "CODE_SUBMITTED" : `CODE_FAILED: ${res.error || ""}` };
}

export async function toolBotAuthPassword(args: Record<string, any>): Promise<ToolResult> {
    const { password } = args;
    if (!password) return { success: false, message: "Password required" };
    const res = await submitPassword(password);
    return { success: res.ok, message: res.ok ? "PASSWORD_SUBMITTED" : `PASSWORD_FAILED: ${res.error || ""}` };
}

export async function toolBotAuthStatus(): Promise<ToolResult> {
    const connected = isBotConnected();
    const state = getAuthState();
    return {
        success: true,
        message: connected ? "CONNECTED" : `NOT_CONNECTED:${state.step}`,
        data: { connected, ...state }
    };
}

// ─── UNIFIED TOOL EXECUTION DISPATCHER ───

export async function executeTool(toolName: string, args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const harness = safeHarness();

    try {
        switch (toolName) {
            case "tmdb_search":
                return await toolTmdbSearch(args, sessionId);

            case "get_series_seasons":
                return await toolGetSeriesSeasons(args, sessionId);

            case "get_season_episodes":
                return await toolGetSeasonEpisodes(args, sessionId);

            case "search_series":
                return await toolSearchSeries(args, sessionId);

            case "download_series":
            case "download_season":
                return await toolDownloadSeries(args, sessionId);

            case "search_movie":
                return await toolSearchMovie(args, sessionId);

            case "download_movie":
                return await toolDownloadMovie(args, sessionId);

            case "download_episode":
                return await toolDownloadEpisode(args, sessionId);

            case "check_jellyfin":
                return await toolCheckJellyfin(args, sessionId);

            case "list_downloads":
                return await toolListDownloads();

            case "request_media":
                return await toolRequestMedia(args, sessionId);

            case "bot_reconnect":
                return await toolBotReconnect();

            case "bot_auth_phone":
                return await toolBotAuthPhone(args);

            case "bot_auth_code":
                return await toolBotAuthCode(args);

            case "bot_auth_password":
                return await toolBotAuthPassword(args);

            case "bot_auth_status":
                return await toolBotAuthStatus();

            default:
                return { success: false, message: `UNKNOWN_TOOL: "${toolName}" is not a recognized tool.` };
        }
    } catch (err: any) {
        harness.logError(`[TOOL] Execution error in "${toolName}": ${err.message}`);
        return { success: false, message: `TOOL_ERROR in "${toolName}": ${err.message}` };
    }
}

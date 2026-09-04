import { getHarness } from "../../../command/harness.js";
import { db, schema } from "../../common/db/index.js";
import { desc, eq } from "drizzle-orm";
import { checkMovieExists, checkSeriesExists } from "../../common/jellyfin/client.js";
import { downloadQueue, secureBotFileToSavedMessages } from "../queue/queue.js";
import { isBotConnected, ensureBotConnected, getAuthState, submitPhone, submitCode, submitPassword, startWebAuth } from "../bot/bot.js";
import { webSearch, pickBestResult, groupByEpisode, getSeriesInfo, isAllowedDownloadLanguage, checkResolutionHarnessRule } from "../ai/brain.js";
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
    pagedResults?: { globalIndex: number; text: string; sizeMB: number; page: number; row: number; col: number }[];
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
3. **LANGUAGE RESTRICTIONS (CRITICAL)**: Only movies in **Hindi**, **Bengali**, and **English** (or Dual/Multi Audio containing any of these) are allowed for download! If the user tries to download a release in any other language (e.g. Malayalam, Telugu, Tamil, Kannada, Punjabi, Marathi, etc. without Hindi/Bengali/English), you MUST state:
   "⚠️ **Download Not Allowed**: You can't download this movie release. Only **Hindi**, **Bengali**, and **English** (or Dual/Multi Audio) languages are supported for download."
4. **HARNESS RESOLUTION RULE (>720p WARNING)**: Always prioritize and recommend the **720p** release. If the user chooses or downloads a release higher than 720p (such as **1080p** or **4K**), you MUST warn them:
   "⚠️ *Warning: Downloading releases higher than 720p multiple times puts heavy load on server bandwidth and can lead to your account being banned.*"
5. When the user confirms with "yes", "download", "download recommend", or chooses an option number (e.g. "1", "2", "5", "15", "download 5"), call 'download_movie' with the corresponding optionIndex.

## 2-STEP WORKFLOW:

### STEP 1: MOVIE SEARCH & PRESENTATION
- When the user asks about a movie (e.g., "Fidaa", "Miss You 2024", "Inception", "Interstellar"):
  - Call 'search_movie' with title and optional year.
  - In your response:
    - State how many total releases were found across all pages.
    - Highlight your recommended release (Option #X) and explicitly mention its language (e.g. "Hindi Dubbed" or "Dual Audio (Hindi + Telugu)" or "1080p FHD"), quality, and why it is recommended.
    - Inform the user that all available files are listed below with instant download buttons, and they can either click any button or type the option number (e.g. "5", "download 12", "yes").

### STEP 2: DOWNLOAD EXECUTION
- When the user selects or confirms an option (e.g. "5", "download 5", "yes", "download recommend", "15"):
  - Call 'download_movie' passing title, year, and optionIndex (e.g. {"tool": "download_movie", "args": {"title": "Miss You", "year": "2024", "optionIndex": 5}}).

## RULES:
1. NEVER display raw JSON in your final conversational response. Use clean, beautiful Markdown.
2. If you need to perform an action, output ONLY ONE JSON tool call in format: {"tool": "tool_name", "args": {"key": "value"}}.
3. If any tool returns a message starting with "BOT_DISCONNECTED", immediately inform the user:
   "⚠️ **Telegram Bot is currently disconnected.** Please navigate to the **Telegram Bot** tab in the left sidebar and click **Reconnect** to re-authenticate, then try your search again! 🤖"

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

    let connected = isBotConnected();
    if (!connected) {
        connected = await ensureBotConnected();
    }
    if (!connected) {
        return {
            success: false,
            message: "BOT_DISCONNECTED: Telegram Bot is currently disconnected. Please navigate to the Telegram Bot tab in the sidebar and click Reconnect."
        };
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

    // Crawl all available result pages using the NEXT button (up to 10 pages)
    const allResults: { globalIndex: number; text: string; sizeMB: number; page: number; row: number; col: number }[] = [];
    const seenTexts = new Set<string>();
    let currentMsg = btnMsg;
    const MAX_PAGES = 10;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        let buttons: any[][] = [];
        try {
            buttons = (await currentMsg.getButtons()) || [];
        } catch {
            break;
        }

        let nextBtn: any = null;

        for (let r = 0; r < buttons.length; r++) {
            for (let c = 0; c < buttons[r].length; c++) {
                const btn = buttons[r][c] as any;
                const text = (btn?.text || "").trim();
                if (!text) continue;

                const lower = text.toLowerCase();
                const isNav =
                    lower.includes("next") ||
                    lower.includes("prev") ||
                    lower.includes("page") ||
                    lower.includes("back") ||
                    lower.includes("close") ||
                    lower.includes("update") ||
                    lower.includes("channel") ||
                    /^\s*(⬅️|➡️|◀️|▶️|<<|>>|\d+\/\d+)/i.test(lower) ||
                    /\[\d+\/\d+\]/.test(lower);

                if (isNav) {
                    if (
                        lower.includes("next") ||
                        lower.includes("➡️") ||
                        lower.includes("▶️") ||
                        lower.includes(">>") ||
                        (/\[\d+\/\d+\]/.test(lower) && !lower.includes("prev") && !lower.includes("⬅️"))
                    ) {
                        const pageMatch = lower.match(/\[(\d+)\/(\d+)\]/);
                        if (pageMatch && parseInt(pageMatch[1], 10) >= parseInt(pageMatch[2], 10)) {
                            // Last page reached
                        } else {
                            nextBtn = btn;
                        }
                    }
                    continue;
                }

                if (lower.includes("srt") || lower.includes("sub") || lower.includes(".txt") || lower.includes(".zip")) continue;

                const sizeMB = extractSizeMB(text);
                if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;

                if (!seenTexts.has(text)) {
                    seenTexts.add(text);
                    allResults.push({
                        globalIndex: allResults.length + 1,
                        text,
                        sizeMB,
                        page: pageNum,
                        row: r,
                        col: c,
                    });
                }
            }
        }

        // If there's a NEXT button and we haven't reached page limit, click it
        if (nextBtn && pageNum < MAX_PAGES) {
            try {
                harness.logActivity(`[TOOL search_movie] Clicking NEXT button (Page ${pageNum} -> ${pageNum + 1})...`);
                await nextBtn.click({});
                await new Promise(r => setTimeout(r, 1600));

                const messages = await botClient.getMessages("ProSearchM11Bot", { ids: [btnMsg.id] });
                if (messages && messages[0]) {
                    currentMsg = messages[0];
                } else {
                    break;
                }
            } catch (clickErr: any) {
                harness.logActivity(`[TOOL search_movie] Failed to click NEXT: ${clickErr?.message}`);
                break;
            }
        } else {
            break;
        }
    }

    if (allResults.length === 0) {
        logTelegramAudit({
            action: "NO_RESULTS",
            bot: "ProSearchM11Bot",
            query,
            caller: "search_movie",
            details: { reason: "No valid video options found across all pages" }
        });
        return { success: true, message: `NO_RESULTS:${cleanTitle}`, data: { results: [] } };
    }

    logTelegramAudit({
        action: "RECEIVE_RESPONSE",
        bot: "ProSearchM11Bot",
        query,
        responseMsgId: btnMsg.id,
        resultsCount: allResults.length,
        resultsPreview: allResults.map(r => `[#${r.globalIndex} P${r.page}] ${r.text}`),
        caller: "search_movie"
    });

    const sessionKey = `movie_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sessionData = {
        bot: "ProSearchM11Bot",
        btnMsgId: btnMsg.id,
        btnMsg,
        results: allResults.map(r => ({ text: r.text, sizeMB: r.sizeMB, globalIndex: r.globalIndex, page: r.page })),
        pagedResults: allResults,
        grouped: [],
        title: cleanTitle,
        type: "movie",
        year: cleanYear,
        createdAt: Date.now()
    };
    searchSessions.set(sessionKey, sessionData);
    if (sessionId) searchSessions.set(`session_${sessionId}`, sessionData);
    searchSessions.set(`title_${cleanTitle.toLowerCase().trim()}`, sessionData);

    const best = await pickBestResult(cleanTitle, "movie", allResults);
    setWorkflow(sessionId, { step: "telegram_searched", type: "movie", title: cleanTitle, year: cleanYear });

    return {
        success: true,
        message: `MOVIE_RESULTS:${allResults.length} releases found across all pages for "${cleanTitle}"`,
        data: {
            results: allResults.map((r, i) => ({
                index: r.globalIndex,
                text: r.text,
                sizeMB: r.sizeMB,
                page: r.page,
                isBest: i === best.index,
                reason: i === best.index ? best.reason : ""
            })),
            bestIdx: best.index + 1,
            totalResults: allResults.length,
            sessionKey,
            title: cleanTitle,
            year: cleanYear
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
    let targetPage = 1;
    let targetBtnRow: number | undefined;
    let targetBtnCol: number | undefined;

    if (session && session.pagedResults && session.pagedResults.length > 0) {
        let chosenPaged: typeof session.pagedResults[0] | undefined;
        if (typeof optionIndex === "number" && optionIndex >= 1 && optionIndex <= session.pagedResults.length) {
            chosenPaged = session.pagedResults[optionIndex - 1];
        } else if (targetBtnText) {
            chosenPaged = session.pagedResults.find(p => p.text === targetBtnText || p.text.toLowerCase().includes(targetBtnText.toLowerCase()));
        } else {
            const best = await pickBestResult(targetTitle, "movie", session.pagedResults);
            chosenPaged = session.pagedResults[best.index];
        }

        if (chosenPaged) {
            targetBtnText = chosenPaged.text;
            resolvedOptIdx = chosenPaged.globalIndex;
            targetPage = chosenPaged.page;
            targetBtnRow = chosenPaged.row;
            targetBtnCol = chosenPaged.col;
            exactFileSize = chosenPaged.sizeMB >= 1024
                ? `${(chosenPaged.sizeMB / 1024).toFixed(2)} GB`
                : `${chosenPaged.sizeMB.toFixed(0)} MB`;
        }
    } else if (session && session.results && session.results.length > 0) {
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

    // ─── HARNESS RULE 1: LANGUAGE RESTRICTION CHECK (ONLY BENGALI, HINDI, ENGLISH ALLOWED) ───
    const langCheck = isAllowedDownloadLanguage(targetBtnText || targetTitle);
    if (!langCheck.allowed) {
        harness.logActivity(`[HARNESS RULE BLOCKED] Disallowed language "${langCheck.detectedLanguage}" for movie "${targetTitle}"`);
        return {
            success: false,
            message: `LANGUAGE_NOT_SUPPORTED: You can't download this movie release (${langCheck.detectedLanguage}). Only **Hindi**, **Bengali**, and **English** (or Dual/Multi Audio) languages are supported for download.`,
            data: { allowed: false, language: langCheck.detectedLanguage }
        };
    }

    // ─── HARNESS RULE 2: RESOLUTION CHECK (>720p BAN WARNING) ───
    const resCheck = checkResolutionHarnessRule(targetBtnText || "");
    if (resCheck.isHighRes) {
        harness.logActivity(`[HARNESS RULE WARNING] High resolution download (${resCheck.resolution}) queued for "${targetTitle}" - Ban warning issued.`);
    }

    // Attempt to pre-secure the file into Saved Messages immediately
    let securedInfo: { savedMsgId: number; fileName: string; totalSize: number } | null = null;
    try {
        const msgToClick = session?.btnMsg;
        if (msgToClick) {
            securedInfo = await secureBotFileToSavedMessages(
                session?.bot || "ProSearchM11Bot",
                msgToClick,
                targetBtnText,
                targetPage,
                targetBtnRow,
                targetBtnCol
            );
        }
    } catch (secErr: any) {
        console.log(`[QUEUE] Pre-secure notice: ${secErr?.message || secErr}`);
    }
    // ─── DEDUPLICATION GUARD: Prevent duplicate downloads for same movie within 60s ───
    try {
        const existingActive = await db.query.downloads.findFirst({
            where: (d, { eq, and, or, gte }) => and(
                eq(d.title, targetTitle),
                or(eq(d.status, "queued"), eq(d.status, "downloading")),
                gte(d.createdAt, new Date(Date.now() - 60 * 1000))
            )
        });
        if (existingActive) {
            harness.logActivity(`[TOOL download_movie] Already queued/downloading "${targetTitle}" (requestId: ${existingActive.requestId}). Reusing existing download.`);
            return {
                success: true,
                message: `MOVIE_DOWNLOAD_QUEUED: "${targetTitle}" (${existingActive.fileSize || fileSize}) is already in the download queue.`,
                data: { requestId: existingActive.requestId, title: targetTitle, fileSize: existingActive.fileSize || fileSize }
            };
        }
    } catch {}

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
            page: targetPage,
            buttonRow: targetBtnRow,
            buttonCol: targetBtnCol,
            savedMsgId: securedInfo?.savedMsgId,
            fileName: securedInfo?.fileName,
            fileSizeBytes: securedInfo?.totalSize,
        });

        try { broadcastNewDownload({ jobId: requestId, title: targetTitle, type: "movie", requestedBy: "ai" }); } catch {}
        harness.logActivity(`[QUEUE] Queued movie "${targetTitle}" (Option #${resolvedOptIdx || "auto"} P${targetPage}: ${targetBtnText || fileSize}) [SavedMsgId: ${securedInfo?.savedMsgId || "pending"}]`);

        let responseMsg = `MOVIE_DOWNLOAD_QUEUED: "${targetTitle}" (${fileSize}) added to download queue`;
        if (resCheck.isHighRes && resCheck.warningMessage) {
            responseMsg += `\n\n${resCheck.warningMessage}`;
        }

        return {
            success: true,
            message: responseMsg,
            data: { requestId, title: targetTitle, fileSize, optionIndex: resolvedOptIdx, page: targetPage, buttonText: targetBtnText, warning: resCheck.isHighRes ? resCheck.warningMessage : null }
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

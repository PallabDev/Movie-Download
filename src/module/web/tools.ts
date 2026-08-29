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

export const SYSTEM_PROMPT = `You are an expert movie & TV series download copilot connected to The Movie Database (TMDB) and Telegram bots (@ProSearchM11Bot and @ProSearchY11Bot).

## 2-STEP WORKFLOW:

### STEP 1: TMDB SEARCH & PRESENTATION (Initial User Query)
- When the user asks about a movie or series (e.g., "Eken Babu", "Eken Babu download", "Bajrangi Bhaijaan 2015"):
  - For TV Series: Call 'search_series' (or 'tmdb_search').
    - Displays canonical title, year, synopsis, genres, and a verified Markdown table of ALL Seasons with exact episode counts from TMDB (e.g. Seasons 1 to 9, 60 total episodes).
    - Then prompts the user: "Which season or episodes would you like me to download? (e.g. **Download Season 1**, **Download Season 5**, **Download Seasons 6, 7, 8, 9**, **Download S01E01**, or **Download All**)".
  - For Movies: Call 'search_movie'.
    - Validates release on TMDB, checks Jellyfin, queries Telegram @ProSearchM11Bot, and displays available quality releases (1080p, 720p).

### STEP 2: DOWNLOAD EXECUTION (User Confirms Selection)
- When the user selects or confirms a season, episode, or download (e.g., "Download Season 5", "Download Seasons 6, 7, 8, 9", "Download all", "1", "S01E01"):
  - Call 'download_series' passing the title and requested seasons (e.g. {"tool": "download_series", "args": {"title": "Eken Babu", "seasons": [5]}}).
  - The engine prepares all exact episode queries (e.g. "Eken Babu S05E01" through "Eken Babu S05E06"), queries @ProSearchY11Bot episode-by-episode, picks the best video release, clicks the button, and queues each episode directly into the download queue!
  - For movies: Call 'download_movie'.

## RULES:
1. NEVER claim seasons or episodes are missing from Telegram unless you specifically queried those exact episodes and received 0 results.
2. NEVER display raw JSON in your final conversational response. Use clean, beautiful Markdown tables, bullet points, and emojis.
3. If you need to perform an action, output ONLY ONE JSON tool call in format: {"tool": "tool_name", "args": {"key": "value"}}.

## AVAILABLE TOOLS:

### search_series(title)
Searches TMDB for the canonical TV series details, total seasons, synopsis, and exact per-season episode breakdown.
- title: e.g. "Eken Babu", "Stranger Things"

### download_series(title, season, seasons, episode)
Searches Telegram @ProSearchY11Bot episode-by-episode ("Title SXXEXX") for the requested seasons, clicks the best video release, and queues downloads.
- title: e.g. "Eken Babu"
- seasons: optional array of season numbers, e.g. [5] or [6, 7, 8, 9]
- season: optional season number, e.g. 5
- episode: optional episode number, e.g. 1

### search_movie(title, year)
Searches TMDB and Telegram @ProSearchM11Bot for movie releases.
- title: e.g. "Bajrangi Bhaijaan", "Inception"
- year: optional release year, e.g. "2015"

### download_movie(title, year, buttonText, sessionId)
Downloads a specific movie release.

### download_episode(title, season, episode, buttonText, sessionId)
Downloads a single episode.

### tmdb_search(query)
Direct TMDB search for movies or series.

### get_series_seasons(title)
Get the exact number of seasons and per-season episode counts from TMDB.

### get_season_episodes(title, season)
Get the episode list for a specific season from TMDB.

### check_jellyfin(title, type, year)
Checks if content is already in the Jellyfin media library.

### list_downloads
List recent downloads and active queue status.
`;

// ─── TOOL IMPLEMENTATIONS ───

/**
 * 1. SEARCH SERIES (TMDB Lookup & Season Breakdown)
 */
export async function toolSearchSeries(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title } = args;
    if (!title) return { success: false, message: "Title is required" };

    const harness = safeHarness();
    const cleaned = cleanMediaTitle(title);
    let baseTitle = cleaned.title || title.trim();

    const wf = getWorkflow(sessionId);
    if (wf && wf.title && (/^(1|2|3|4|5|6|7|8|9|s\d+|season\s*\d+|series|all|option\s*\d+)$/i.test(title.trim()) || baseTitle.length <= 2)) {
        baseTitle = wf.title;
    }

    harness.logActivity(`[TOOL search_series] Looking up TMDB metadata for: "${baseTitle}"`);

    const tmdbDetails = await lookupMedia(baseTitle);
    const seriesInfo = await getSeriesInfo(baseTitle);

    const totalSeasons = seriesInfo?.seasons || tmdbDetails?.totalSeasons || 1;
    const episodesPerSeason = seriesInfo?.episodesPerSeason || tmdbDetails?.episodesPerSeason || [10];
    const totalEpisodes = episodesPerSeason.reduce((a, b) => a + b, 0);

    setWorkflow(sessionId, {
        step: "web_searched",
        type: "series",
        title: baseTitle,
        year: tmdbDetails?.year || "",
    });

    const seasonsBreakdown = [];
    for (let s = 1; s <= totalSeasons; s++) {
        seasonsBreakdown.push({
            season: s,
            episodes: episodesPerSeason[s - 1] || 10,
        });
    }

    return {
        success: true,
        message: `TMDB_SERIES_DETAILS: Found TV series "${baseTitle}" (${tmdbDetails?.year || "Series"}) with ${totalSeasons} seasons (${totalEpisodes} total episodes). Output the full TMDB seasons table and ask user which season to download. DO NOT QUERY TELEGRAM YET.`,
        data: {
            step: "tmdb_presentation",
            title: baseTitle,
            year: tmdbDetails?.year || "",
            overview: tmdbDetails?.overview || "",
            genres: tmdbDetails?.genres || [],
            totalSeasons,
            totalEpisodes,
            episodesPerSeason,
            seasons: seasonsBreakdown,
        }
    };
}

/**
 * 2. DOWNLOAD SERIES (Episode-by-Episode Telegram Search & Direct Queueing)
 */
export async function toolDownloadSeries(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    let { title, season, seasons, episode } = args;
    if (!title) return { success: false, message: "Title is required" };

    const harness = safeHarness();

    if (!isBotConnected()) {
        return { success: false, message: "BOT_DISCONNECTED: Please connect the Telegram bot first." };
    }

    const cleaned = cleanMediaTitle(title);
    let baseTitle = cleaned.title || title.replace(/\s+(?:S\d+.*|Season\s*\d+.*)$/i, "").trim() || title;

    const wf = getWorkflow(sessionId);
    if (wf && wf.title && (/^(1|2|3|4|5|6|7|8|9|s\d+|season\s*\d+|series|all|option\s*\d+)$/i.test(title.trim()) || baseTitle.length <= 2)) {
        baseTitle = wf.title;
    }

    // Extract exact seasons and episode targets
    const targetSeasons: number[] = [];
    let targetEpisode: number | undefined = episode ? Number(episode) : undefined;

    if (Array.isArray(seasons)) {
        targetSeasons.push(...seasons.map(Number).filter(n => !isNaN(n) && n > 0));
    } else if (typeof seasons === "string") {
        const matches = seasons.match(/\d+/g);
        if (matches) targetSeasons.push(...matches.map(Number));
    } else if (season) {
        const sNum = typeof season === "number" ? season : parseInt(String(season), 10);
        if (!isNaN(sNum) && sNum > 0) targetSeasons.push(sNum);
    } else {
        const epMatch = title.match(/(?:\[|\b)S(\d{1,2})[\s._-]*E(\d{1,2})(?:\]|\b)/i) ||
                       title.match(/Season\s*(\d{1,2})\s*Episode\s*(\d{1,2})/i);
        if (epMatch) {
            targetSeasons.push(parseInt(epMatch[1], 10));
            targetEpisode = parseInt(epMatch[2], 10);
        } else if (/\ball\b/i.test(title)) {
            // Handled below with full TMDB season count
        } else {
            const multiMatch = title.match(/(?:seasons?|s)\s*([\d\s,–\-and]+)/i);
            if (multiMatch) {
                const nums = multiMatch[1].match(/\d+/g);
                if (nums) targetSeasons.push(...nums.map(Number));
            } else if (cleaned.season) {
                targetSeasons.push(cleaned.season);
            } else {
                const singleSMatch = title.match(/\bS(\d{1,2})\b/i) || title.match(/\bSeason\s*(\d{1,2})\b/i);
                if (singleSMatch) {
                    targetSeasons.push(parseInt(singleSMatch[1], 10));
                } else if (/^\d{1,2}$/.test(title.trim())) {
                    targetSeasons.push(parseInt(title.trim(), 10));
                }
            }
        }
    }

    const botClient = (await import("../bot/bot.js")).default;
    const seriesInfo = await getSeriesInfo(baseTitle);

    // If no seasons specified, default to Season 1 or all if "all" in title
    if (targetSeasons.length === 0) {
        if (/\ball\b/i.test(title)) {
            const totalS = seriesInfo.seasons || 1;
            for (let i = 1; i <= totalS; i++) targetSeasons.push(i);
        } else {
            targetSeasons.push(1);
        }
    }

    const queryBot = async (queryText: string, seasonCtx: number, episodeCtx: number) => {
        harness.logActivity(`[TOOL download_series] Querying @ProSearchY11Bot for: "${queryText}"`);
        try {
            const sent = await botClient.sendMessage("ProSearchY11Bot", { message: queryText });
            logTelegramAudit({
                action: "SEND_QUERY",
                bot: "ProSearchY11Bot",
                query: queryText,
                sentMsgId: sent.id,
                caller: "download_series"
            });

            let btnMsg: any = null;

            for (let attempt = 0; attempt < 4; attempt++) {
                await new Promise(r => setTimeout(r, 1500));
                const messages = await botClient.getMessages("ProSearchY11Bot", { limit: 10 });
                for (const msg of messages) {
                    if (msg.id <= sent.id) continue;

                    const buttons = await msg.getButtons();
                    if (buttons && buttons.length > 0) {
                        btnMsg = msg;
                        break;
                    }

                    const text = msg.message || "";
                    if (text.toLowerCase().includes("no results found") || text.toLowerCase().includes("not found")) {
                        logTelegramAudit({
                            action: "NO_RESULTS",
                            bot: "ProSearchY11Bot",
                            query: queryText,
                            caller: "download_series",
                            details: { botReply: text }
                        });
                        return { btnMsg: null, results: [] };
                    }
                }
                if (btnMsg) break;
            }

            if (!btnMsg) {
                logTelegramAudit({
                    action: "NO_RESULTS",
                    bot: "ProSearchY11Bot",
                    query: queryText,
                    caller: "download_series",
                    details: { reason: "No buttons message received within timeout" }
                });
                return { btnMsg: null, results: [] };
            }

            const buttons = (await btnMsg.getButtons())!;
            const res: { text: string; sizeMB: number; btnMsg: any; btnMsgId: number; season: number; episode: number }[] = [];
            for (const row of buttons) {
                for (const btn of row) {
                    const text = (btn as any).text || "";
                    if (!text) continue;
                    const lower = text.toLowerCase();
                    if (lower.includes("srt") || lower.includes("sub")) continue;
                    const sizeMB = extractSizeMB(text);
                    if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;
                    res.push({
                        text,
                        sizeMB,
                        btnMsg,
                        btnMsgId: btnMsg.id,
                        season: seasonCtx,
                        episode: episodeCtx
                    });
                }
            }

            logTelegramAudit({
                action: "RECEIVE_RESPONSE",
                bot: "ProSearchY11Bot",
                query: queryText,
                responseMsgId: btnMsg.id,
                resultsCount: res.length,
                resultsPreview: res.map(r => r.text),
                caller: "download_series"
            });

            return { btnMsg, results: res };
        } catch (e: any) {
            logTelegramAudit({
                action: "ERROR",
                bot: "ProSearchY11Bot",
                query: queryText,
                caller: "download_series",
                details: { error: e.message }
            });
            harness.logError(`[TOOL download_series] Error for "${queryText}": ${e.message}`);
            return { btnMsg: null, results: [] };
        }
    };

    const allFound: { text: string; sizeMB: number; season: number; episode: number }[] = [];
    const queuedEpisodes: { requestId: string; epLabel: string; buttonText: string; fileSize: string }[] = [];
    let primaryBtnMsg: any = null;

    const queueEpisodeDownload = async (s: number, e: number, epResults: any[]) => {
        if (epResults.length === 0) return null;
        const epLabel = e > 0 
            ? `${baseTitle} S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`
            : `${baseTitle} S${String(s).padStart(2, "0")} (COMBINED)`;

        const prefer720 = epResults.find(r => r.text.toLowerCase().includes("720p") && !r.text.toLowerCase().includes("srt"));
        const prefer1080 = epResults.find(r => r.text.toLowerCase().includes("1080p") && !r.text.toLowerCase().includes("srt"));
        const bestBtn = prefer1080 || prefer720 || epResults[0];

        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const sizeMatch = bestBtn.text.match(/\[([\d.]+)\s*(GB|MB)\]/i);
        const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : (bestBtn.sizeMB > 0 ? `${bestBtn.sizeMB.toFixed(0)} MB` : "500 MB");

        try {
            await db.insert(schema.downloads).values({
                requestId,
                title: epLabel,
                type: "series",
                status: "queued",
                season: s,
                episode: e > 0 ? e : null,
                fileSize,
            });

            downloadQueue.addJob({
                requestId,
                bot: "ProSearchY11Bot",
                btnMsgId: bestBtn.btnMsgId,
                type: "series",
                title: epLabel,
                season: s,
                episode: e > 0 ? e : undefined,
                fileSize,
                buttonText: bestBtn.text,
            });

            logTelegramAudit({
                action: "QUEUE_DOWNLOAD",
                bot: "ProSearchY11Bot",
                query: epLabel,
                selectedButton: bestBtn.text,
                caller: "download_series",
                details: { requestId, fileSize, isCombined: e === 0 }
            });

            try { broadcastNewDownload({ jobId: requestId, title: epLabel, type: "series", requestedBy: "ai" }); } catch {}
            harness.logActivity(`[QUEUE] Auto-queued "${epLabel}" (${bestBtn.text})`);
            return { requestId, epLabel, buttonText: bestBtn.text, fileSize };
        } catch (err: any) {
            harness.logError(`[QUEUE] Error auto-queuing "${epLabel}": ${err.message}`);
            return null;
        }
    };

    harness.logActivity(`[TOOL download_series] Target seasons for "${baseTitle}": [${targetSeasons.join(", ")}]`);

    for (const s of targetSeasons) {
        const epCount = seriesInfo.episodesPerSeason?.[s - 1] || 10;
        const seasonTag = `S${String(s).padStart(2, "0")}`;

        if (targetEpisode) {
            const sTag = `${seasonTag}E${String(targetEpisode).padStart(2, "0")}`;
            const queryText = `${baseTitle} ${sTag}`;
            const res = await queryBot(queryText, s, targetEpisode);
            if (res.results.length > 0) {
                allFound.push(...res.results.map(r => ({ text: r.text, sizeMB: r.sizeMB, season: s, episode: targetEpisode! })));
                if (!primaryBtnMsg) primaryBtnMsg = res.btnMsg;
                // Pacing delay: wait 2.5s after bot replies before queuing/clicking
                await new Promise(r => setTimeout(r, 2500));
                const q = await queueEpisodeDownload(s, targetEpisode, res.results);
                if (q) queuedEpisodes.push(q);
            }
        } else {
            // ─── CHECK FOR COMBINED SEASON PACK FIRST ───
            const seasonQuery = `${baseTitle} ${seasonTag}`;
            harness.logActivity(`[TOOL download_series] Checking for COMBINED season pack for "${seasonQuery}"...`);
            const seasonRes = await queryBot(seasonQuery, s, 0);

            const combinedOptions = seasonRes.results.filter(r => {
                const tLower = r.text.toLowerCase();
                return tLower.includes("combined") || (tLower.includes(seasonTag.toLowerCase()) && !/e\d{1,2}/i.test(tLower));
            });

            if (combinedOptions.length > 0) {
                const prefer1080 = combinedOptions.find(r => r.text.toLowerCase().includes("1080p") && !r.text.toLowerCase().includes("srt"));
                const prefer720 = combinedOptions.find(r => r.text.toLowerCase().includes("720p") && !r.text.toLowerCase().includes("srt"));
                const bestCombined = prefer1080 || prefer720 || combinedOptions[0];

                allFound.push({ text: bestCombined.text, sizeMB: bestCombined.sizeMB, season: s, episode: 0 });
                if (!primaryBtnMsg) primaryBtnMsg = seasonRes.btnMsg;

                await new Promise(r => setTimeout(r, 2500));
                const q = await queueEpisodeDownload(s, 0, [bestCombined]);
                if (q) queuedEpisodes.push(q);

                harness.logActivity(`[COMBINED PACK] Season ${s} found combined pack ("${bestCombined.text}"). Queued entire season in 1 file!`);
                // Safe pacing delay before next season (4 seconds)
                await new Promise(r => setTimeout(r, 4000));
                continue; // Skip individual episode downloads for this season
            }

            // ─── NO COMBINED PACK FOUND: DOWNLOAD EPISODE-BY-EPISODE ───
            for (let e = 1; e <= epCount; e++) {
                const sTag = `${seasonTag}E${String(e).padStart(2, "0")}`;
                const queryText = `${baseTitle} ${sTag}`;
                const res = await queryBot(queryText, s, e);
                if (res.results.length > 0) {
                    allFound.push(...res.results.map(r => ({ text: r.text, sizeMB: r.sizeMB, season: s, episode: e })));
                    if (!primaryBtnMsg) primaryBtnMsg = res.btnMsg;
                    // Pacing delay: wait 2.5s after bot replies before queuing/clicking
                    await new Promise(r => setTimeout(r, 2500));
                    const q = await queueEpisodeDownload(s, e, res.results);
                    if (q) queuedEpisodes.push(q);
                } else {
                    // Fallback query format: "Title Season X Episode Y"
                    const altQuery = `${baseTitle} Season ${s} Episode ${e}`;
                    const altRes = await queryBot(altQuery, s, e);
                    if (altRes.results.length > 0) {
                        allFound.push(...altRes.results.map(r => ({ text: r.text, sizeMB: r.sizeMB, season: s, episode: e })));
                        if (!primaryBtnMsg) primaryBtnMsg = altRes.btnMsg;
                        await new Promise(r => setTimeout(r, 2500));
                        const q = await queueEpisodeDownload(s, e, altRes.results);
                        if (q) queuedEpisodes.push(q);
                    }
                }
                // Safe pacing delay between consecutive episode searches (4 seconds)
                harness.logActivity(`[PACING] Waiting 4s before searching next episode...`);
                await new Promise(r => setTimeout(r, 4000));
            }
        }
    }

    if (allFound.length === 0 || !primaryBtnMsg) {
        return { success: true, message: `NO_RESULTS:${title}`, data: { results: [], queuedEpisodes: [] } };
    }

    const sessionKey = `series_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    searchSessions.set(sessionKey, {
        bot: "ProSearchY11Bot",
        btnMsgId: primaryBtnMsg.id,
        btnMsg: primaryBtnMsg,
        results: allFound,
        grouped: groupByEpisode(allFound),
        title: baseTitle,
        type: "series",
        year: "",
        createdAt: Date.now()
    });

    setWorkflow(sessionId, { step: "downloading", type: "series", title: baseTitle });

    return {
        success: true,
        message: `SERIES_DOWNLOAD_QUEUED:${allFound.length} releases found, ${queuedEpisodes.length} episodes queued for download.`,
        data: {
            title: baseTitle,
            targetSeasons,
            totalFound: allFound.length,
            queuedEpisodes,
            sessionKey
        }
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
    searchSessions.set(sessionKey, {
        bot: "ProSearchM11Bot", btnMsgId: btnMsg.id, btnMsg, results, grouped: [],
        title: cleanTitle, type: "movie", year: cleanYear, createdAt: Date.now()
    });

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
    const { title, year, buttonText, sessionKey } = args;
    const sKey = sessionKey || args.sessionId;
    const session = sKey ? searchSessions.get(sKey) : null;
    const targetTitle = title || session?.title;

    if (!targetTitle) return { success: false, message: "Title is required for download" };

    const harness = safeHarness();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const sizeMatch = buttonText ? buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i) : null;
    const fileSize = sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : "2.0 GB";

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
            buttonText,
        });

        try { broadcastNewDownload({ jobId: requestId, title: targetTitle, type: "movie", requestedBy: "ai" }); } catch {}
        harness.logActivity(`[QUEUE] Queued movie "${targetTitle}" (${buttonText || "best option"})`);

        return {
            success: true,
            message: `MOVIE_DOWNLOAD_QUEUED: "${targetTitle}" added to download queue`,
            data: { requestId, title: targetTitle, fileSize }
        };
    } catch (err: any) {
        return { success: false, message: `DOWNLOAD_ERROR: ${err.message}` };
    }
}

/**
 * 5. DOWNLOAD EPISODE (Single Episode Download)
 */
export async function toolDownloadEpisode(args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const { title, season, episode, buttonText, sessionKey } = args;
    const sKey = sessionKey || args.sessionId;
    const session = sKey ? searchSessions.get(sKey) : null;
    const targetTitle = title || session?.title;

    if (!targetTitle) return { success: false, message: "Title is required" };

    const harness = safeHarness();
    const s = Number(season) || 1;
    const e = Number(episode) || 1;
    const epLabel = `${targetTitle} S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const sizeMatch = buttonText ? buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i) : null;
    const fileSize = sizeMatch ? `${sizeMatch[1]} ${sizeMatch[2].toUpperCase()}` : "700 MB";

    try {
        await db.insert(schema.downloads).values({
            requestId,
            title: epLabel,
            type: "series",
            status: "queued",
            season: s,
            episode: e,
            fileSize,
        });

        downloadQueue.addJob({
            requestId,
            bot: session?.bot || "ProSearchY11Bot",
            btnMsgId: session?.btnMsgId || 0,
            type: "series",
            title: epLabel,
            season: s,
            episode: e,
            fileSize,
            buttonText,
        });

        try { broadcastNewDownload({ jobId: requestId, title: epLabel, type: "series", requestedBy: "ai" }); } catch {}
        harness.logActivity(`[QUEUE] Queued episode "${epLabel}" (${buttonText || "default"})`);

        return {
            success: true,
            message: `EPISODE_DOWNLOAD_QUEUED: "${epLabel}" added to download queue`,
            data: { requestId, title: epLabel, season: s, episode: e, fileSize }
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
 * 11. BOT AUTHENTICATION TOOLS
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

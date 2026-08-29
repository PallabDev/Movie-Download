import { getHarness } from "../../../command/harness.js";
import { db, schema } from "../../common/db/index.js";
import { desc, eq } from "drizzle-orm";
import { checkMovieExists, checkSeriesExists } from "../../common/jellyfin/client.js";
import { downloadQueue } from "../queue/queue.js";
import { isBotConnected, getAuthState, submitPhone, submitCode, submitPassword, startWebAuth } from "../bot/bot.js";
import { webSearch, pickBestResult, groupByEpisode, getSeriesInfo } from "../ai/brain.js";
import { parseToolCall } from "./tool-parser.js";
import { inngest } from "../inngest/client.js";
import { broadcastNewDownload } from "./ws.js";

interface ToolResult {
    success: boolean;
    message: string;
    data?: any;
}

// ─── AGENT MEMORY (PostgreSQL) ───

async function saveMemory(sessionId: string, role: string, content: string) {
    try {
        await db.insert(schema.agentMemory).values({ sessionId, role, content });
    } catch (err: any) {
        console.error(`[MEMORY] Write error: ${err.message}`);
    }
}

// ─── SEARCH SESSIONS ───

const searchSessions = new Map<string, {
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

function cleanOldSessions() {
    for (const [k, v] of searchSessions) {
        if (Date.now() - v.createdAt > 30 * 60 * 1000) searchSessions.delete(k);
    }
}

// ─── WORKFLOW INGEST STATE MACHINE ───

type WorkflowStep = "idle" | "web_searched" | "telegram_searched" | "user_picked" | "downloading";

const workflowState = new Map<string, {
    step: WorkflowStep;
    type: "movie" | "series" | null;
    title: string;
    year: string;
    webResults: any[];
    sessionId: string;
}>();

function getWorkflow(sessionId: string) {
    return workflowState.get(sessionId);
}

function setWorkflow(sessionId: string, state: Partial<{ step: WorkflowStep; type: "movie" | "series"; title: string; year: string; webResults: any[]; sessionId: string }>) {
    const existing = workflowState.get(sessionId) || { step: "idle" as WorkflowStep, type: null, title: "", year: "", webResults: [], sessionId };
    workflowState.set(sessionId, { ...existing, ...state });
}

function clearWorkflow(sessionId: string) {
    workflowState.delete(sessionId);
}

function detectIntent(message: string): { type: "movie" | "series" | "download" | "other"; title?: string } {
    const lower = message.toLowerCase();

    if (/^(all|s\d+e?\d*|season\s*\d+)/i.test(lower.trim())) {
        return { type: "download" };
    }

    if (/^(yes|yeah|y|ok|okay|download|go|sure|confirm|720p|1080p|option\s*\d+|\d+)/i.test(lower.trim())) {
        return { type: "download" };
    }

    const seriesPatterns = /\b(series|season|episode|ep\b|show|anime|web\s*series|part\s*\d+)/i;
    if (seriesPatterns.test(lower)) {
        return { type: "series" };
    }

    if (lower.length > 2 && !lower.startsWith("/")) {
        return { type: "movie" };
    }

    return { type: "other" };
}

function extractSizeMB(text: string): number {
    const match = text.match(/\[([\d.]+)\s*(GB|MB|KB)\]/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit === "GB") return val * 1024;
    if (unit === "MB") return val;
    return val / 1024;
}

// ─── SYSTEM PROMPT ───

const SYSTEM_PROMPT = `You are a movie & TV series download copilot. You find movies and TV shows, check releases, verify media libraries, and trigger downloads on Telegram bots for the user.

## HOW TO RESPOND:
- If you need to search or perform an action, output ONLY ONE JSON tool call in this exact format:
{"tool": "tool_name", "args": {"key": "value"}}
- When a tool result is returned, respond to the user in friendly, conversational Markdown with clear formatting.
- When the user confirms a download (e.g. "yes", "download", "yes go with 720p", "go with 1080p", "option 2", "yes please"), IMMEDIATELY invoke download_movie or download_episode/download_season.
- NEVER show raw JSON to the user in your final reply.

## AVAILABLE TOOLS:

### web_search(query)
Search online / encyclopedia for canonical title, release year, seasons, episode count, and synopsis.
- query: e.g., "Feludar Goyendagiri series" or "Bajrangi Bhaijaan 2015"

### search_movie(title, year)
Search Telegram @ProSearchM11Bot for movie releases.

### search_series(title)
Search Telegram @ProSearchY11Bot for TV series episodes and season packs.
- title: e.g. "Feludar Goyendagiri" (full series), "Feludar Goyendagiri S01" (specific season), or "Feludar Goyendagiri S03E01" (specific episode)

### download_movie(title, year, buttonText, sessionId)
Downloads a specific movie release using the sessionKey returned by search_movie.
- buttonText: e.g. "720p", "1080p", or the full button string from search_movie

### download_episode(title, season, episode, buttonText, sessionId)
Downloads a single episode using the sessionKey returned by search_series.

### download_season(title, season, count, episodes, sessionId)
Downloads ALL episodes for a season in bulk using the sessionKey returned by search_series.

### check_jellyfin(title, type, year)
Checks if content is already in the Jellyfin media library.

### list_downloads
List recent downloads and status.

### bot_reconnect / bot_auth_phone / bot_auth_code / bot_auth_password / bot_auth_status
Manage Telegram bot connection.
`;

// ─── TOOL EXECUTION ───

async function executeTool(toolName: string, args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const harness = getHarness();

    try {
        switch (toolName) {

            // ── WEB SEARCH ──
            case "web_search": {
                const { query } = args;
                if (!query) return { success: false, message: "Query is required" };

                const cleanQuery = query.replace(/\s+S\d+E\d+.*$/i, "").replace(/\s+S\d+.*$/i, "").trim() || query;
                harness.logActivity(`[WEB SEARCH] Query: ${query} -> clean: ${cleanQuery}`);
                const results = await webSearch(cleanQuery);

                const top = results.slice(0, 3).map((r: any) => ({
                    title: r.title,
                    snippet: r.snippet,
                    url: r.url
                }));

                const intent = detectIntent(query);
                setWorkflow(sessionId, {
                    step: "web_searched",
                    type: intent.type === "other" ? "movie" : intent.type as "movie" | "series",
                    title: query,
                    webResults: top
                });

                return {
                    success: true,
                    message: `WEB_RESULTS:${results.length} results found for "${query}"`,
                    data: { results: top, query }
                };
            }

            // ── SEARCH MOVIE ──
            case "search_movie": {
                const { title, year } = args;
                if (!title) return { success: false, message: "Title is required" };

                inngest.send({ name: "movie.search", data: { title, year: year || "", sessionId } }).catch(() => {});

                if (!isBotConnected()) {
                    return { success: false, message: "BOT_DISCONNECTED: Please connect the Telegram bot first." };
                }

                const jf = await checkMovieExists(title, year || "");
                if (jf.exists) {
                    return { success: true, message: `ALREADY_IN_JELLYFIN:${title}`, data: { exists: true } };
                }

                const query = `${title} ${year || ""}`.trim();
                harness.logActivity(`[SEARCH] Movie: ${query}`);
                const botClient = (await import("../bot/bot.js")).default;

                const sent = await botClient.sendMessage("ProSearchM11Bot", { message: query });
                await new Promise(r => setTimeout(r, 4000));

                let btnMsg: any = null;
                for (let attempt = 0; attempt < 2; attempt++) {
                    const messages = await botClient.getMessages("ProSearchM11Bot", { limit: 10 });
                    for (const msg of messages) {
                        if (msg.id === sent.id) continue;
                        const buttons = await msg.getButtons();
                        if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                    }
                    if (btnMsg) break;
                    await new Promise(r => setTimeout(r, 2500));
                }

                if (!btnMsg) {
                    return { success: true, message: `NO_RESULTS:${title}`, data: { results: [] } };
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

                cleanOldSessions();
                const sessionKey = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                searchSessions.set(sessionKey, {
                    bot: "ProSearchM11Bot", btnMsgId: btnMsg.id, btnMsg, results, grouped: [],
                    title, type: "movie", year: year || "", createdAt: Date.now()
                });

                const best = await pickBestResult(title, "movie", results);
                setWorkflow(sessionId, { step: "telegram_searched", type: "movie", title, year: year || "" });

                return {
                    success: true,
                    message: `MOVIE_RESULTS:${results.length} results found`,
                    data: {
                        results: results.map((r, i) => ({
                            text: r.text, sizeMB: r.sizeMB,
                            isBest: i === best.index, reason: i === best.index ? best.reason : ""
                        })),
                        bestIdx: best.index,
                        sessionKey, title, year
                    }
                };
            }

            // ── SEARCH SERIES ──
            case "search_series": {
                const { title } = args;
                if (!title) return { success: false, message: "Title is required" };

                inngest.send({ name: "series.search", data: { title, sessionId } }).catch(() => {});

                if (!isBotConnected()) {
                    return { success: false, message: "BOT_DISCONNECTED: Please connect the Telegram bot first." };
                }

                const baseTitle = title.replace(/\s+(?:S\d+.*|Season\s*\d+.*)$/i, "").trim() || title;
                const botClient = (await import("../bot/bot.js")).default;

                const queryBot = async (queryText: string) => {
                    harness.logActivity(`[SEARCH] Querying @ProSearchY11Bot for: "${queryText}"`);
                    try {
                        const sent = await botClient.sendMessage("ProSearchY11Bot", { message: queryText });
                        await new Promise(r => setTimeout(r, 3500));

                        let btnMsg: any = null;
                        for (let attempt = 0; attempt < 2; attempt++) {
                            const messages = await botClient.getMessages("ProSearchY11Bot", { limit: 10 });
                            for (const msg of messages) {
                                if (msg.id === sent.id) continue;
                                const buttons = await msg.getButtons();
                                if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                            }
                            if (btnMsg) break;
                            await new Promise(r => setTimeout(r, 2000));
                        }

                        if (!btnMsg) return { btnMsg: null, results: [] };

                        const buttons = (await btnMsg.getButtons())!;
                        const res: { text: string; sizeMB: number; btnMsg: any; btnMsgId: number }[] = [];
                        for (const row of buttons) {
                            for (const btn of row) {
                                const text = (btn as any).text || "";
                                if (!text) continue;
                                const lower = text.toLowerCase();
                                if (lower.includes("srt") || lower.includes("sub")) continue;
                                const sizeMB = extractSizeMB(text);
                                if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;
                                res.push({ text, sizeMB, btnMsg, btnMsgId: btnMsg.id });
                            }
                        }
                        return { btnMsg, results: res };
                    } catch (e: any) {
                        harness.logError(`[SEARCH] Bot query error for "${queryText}": ${e.message}`);
                        return { btnMsg: null, results: [] };
                    }
                };

                const mainSearch = await queryBot(title);
                let allFound = [...mainSearch.results];
                let primaryBtnMsg = mainSearch.btnMsg;

                const isSingleEp = /S\d{1,2}E\d{1,2}/i.test(title);
                if (!isSingleEp) {
                    const currentGrouped = groupByEpisode(allFound);
                    const foundSeasons = new Set(currentGrouped.map(e => e.season));

                    const seriesInfo = await getSeriesInfo(baseTitle);
                    const totalExpectedSeasons = Math.max(seriesInfo.seasons || 1, 3);

                    for (let s = 1; s <= totalExpectedSeasons; s++) {
                        if (!foundSeasons.has(s)) {
                            harness.logActivity(`[SEARCH] Season ${s} missing, probing "${baseTitle} S0${s}"...`);
                            const sSearch = await queryBot(`${baseTitle} S0${s}`);
                            if (sSearch.results.length > 0) {
                                allFound.push(...sSearch.results);
                                if (!primaryBtnMsg) primaryBtnMsg = sSearch.btnMsg;
                            }
                        }
                    }
                }

                if (allFound.length === 0 || !primaryBtnMsg) {
                    return { success: true, message: `NO_RESULTS:${title}`, data: { results: [] } };
                }

                const buttonMap = new Map<string, { bot: string; btnMsg: any; btnMsgId: number; text: string }>();
                for (const r of allFound) {
                    buttonMap.set(r.text, { bot: "ProSearchY11Bot", btnMsg: r.btnMsg, btnMsgId: r.btnMsgId, text: r.text });
                }

                const grouped = groupByEpisode(allFound);
                const seasons = [...new Set(grouped.map(e => e.season))].sort((a, b) => a - b);

                const seasonSummary = seasons.map(s => {
                    const eps = grouped.filter(e => e.season === s);
                    return { season: s, count: eps.length, episodes: eps };
                });

                cleanOldSessions();
                const sessionKey = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                searchSessions.set(sessionKey, {
                    bot: "ProSearchY11Bot", btnMsgId: primaryBtnMsg.id, btnMsg: primaryBtnMsg,
                    buttonMap, results: allFound, grouped,
                    title: baseTitle, type: "series", year: "", createdAt: Date.now()
                });

                setWorkflow(sessionId, { step: "telegram_searched", type: "series", title: baseTitle });

                return {
                    success: true,
                    message: `SERIES_RESULTS:${grouped.length} episodes found across ${seasons.length} seasons (Seasons: ${seasons.join(", ")})`,
                    data: {
                        seasons: seasonSummary,
                        totalResults: allFound.length,
                        totalEpisodes: grouped.length,
                        sessionKey, title: baseTitle
                    }
                };
            }

            // ── DOWNLOAD MOVIE (Resilient Session Recovery & Quality Resolution) ──
            case "download_movie": {
                let { title, year, buttonText, sessionId: sk } = args;
                if (!title) return { success: false, message: "title required" };

                // Locate matching session
                let session = sk ? searchSessions.get(sk) : null;
                if (!session) {
                    for (const [_, v] of searchSessions) {
                        if (v.type === "movie" && (v.title.toLowerCase().includes(title.toLowerCase()) || title.toLowerCase().includes(v.title.toLowerCase()))) {
                            session = v;
                            break;
                        }
                    }
                }

                // Resolve button text
                if (!buttonText || buttonText.toLowerCase().includes("720") || buttonText.toLowerCase().includes("best") || buttonText.toLowerCase().includes("yes") || !buttonText.includes("[")) {
                    if (session && session.results.length > 0) {
                        const prefer720 = session.results.find((r: any) => r.text.toLowerCase().includes("720p") && !r.text.toLowerCase().includes("srt"));
                        buttonText = prefer720 ? prefer720.text : session.results[0].text;
                    } else {
                        buttonText = buttonText || "720p";
                    }
                }

                const movieTitle = year ? `${title} (${year})` : (session?.year ? `${title} (${session.year})` : title);
                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const sizeMatch = buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
                const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;

                await db.insert(schema.downloads).values({
                    requestId, title: movieTitle,
                    year: year || session?.year || null, type: "movie", status: "queued",
                    fileSize: fileSize || (extractSizeMB(buttonText) > 0 ? extractSizeMB(buttonText).toFixed(0) + " MB" : "1.2 GB"),
                });

                downloadQueue.addJob({
                    requestId,
                    bot: session?.bot || "ProSearchM11Bot",
                    btnMsgId: session?.btnMsgId || 0,
                    type: "movie",
                    title: movieTitle,
                    year: year || session?.year || undefined,
                    fileSize: fileSize || undefined,
                    buttonText,
                });

                try { broadcastNewDownload({ jobId: requestId, title: movieTitle, type: "movie", requestedBy: "ai" }); } catch {}

                setWorkflow(sessionId, { step: "downloading" });

                return {
                    success: true,
                    message: `DOWNLOAD_QUEUED:${movieTitle} — reply with ONE short line "Downloading ${movieTitle}..."`,
                    data: { requestId, title: movieTitle }
                };
            }

            // ── DOWNLOAD EPISODE ──
            case "download_episode": {
                let { title, season, episode, buttonText, sessionId: sk } = args;
                if (!title) return { success: false, message: "title required" };

                const cleanTitle = title.replace(/\s+S\d+.*$/i, "").trim() || title;

                let sNum = typeof season === "number" ? season : parseInt(season);
                if (isNaN(sNum) || sNum <= 0) {
                    const sMatch = (buttonText || title).match(/S(\d+)/i);
                    sNum = sMatch ? parseInt(sMatch[1]) : 1;
                }

                let eNum = typeof episode === "number" ? episode : parseInt(episode);
                if (isNaN(eNum) || eNum <= 0) {
                    const eMatch = (buttonText || title).match(/E(\d+)/i);
                    eNum = eMatch ? parseInt(eMatch[1]) : 1;
                }

                const epLabel = `${cleanTitle} S${String(sNum).padStart(2, "0")}E${String(eNum).padStart(2, "0")}`;

                let session = sk ? searchSessions.get(sk) : null;
                if (!session) {
                    for (const [_, v] of searchSessions) {
                        if (v.type === "series" && (v.title.toLowerCase().includes(cleanTitle.toLowerCase()) || cleanTitle.toLowerCase().includes(v.title.toLowerCase()))) {
                            session = v;
                            break;
                        }
                    }
                }

                if (session && (!buttonText || !buttonText.includes("["))) {
                    const label = `S${String(sNum).padStart(2,"0")}E${String(eNum).padStart(2,"0")}`;
                    const found = session.grouped.find((g: any) => g.label.toLowerCase() === label.toLowerCase()) || session.results.find((r: any) => r.text.includes(label));
                    if (found) buttonText = (found as any).text;
                }

                const btnInfo = session?.buttonMap?.get(buttonText || "") || {
                    bot: session?.bot || "ProSearchY11Bot",
                    btnMsg: session?.btnMsg,
                    btnMsgId: session?.btnMsgId || 0,
                    text: buttonText || epLabel
                };

                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const sizeMatch = (buttonText || "").match(/\[([\d.]+)\s*(GB|MB)\]/i);
                const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;

                await db.insert(schema.downloads).values({
                    requestId, title: epLabel, type: "series", status: "queued",
                    season: sNum, episode: eNum,
                    fileSize: fileSize || (extractSizeMB(buttonText || "") > 0 ? extractSizeMB(buttonText || "").toFixed(0) + " MB" : "600 MB"),
                });

                downloadQueue.addJob({
                    requestId, bot: btnInfo.bot, btnMsgId: btnInfo.btnMsgId,
                    type: "series", title: epLabel, year: session?.year, fileSize: fileSize || undefined,
                    buttonText: btnInfo.text,
                });

                try { broadcastNewDownload({ jobId: requestId, title: epLabel, type: "series", requestedBy: "ai" }); } catch {}

                setWorkflow(sessionId, { step: "downloading" });

                return {
                    success: true,
                    message: `DOWNLOAD_QUEUED:${epLabel} — reply with ONE short line "Downloading ${epLabel}..."`,
                    data: { requestId, title: epLabel }
                };
            }

            // ── DOWNLOAD SEASON ──
            case "download_season": {
                const sk = args.sessionId || args.sessionKey || args.sessId || args.session_id;
                const { title, season, episodes } = args;
                if (!title || !episodes) {
                    return { success: false, message: "Missing title or episodes." };
                }
                const epList = typeof episodes === "string" ? JSON.parse(episodes) : episodes;

                let session = sk ? searchSessions.get(sk) : null;
                const cleanTitle = title.replace(/\s+S\d+.*$/i, "").trim() || title;

                if (!session) {
                    for (const [_, v] of searchSessions) {
                        if (v.type === "series" && (v.title.toLowerCase().includes(cleanTitle.toLowerCase()) || cleanTitle.toLowerCase().includes(v.title.toLowerCase()))) {
                            session = v;
                            break;
                        }
                    }
                }

                let sNum = typeof season === "number" ? season : parseInt(season);
                if (isNaN(sNum) || sNum <= 0) {
                    const sMatch = (title || "").match(/S(\d+)/i);
                    sNum = sMatch ? parseInt(sMatch[1]) : 1;
                }

                const results: { title: string; success: boolean }[] = [];

                for (let idx = 0; idx < epList.length; idx++) {
                    const ep = epList[idx];
                    let btnText = ep?.buttonText || ep?.text || ep?.label || (typeof ep === "string" ? ep : "");

                    let epNum = typeof ep === "number" ? ep : (ep?.episode || ep?.ep || ep?.num);
                    if (typeof epNum !== "number" || isNaN(epNum) || epNum <= 0) {
                        const match = (btnText || "").match(/S\d+E(\d+)/i) || (btnText || "").match(/E(\d+)/i);
                        if (match) {
                            epNum = parseInt(match[1]);
                        } else {
                            epNum = idx + 1;
                        }
                    }

                    const epLabel = `${cleanTitle} S${String(sNum).padStart(2, "0")}E${String(epNum).padStart(2, "0")}`;

                    if (!btnText.includes("[") && session) {
                        const label = `S${String(sNum).padStart(2,"0")}E${String(epNum).padStart(2,"0")}`;
                        const found = session.grouped.find((g: any) => g.label.toLowerCase() === label.toLowerCase()) || session.results.find((r: any) => r.text.includes(label));
                        if (found) btnText = (found as any).text;
                    }
                    const buttonText = (ep as any)?.text || btnText || epLabel;
                    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                    const btnInfo = session?.buttonMap?.get(buttonText) || {
                        bot: session?.bot || "ProSearchY11Bot",
                        btnMsg: session?.btnMsg,
                        btnMsgId: session?.btnMsgId || 0,
                        text: buttonText
                    };

                    const sizeMatch = buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
                    const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;

                    await db.insert(schema.downloads).values({
                        requestId, title: epLabel, type: "series", status: "queued",
                        season: sNum, episode: epNum,
                        fileSize: fileSize || (extractSizeMB(buttonText) > 0 ? extractSizeMB(buttonText).toFixed(0) + " MB" : "600 MB"),
                    });

                    downloadQueue.addJob({
                        requestId, bot: btnInfo.bot, btnMsgId: btnInfo.btnMsgId,
                        type: "series", title: epLabel, year: session?.year, fileSize: fileSize || undefined,
                        buttonText: btnInfo.text,
                    });

                    try { broadcastNewDownload({ jobId: requestId, title: epLabel, type: "series", requestedBy: "ai" }); } catch {}
                    results.push({ title: epLabel, success: true });
                }

                setWorkflow(sessionId, { step: "downloading" });
                const ok = results.filter(r => r.success).length;

                return {
                    success: true,
                    message: `SEASON_QUEUED:${ok}/${results.length} episodes for Season ${sNum}`,
                    data: { queued: ok, total: results.length, season: sNum, results }
                };
            }

            // ── CHECK JELLYFIN ──
            case "check_jellyfin": {
                const { title, type, year } = args;
                if (!title) return { success: false, message: "Title required" };

                if ((type || "movie") === "movie") {
                    const r = await checkMovieExists(title, year || "");
                    return {
                        success: true,
                        message: r.exists ? `IN_JELLYFIN:${title}` : `NOT_IN_JELLYFIN:${title}`,
                        data: r
                    };
                } else {
                    const r = await checkSeriesExists(title);
                    return {
                        success: true,
                        message: r.exists ? `IN_JELLYFIN:${title}` : `NOT_IN_JELLYFIN:${title}`,
                        data: r
                    };
                }
            }

            // ── LIST DOWNLOADS ──
            case "list_downloads": {
                const items = await db.select().from(schema.downloads)
                    .orderBy(desc(schema.downloads.createdAt)).limit(15);
                if (items.length === 0) return { success: true, message: "NO_DOWNLOADS", data: { items: [] } };

                const summary = items.map((d: any) =>
                    `${d.title} (${d.type}) - ${d.status}${d.progress ? ` ${d.progress}%` : ""}`
                ).join("\n");
                return { success: true, message: `DOWNLOADS:\n${summary}`, data: { items } };
            }

            // ── BOT AUTH ──
            case "bot_reconnect": {
                if (isBotConnected()) return { success: true, message: "BOT_CONNECTED", data: { connected: true } };
                const st = getAuthState();
                if (st.step === "need_phone" || st.step === "need_code" || st.step === "need_password") {
                    return { success: true, message: `AUTH_STEP:${st.step}`, data: { step: st.step } };
                }
                startWebAuth().catch(() => {});
                await new Promise(r => setTimeout(r, 1000));
                const state = getAuthState();
                return { success: true, message: `AUTH_STEP:${state.step}`, data: { step: state.step } };
            }

            case "bot_auth_phone": {
                const { phone } = args;
                if (!phone) return { success: false, message: "Phone required" };
                const r = submitPhone(phone);
                if (!r.ok) return { success: false, message: r.error || "Cannot submit phone" };
                await new Promise(r => setTimeout(r, 2000));
                const st = getAuthState();
                return { success: true, message: `AUTH_STEP:${st.step}`, data: { step: st.step } };
            }

            case "bot_auth_code": {
                const { code } = args;
                if (!code) return { success: false, message: "Code required" };
                const r = submitCode(code);
                if (!r.ok) return { success: false, message: r.error || "Cannot submit code" };
                await new Promise(r => setTimeout(r, 2000));
                const st = getAuthState();
                if (st.step === "done") return { success: true, message: "BOT_CONNECTED", data: { connected: true } };
                return { success: true, message: `AUTH_STEP:${st.step}`, data: { step: st.step } };
            }

            case "bot_auth_password": {
                const { password } = args;
                if (!password) return { success: false, message: "Password required" };
                const r = submitPassword(password);
                if (!r.ok) return { success: false, message: r.error || "Cannot submit password" };
                await new Promise(r => setTimeout(r, 3000));
                const st = getAuthState();
                if (st.step === "done") return { success: true, message: "BOT_CONNECTED", data: { connected: true } };
                return { success: true, message: `AUTH_STEP:${st.step}`, data: { step: st.step } };
            }

            case "bot_auth_status": {
                if (isBotConnected()) return { success: true, message: "BOT_CONNECTED", data: { connected: true } };
                const st = getAuthState();
                return { success: true, message: `BOT_DISCONNECTED:${st.step}`, data: { connected: false, step: st.step } };
            }

            default:
                return { success: false, message: `Unknown tool: ${toolName}` };
        }
    } catch (err: any) {
        harness.logError(`[CHAT] Tool error: ${err.message}`);
        return { success: false, message: `ERROR:${err.message}` };
    }
}

// ─── CHAT HANDLER ───

export async function handleChat(
    userMessage: string,
    history: { role: string; content: string }[],
    sessionId: string
): Promise<{ reply: string; toolCalls: { tool: string; args: any; result: ToolResult }[] }> {
    const harness = getHarness();
    const toolCalls: { tool: string; args: any; result: ToolResult }[] = [];

    const lowerMsg = userMessage.toLowerCase().trim();
    if (/^(hi|hello|hey|start|reset|clear|new|help|\?)/.test(lowerMsg) || lowerMsg.length < 3) {
        clearWorkflow(sessionId);
    }

    await saveMemory(sessionId, "user", userMessage);

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
        { role: "user", content: userMessage },
    ];

    const MAX_ITERATIONS = 8;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        harness.logActivity(`[CHAT] AI iteration ${i + 1}`);

        const response = await harness.chat(messages);
        harness.logActivity(`[CHAT] AI output: ${response.substring(0, 200)}`);

        const parsed = parseToolCall(response);

        if (parsed) {
            harness.logActivity(`[CHAT] Executing parsed tool: "${parsed.tool}" with args: ${JSON.stringify(parsed.args)}`);

            const result = await executeTool(parsed.tool, parsed.args, sessionId);
            toolCalls.push({ tool: parsed.tool, args: parsed.args, result });

            messages.push({ role: "assistant", content: response });
            messages.push({
                role: "user",
                content: `Tool "${parsed.tool}" executed.\nResult message: ${result.message}\nData: ${JSON.stringify(result.data || {})}\n\nNow respond to the user in conversational, friendly Markdown. NEVER display raw JSON in your reply.`
            });
            continue;
        }

        await saveMemory(sessionId, "ai", response.substring(0, 500));
        return { reply: response, toolCalls };
    }

    return { reply: "Done processing your request!", toolCalls };
}

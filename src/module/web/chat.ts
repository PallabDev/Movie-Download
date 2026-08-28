import { getHarness } from "../../../command/harness.js";
import { db, schema } from "../../common/db/index.js";
import { desc, eq } from "drizzle-orm";
import { checkMovieExists, checkSeriesExists } from "../../common/jellyfin/client.js";
import { downloadQueue } from "../queue/queue.js";
import { isBotConnected, getAuthState, submitPhone, submitCode, submitPassword, startWebAuth } from "../bot/bot.js";
import { webSearch, pickBestResult, groupByEpisode } from "../ai/brain.js";
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

// Which tools are allowed at each step — web_search only once
const ALLOWED_TOOLS: Record<WorkflowStep, string[]> = {
    idle: ["web_search", "bot_reconnect", "bot_auth_phone", "bot_auth_code", "bot_auth_password", "bot_auth_status", "list_downloads", "check_jellyfin"],
    web_searched: ["search_movie", "search_series", "bot_reconnect", "bot_auth_phone", "bot_auth_code", "bot_auth_password", "bot_auth_status", "check_jellyfin"],
    telegram_searched: ["download_movie", "download_episode", "download_season", "search_series", "search_movie", "bot_reconnect", "bot_auth_phone", "bot_auth_code", "bot_auth_password", "bot_auth_status", "list_downloads", "check_jellyfin"],
    user_picked: ["download_movie", "download_episode", "download_season", "bot_reconnect", "bot_auth_phone", "bot_auth_code", "bot_auth_password", "bot_auth_status"],
    downloading: ["list_downloads", "check_jellyfin", "web_search"],
};

function isToolAllowed(sessionId: string, toolName: string): { allowed: boolean; reason?: string } {
    const wf = getWorkflow(sessionId);
    const step = wf?.step || "idle";
    const allowed = ALLOWED_TOOLS[step];

    if (allowed.includes(toolName)) return { allowed: true };

    // Specific error messages
    if (step === "idle" && (toolName === "search_movie" || toolName === "search_series")) {
        return { allowed: false, reason: "Must call web_search first to get accurate info before searching Telegram" };
    }
    if (step === "web_searched" && (toolName === "download_movie" || toolName === "download_episode" || toolName === "download_season")) {
        return { allowed: false, reason: "Must search Telegram first before downloading" };
    }
    return { allowed: false, reason: `Tool "${toolName}" not allowed at step "${step}"` };
}

// Detect what the user is asking about
function detectIntent(message: string): { type: "movie" | "series" | "download" | "other"; title?: string } {
    const lower = message.toLowerCase();

    // Check if user is picking a season/episode
    if (/^(all|s\d+e?\d*|season\s*\d+)/i.test(lower.trim())) {
        return { type: "download" };
    }

    // Check if user is confirming download
    if (/^(yes|yeah|y|ok|okay|download|go|sure|confirm)/i.test(lower.trim())) {
        return { type: "download" };
    }

    // Check for series indicators
    const seriesPatterns = /\b(series|season|episode|ep\b|show|anime|web\s*series|part\s*\d+)/i;
    if (seriesPatterns.test(lower)) {
        return { type: "series" };
    }

    // Default to movie if it looks like a title (not a command)
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

const SYSTEM_PROMPT = `You are a movie & series download assistant. You search Telegram bots and download content for the user.

## FORMAT: ALWAYS respond with ONLY this JSON:
{"tool": "tool_name", "args": {"key": "value"}}

## TOOLS:

### web_search(query)
Search the internet for movie/series information. ALWAYS call this FIRST.
- query: what to search for (e.g., "Stranger Things Netflix series", "Inception 2010 movie")
Returns: accurate title, year, type, episode count, synopsis

### search_movie(title, year)
Searches Telegram @ProSearchM11Bot for a movie. ONLY call AFTER web_search returns results.
- title: exact movie name (from web search)
- year: release year (from web search)
Returns: list of results with sizes, bestPick (720p preferred), sessionId

### search_series(title)  
Searches Telegram @ProSearchY11Bot for a series. ONLY call AFTER web_search returns results.
- title: series name, optionally with season/episode suffix like "Feludar Goyendagiri S01E01" or "Feludar Goyendagiri S02" to filter specific seasons. For full series use plain name, for specific episode use "Name S01E01" format
Returns: grouped episodes by season, list of seasons with episode counts, sessionId

### download_movie(title, year, buttonText, sessionId)
Downloads a specific movie. ONLY call after user confirms.

### download_episode(title, season, episode, buttonText, sessionId)
Downloads a single episode. ONLY call after user confirms.

### download_season(title, season, count, episodes, sessionId)
Downloads ALL episodes in a season at once. Call once per season after user says "all" or "S01".
- count: number of episodes (from search_series)
- episodes: array of {episode, buttonText} objects (from search_series seasons data)
- sessionId: the sessionKey returned by search_series (REQUIRED, e.g. "sess_abc123")

### check_jellyfin(title, type, year)
Check if content already exists in Jellyfin library.

### list_downloads
Show recent downloads.

### bot_reconnect / bot_auth_phone / bot_auth_code / bot_auth_password
Handle Telegram bot authentication.

## STRICT WORKFLOW FOR MOVIES:
1. Call web_search ONCE with movie name + year
2. If user said "download", immediately call search_movie with exact title/year from web_search (include SxxEyy if user provided)
3. Otherwise present info and ask confirmation before search_movie
4. Show results, highlight best pick
5. User confirms → call download_movie

## STRICT WORKFLOW FOR SERIES:
1. Call web_search ONCE with series name (keep S01E01 if user provided, e.g., "Feludar Goyendagiri S01E01")
2. If user said "download" or provided SxxEyy, immediately call search_series with "Title SxxEyy" (e.g., "Feludar Goyendagiri S01E01"), else use plain title
3. Otherwise present info and ask confirmation before search_series
4. Show seasons/episodes, ask "Which? all/S01/S01E01" only if multiple seasons found
5. User picks → call download_season or download_episode with sessionKey from search_series

## RULES:
- Call web_search EXACTLY ONCE per request, then immediately go to search_movie/search_series if user said download — do NOT call web_search twice
- If user already said "download S01E01", skip asking and go directly: web_search -> search_series("Title S01E01") -> show results -> download
- Preserve S01/S01E01 suffix from user query in both web_search and search_series
- NEVER download without user saying download/yes/all/Sxx
- Prefer 720p, Movie 600MB-1.9GB, Episode 50MB-1GB
- After web_search, do NOT repeat web_search — proceed to Telegram search
`;

// ─── TOOL EXECUTION ───

async function executeTool(toolName: string, args: Record<string, any>, sessionId: string): Promise<ToolResult> {
    const harness = getHarness();

    try {
        switch (toolName) {

            // ── WEB SEARCH (FIRST STEP) ──
            case "web_search": {
                const { query } = args;
                if (!query) return { success: false, message: "Query is required" };

                const cleanQuery = query.replace(/\s+S\d+E\d+.*$/i, "").replace(/\s+S\d+.*$/i, "").trim() || query;
                harness.logActivity(`[WEB SEARCH] Query: ${query} -> clean: ${cleanQuery}`);
                const results = await webSearch(cleanQuery);

                if (!results || results.length === 0) {
                    const intent0 = detectIntent(query);
                    const baseTitle = query.replace(/\s+S\d+E\d+.*$/i, "").replace(/\s+S\d+.*$/i, "").trim() || query;
                    setWorkflow(sessionId, { step: "web_searched", type: intent0.type === "other" ? "series" : intent0.type as "movie" | "series", title: baseTitle, webResults: [] });
                    return { success: true, message: `NO_WEB_RESULTS:${query} (proceeding anyway)`, data: { results: [], query, baseTitle } };
                }

                // Return first 3 results
                const top = results.slice(0, 3).map((r: any) => ({
                    title: r.title,
                    snippet: r.snippet,
                    url: r.url
                }));

                // Set workflow state: web search done
                const intent = detectIntent(query);
                setWorkflow(sessionId, { step: "web_searched", type: intent.type === "other" ? "movie" : intent.type as "movie" | "series", title: query, webResults: top });

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
                    return { success: false, message: "BOT_DISCONNECTED" };
                }

                // Check Jellyfin first
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
                let messages = await botClient.getMessages("ProSearchM11Bot", { limit: 10 });
                for (const msg of messages) {
                    if (msg.id === sent.id) continue;
                    const buttons = await msg.getButtons();
                    if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                }

                if (!btnMsg) {
                    await new Promise(r => setTimeout(r, 3000));
                    messages = await botClient.getMessages("ProSearchM11Bot", { limit: 10 });
                    for (const msg of messages) {
                        if (msg.id === sent.id) continue;
                        const buttons = await msg.getButtons();
                        if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                    }
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

                // Send inngest event for visibility
                inngest.send({
                    name: "movie.search.completed",
                    data: { title, year, resultCount: results.length, sessionKey, sessionId }
                });

                // Set workflow state: Telegram search done
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
                    return { success: false, message: "BOT_DISCONNECTED" };
                }

                // Check Jellyfin first
                const jfClean = title.replace(/\s+S\d+.*$/i, "").trim();
                const jf = await checkSeriesExists(jfClean);
                if (jf.exists) {
                    return { success: true, message: `ALREADY_IN_JELLYFIN:${title}`, data: { exists: true } };
                }

                harness.logActivity(`[SEARCH] Series: ${title}`);
                const botClient = (await import("../bot/bot.js")).default;

                const sent = await botClient.sendMessage("ProSearchY11Bot", { message: title });
                await new Promise(r => setTimeout(r, 4000));

                let btnMsg: any = null;
                let messages = await botClient.getMessages("ProSearchY11Bot", { limit: 10 });
                for (const msg of messages) {
                    if (msg.id === sent.id) continue;
                    const buttons = await msg.getButtons();
                    if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                }

                if (!btnMsg) {
                    await new Promise(r => setTimeout(r, 3000));
                    messages = await botClient.getMessages("ProSearchY11Bot", { limit: 10 });
                    for (const msg of messages) {
                        if (msg.id === sent.id) continue;
                        const buttons = await msg.getButtons();
                        if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                    }
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

                const grouped = groupByEpisode(results);
                const seasons = [...new Set(grouped.map(e => e.season))].sort((a, b) => a - b);

                // Build season summary with episode counts
                const seasonSummary = seasons.map(s => {
                    const eps = grouped.filter(e => e.season === s);
                    return { season: s, count: eps.length, episodes: eps };
                });

                cleanOldSessions();
                const sessionKey = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                searchSessions.set(sessionKey, {
                    bot: "ProSearchY11Bot", btnMsgId: btnMsg.id, btnMsg, results, grouped,
                    title, type: "series", year: "", createdAt: Date.now()
                });

                // Send inngest event for visibility
                inngest.send({
                    name: "series.search.completed",
                    data: { title, resultCount: results.length, episodeCount: grouped.length, seasonCount: seasons.length, sessionKey, sessionId }
                });

                // Set workflow state: Telegram search done
                setWorkflow(sessionId, { step: "telegram_searched", type: "series", title });

                return {
                    success: true,
                    message: `SERIES_RESULTS:${grouped.length} episodes across ${seasons.length} seasons`,
                    data: {
                        seasons: seasonSummary,
                        totalResults: results.length,
                        totalEpisodes: grouped.length,
                        sessionKey, title
                    }
                };
            }

            // ── DOWNLOAD MOVIE ──
            case "download_movie": {
                let { title, year, buttonText, sessionId: sk } = args;
                if (!title || !buttonText || !sk) {
                    return { success: false, message: "title, buttonText, sessionId required" };
                }
                const sessMovie = searchSessions.get(sk);
                if (sessMovie && !buttonText.includes("[")) {
                    const found = sessMovie.results.find((r: any) => r.text.includes(buttonText));
                    if (found) buttonText = found.text;
                }
                inngest.send({ name: "download.start", data: { requestId: `req_${Date.now()}`, title, type: "movie", buttonText, bot: searchSessions.get(sk)?.bot || "ProSearchM11Bot", btnMsgId: searchSessions.get(sk)?.btnMsgId || 0, year } }).catch(() => {});

                const session = searchSessions.get(sk);
                if (!session) return { success: false, message: "Session expired. Search again." };

                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const sizeMatch = buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
                const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;
                await db.insert(schema.downloads).values({
                    requestId, title: year ? `${title} (${year})` : title,
                    year: year || null, type: "movie", status: "queued",
                    fileSize: fileSize || extractSizeMB(buttonText).toFixed(0) + " MB",
                });

                downloadQueue.addJob({
                    requestId, bot: session.bot, btnMsgId: session.btnMsgId,
                    type: "movie", title, year: session.year, fileSize: fileSize || undefined,
                    buttonText,
                });
                try { broadcastNewDownload({ jobId: requestId, title: year ? `${title} (${year})` : title, type: "movie", requestedBy: "ai" }); } catch {}

                searchSessions.delete(sk);
                setWorkflow(sessionId, { step: "downloading" });

                // Send inngest event for visibility
                inngest.send({
                    name: "download.started",
                    data: { requestId, title, type: "movie", fileSize }
                });

                return {
                    success: true,
                    message: `DOWNLOAD_QUEUED:${title} — reply with ONE short line "Downloading..." and let the circular card show progress`,
                    data: { requestId, title }
                };
            }

            // ── DOWNLOAD EPISODE ──
            case "download_episode": {
                let { title, season, episode, buttonText, sessionId: sk } = args;
                if (!title || !buttonText || !sk) {
                    return { success: false, message: "title, buttonText, sessionId required" };
                }
                const sessEp = searchSessions.get(sk);
                if (sessEp && !buttonText.includes("[")) {
                    const label = buttonText.includes("S") ? buttonText : `S${String(season).padStart(2,"0")}E${String(episode).padStart(2,"0")}`;
                    const found = sessEp.grouped.find((g: any) => g.label.toLowerCase() === label.toLowerCase()) || sessEp.results.find((r: any) => r.text.includes(label));
                    if (found) buttonText = (found as any).text;
                }
                inngest.send({ name: "download.start", data: { requestId: `req_${Date.now()}`, title: `${title} S${String(season).padStart(2,"0")}E${String(episode).padStart(2,"0")}`, type: "series", buttonText, bot: searchSessions.get(sk)?.bot || "ProSearchY11Bot", btnMsgId: searchSessions.get(sk)?.btnMsgId || 0 } }).catch(() => {});

                const session = searchSessions.get(sk);
                if (!session) return { success: false, message: "Session expired. Search again." };

                const epLabel = `${title} S${String(season || 1).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
                const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const sizeMatch = buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
                const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;

                await db.insert(schema.downloads).values({
                    requestId, title: epLabel, type: "series", status: "queued",
                    season: season || 1, episode: episode || 1,
                    fileSize: fileSize || extractSizeMB(buttonText).toFixed(0) + " MB",
                });

                downloadQueue.addJob({
                    requestId, bot: session.bot, btnMsgId: session.btnMsgId,
                    type: "series", title: epLabel, year: session.year, fileSize: fileSize || undefined,
                    buttonText,
                });
                try { broadcastNewDownload({ jobId: requestId, title: epLabel, type: "series", requestedBy: "ai" }); } catch {}

                setWorkflow(sessionId, { step: "downloading" });

                // Send inngest event for visibility
                inngest.send({
                    name: "download.started",
                    data: { requestId, title: epLabel, type: "series", fileSize }
                });

                return {
                    success: true,
                    message: `DOWNLOAD_QUEUED:${epLabel} — reply with ONE short line "Downloading ${epLabel}..." and let the circular card show progress, do NOT make a table or repeat size/request ID`,
                    data: { requestId, title: epLabel }
                };
            }

            // ── DOWNLOAD SEASON (batch) ──
            case "download_season": {
                const sk = args.sessionId || args.sessionKey || args.sessId || args.session_id;
                const { title, season, count, episodes } = args;
                if (!title || !episodes || !sk) {
                    return { success: false, message: `MISSING_FIELDS: need title, episodes, sessionId. Got title=${!!title} episodes=${!!episodes} sessionId=${!!sk}. Use sessionKey from search_series as sessionId, and pass episodes from seasons data` };
                }
                const epList = typeof episodes === "string" ? JSON.parse(episodes) : episodes;
                inngest.send({ name: "download.start", data: { requestId: `req_${Date.now()}`, title: `${title} S${String(season).padStart(2,"0")}`, type: "series", buttonText: epList[0]?.buttonText || "", bot: searchSessions.get(sk)?.bot || "ProSearchY11Bot", btnMsgId: searchSessions.get(sk)?.btnMsgId || 0 } }).catch(() => {});

                const session = searchSessions.get(sk);
                if (!session) return { success: false, message: "Session expired. Search again." };

                const results: { title: string; success: boolean }[] = [];

                for (const ep of epList) {
                    const epNum = ep.episode;
                    let btnText = ep.buttonText || (ep as any).text || (ep as any).label || "";
                    if (!btnText.includes("[") && session) {
                        const label = btnText.includes("S") ? btnText : `S${String(season).padStart(2,"0")}E${String(epNum).padStart(2,"0")}`;
                        const found = session.grouped.find((g: any) => g.label.toLowerCase() === label.toLowerCase()) || session.results.find((r: any) => r.text.includes(label));
                        if (found) btnText = (found as any).text;
                    }
                    const buttonText = (ep as any).text || btnText;
                    const epLabel = `${title} S${String(season || 1).padStart(2, "0")}E${String(epNum).padStart(2, "0")}`;
                    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

                    await db.insert(schema.downloads).values({
                        requestId, title: epLabel, type: "series", status: "queued",
                        season: season || 1, episode: epNum,
                        fileSize: extractSizeMB(buttonText).toFixed(0) + " MB",
                    });

                    const sizeMatch = buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
                    const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;

                    downloadQueue.addJob({
                        requestId, bot: session.bot, btnMsgId: session.btnMsgId,
                        type: "series", title: epLabel, year: session.year, fileSize: fileSize || undefined,
                        buttonText: buttonText,
                    });
                    try { broadcastNewDownload({ jobId: requestId, title: epLabel, type: "series", requestedBy: "ai" }); } catch {}

                    results.push({ title: epLabel, success: true });
                }

                searchSessions.delete(sk);
                setWorkflow(sessionId, { step: "downloading" });
                const ok = results.filter(r => r.success).length;
                return {
                    success: true,
                    message: `SEASON_QUEUED:${ok}/${results.length} for S${String(season).padStart(2,"0")} — reply with ONE short line and let circular cards show progress, do NOT make a table`,
                    data: { queued: ok, total: results.length, season, results }
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

    // Check if user is starting a new conversation (greeting or reset)
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

    const MAX_ITERATIONS = 10;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        harness.logActivity(`[CHAT] AI iteration ${i + 1}`);

        const response = await harness.chat(messages);
        harness.logActivity(`[CHAT] AI: ${response.substring(0, 300)}`);

        const parsed = parseToolCall(response);

        if (parsed) {
            // INGEST: Check if tool is allowed at this workflow step
            const check = isToolAllowed(sessionId, parsed.tool);
            if (!check.allowed) {
                const enforceMsg = `WORKFLOW_BLOCKED: ${check.reason}. Current step: ${getWorkflow(sessionId)?.step || "idle"}. You MUST follow the correct order.`;
                toolCalls.push({ tool: parsed.tool, args: parsed.args, result: { success: false, message: enforceMsg } });

                messages.push({ role: "assistant", content: response });
                messages.push({
                    role: "user",
                    content: `Tool "${parsed.tool}" was BLOCKED by workflow engine: ${check.reason}\n\nYou must follow the correct order. Current step: ${getWorkflow(sessionId)?.step || "idle"}\n\nNow respond to the user with the correct next step.`
                });
                continue;
            }

            const result = await executeTool(parsed.tool, parsed.args, sessionId);
            toolCalls.push({ tool: parsed.tool, args: parsed.args, result });

            messages.push({ role: "assistant", content: response });
            messages.push({
                role: "user",
                content: `Tool "${parsed.tool}" result: ${result.message}\nData: ${JSON.stringify(result.data || {})}\n\nNow respond to the user. Be conversational. If you need user input, ask for it. If done, confirm.`
            });
            continue;
        }

        await saveMemory(sessionId, "ai", response.substring(0, 500));
        return { reply: response, toolCalls };
    }

    return { reply: "Done! Check the results above.", toolCalls };
}

import express from "express";
import cookieParser from "cookie-parser";
import { db, schema } from "../../common/db/index.js";
import { eq, desc, like, sql, count } from "drizzle-orm";
import { register, login, extractUser, getAllUsers, deleteUser } from "../../common/auth/auth.js";
import { checkMovieExists, checkSeriesExists, getLibraryStats, getAllMovies, getAllSeries } from "../../common/jellyfin/client.js";
import { downloadQueue, secureBotFileToSavedMessages } from "../queue/queue.js";
import { getHarness } from "../../../command/harness.js";
import { broadcastNewDownload } from "./ws.js";
import { isBotConnected, isBotConnecting, ensureBotConnected, setBotConnected, setBotConnecting, getAuthState, submitPhone, submitCode, submitPassword, startWebAuth } from "../bot/bot.js";
import { getEpisodeDetails, pickBestResult, groupByEpisode, getSeriesInfo, isAllowedDownloadLanguage, checkResolutionHarnessRule } from "../ai/brain.js";
import {
    lookupMedia,
    getSeriesSeasonsAndEpisodes,
    getSeasonEpisodesList,
    searchMulti as tmdbSearchMulti,
    searchMovie as tmdbSearchMovie,
    searchTV as tmdbSearchTV
} from "../../common/tmdb/client.js";
import { handleChat } from "./chat.js";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

// In-memory search sessions: searchId -> { botUsername, sentId, btnMsgId, buttons, title, type, year }
const searchSessions = new Map<string, any>();

// ─── AUTH MIDDLEWARE ───

function requireAuth(req: any, res: any, next: any) {
    const user = extractUser(req);
    if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    req.user = user;
    next();
}

function requireAdmin(req: any, res: any, next: any) {
    const user = extractUser(req);
    if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    if (user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
    }
    req.user = user;
    next();
}

// ─── AUTH ROUTES ───

app.post("/api/auth/register", async (req, res) => {
    try {
        const { email, password, name } = req.body;
        if (!email || !password || !name) return res.status(400).json({ error: "Email, password, and name required" });
        const existingUsers = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
        const role = existingUsers.length === 0 ? "admin" : "user";
        const user = await register(email, password, name, role as "user" | "admin");
        const token = (await login(email, password)).token;
        res.cookie("token", token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: "lax", path: "/" });
        res.json({ success: true, user, token });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email and password required" });
        const result = await login(email, password);
        res.cookie("token", result.token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: "lax", path: "/" });
        res.json({ success: true, ...result });
    } catch (err: any) {
        res.status(401).json({ error: err.message });
    }
});

app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie("token");
    res.json({ success: true });
});

app.get("/api/auth/me", requireAuth, async (req: any, res) => {
    const { getUserById } = await import("../../common/auth/auth.js");
    const user = await getUserById(req.user.userId);
    res.json({ user });
});

// ─── ADMIN ROUTES ───

app.get("/api/admin/users", requireAdmin, async (_req, res) => {
    const users = await getAllUsers();
    res.json({ users });
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    await deleteUser(Number(req.params.id));
    res.json({ success: true });
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
    try {
        const { email, password, name, role } = req.body;
        const user = await register(email, password, name, role || "user");
        res.json({ success: true, user });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// ─── BOT STATUS & WEB AUTH ───

app.get("/api/bot/status", requireAuth, (_req, res) => {
    const auth = getAuthState();
    res.json({ connected: isBotConnected(), connecting: isBotConnecting(), auth });
});

app.post("/api/bot/reconnect", requireAuth, async (_req, res) => {
    if (isBotConnecting()) return res.status(400).json({ error: "Already connecting" });
    if (isBotConnected()) return res.json({ success: true, message: "Already connected", connected: true });

    // Try session reconnect first
    const reconnected = await ensureBotConnected();
    if (reconnected) {
        return res.json({ success: true, message: "Reconnected successfully", connected: true });
    }

    // If session reconnect failed, launch web auth flow
    startWebAuth().catch((err) => console.error("[BOT RECONNECT] Auth error:", err));

    // Wait briefly to see if auth step transitions
    for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (isBotConnected()) {
            return res.json({ success: true, connected: true, message: "Connected successfully" });
        }
        const state = getAuthState();
        if (state.step !== "idle" && state.step !== "authenticating") {
            return res.json({ success: isBotConnected(), connected: isBotConnected(), step: state.step, error: state.error });
        }
    }
    const state = getAuthState();
    return res.json({ success: isBotConnected(), connected: isBotConnected(), step: state.step, error: state.error });
});

app.post("/api/bot/auth/phone", requireAuth, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone number required" });
    const result = submitPhone(phone);
    if (!result.ok) return res.status(400).json({ error: result.error });
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const state = getAuthState();
        if (state.step !== "authenticating") {
            return res.json({ success: true, step: state.step, error: state.error });
        }
    }
    const state = getAuthState();
    return res.json({ success: true, step: state.step, error: state.error });
});

app.post("/api/bot/auth/code", requireAuth, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Code required" });
    const result = submitCode(code);
    if (!result.ok) return res.status(400).json({ error: result.error });
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const state = getAuthState();
        if (state.step !== "authenticating") {
            return res.json({ success: true, step: state.step, error: state.error });
        }
    }
    const state = getAuthState();
    return res.json({ success: true, step: state.step, error: state.error });
});

app.post("/api/bot/auth/password", requireAuth, async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Password required" });
    const result = submitPassword(password);
    if (!result.ok) return res.status(400).json({ error: result.error });
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const state = getAuthState();
        if (state.step !== "authenticating") {
            return res.json({ success: true, step: state.step, error: state.error });
        }
    }
    const state = getAuthState();
    return res.json({ success: true, step: state.step, error: state.error });
});

app.get("/api/bot/auth/status", requireAuth, (_req, res) => {
    const state = getAuthState();
    return res.json(state);
});

// ─── TMDB DISCOVERY ENDPOINTS ───

app.get("/api/tmdb/search", requireAuth, async (req: any, res) => {
    try {
        const query = (req.query.query as string || "").trim();
        const type = (req.query.type as string || "").trim();
        const year = req.query.year as string;

        if (!query) return res.status(400).json({ error: "Query required" });

        if (type === "movie") {
            const data = await tmdbSearchMovie(query, year);
            return res.json(data);
        } else if (type === "tv" || type === "series") {
            const data = await tmdbSearchTV(query, year);
            return res.json(data);
        } else {
            const data = await tmdbSearchMulti(query);
            return res.json(data);
        }
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

app.get("/api/tmdb/details", requireAuth, async (req: any, res) => {
    try {
        const query = (req.query.query as string || req.query.title as string || "").trim();
        if (!query) return res.status(400).json({ error: "Query required" });

        const media = await lookupMedia(query);
        if (!media) return res.status(404).json({ error: "Media not found on TMDB" });

        return res.json(media);
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

app.get("/api/tmdb/seasons", requireAuth, async (req: any, res) => {
    try {
        const title = (req.query.title as string || "").trim();
        if (!title) return res.status(400).json({ error: "Title required" });

        const info = await getSeriesSeasonsAndEpisodes(title);
        return res.json(info);
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

app.get("/api/tmdb/episodes", requireAuth, async (req: any, res) => {
    try {
        const title = (req.query.title as string || "").trim();
        const season = parseInt(req.query.season as string || "1", 10);
        if (!title) return res.status(400).json({ error: "Title required" });

        const eps = await getSeasonEpisodesList(title, season);
        return res.json(eps);
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── SEARCH (Direct Studio & AI Workflow) ───

app.post("/api/search", requireAuth, async (req: any, res) => {
    let { title, type, year } = req.body;
    if (!title || !type) return res.status(400).json({ error: "Title and type required" });
    if (type !== "movie" && type !== "series") return res.status(400).json({ error: "Type must be movie or series" });

    const harness = getHarness();
    const searchId = `srch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
        console.log(`[SEARCH] Analyzing "${title}" (type: ${type})`);

        // 1. Resolve canonical details via TMDB
        let cleanTitle = title;
        let cleanYear = year || "";
        let mediaMetadata: any = null;

        try {
            const tmdb = await lookupMedia(title);
            if (tmdb && tmdb.found) {
                cleanTitle = tmdb.title;
                cleanYear = tmdb.year || cleanYear;
                mediaMetadata = tmdb;
                if (tmdb.type === "series" && type === "movie") {
                    type = "series";
                }
            }
        } catch (e: any) {
            console.warn(`[SEARCH] TMDB resolution fallback: ${e.message}`);
        }

        const query = type === "movie"
            ? `${cleanTitle} ${cleanYear}`.trim()
            : cleanTitle;

        console.log(`[SEARCH] Query: "${query}"`);

        // Jellyfin check
        if (type === "movie") {
            const jf = await checkMovieExists(cleanTitle, cleanYear);
            if (jf.exists) {
                return res.json({ searchId, status: "skipped", message: `"${cleanTitle}" already in Jellyfin`, results: [], mediaMetadata });
            }
        } else {
            const jf = await checkSeriesExists(cleanTitle);
            if (jf.exists) {
                return res.json({ searchId, status: "skipped", message: `"${cleanTitle}" already in Jellyfin`, results: [], mediaMetadata });
            }
        }

        const bot = type === "movie" ? "ProSearchM11Bot" : "ProSearchY11Bot";
        const botClient = (await import("../../module/bot/bot.js")).default;
        const results: { text: string; sizeMB: number; season?: number; episode?: number }[] = [];
        const allPaged: { globalIndex: number; text: string; sizeMB: number; page: number; row: number; col: number }[] = [];
        let primaryBtnMsg: any = null;

        if (type === "movie") {
            console.log(`[SEARCH] Sending movie query to @${bot}: "${query}"`);
            const sent = await botClient.sendMessage(bot, { message: query });
            await new Promise(r => setTimeout(r, 4000));

            let btnMsg: any = null;
            let messages = await botClient.getMessages(bot, { limit: 10 });
            for (const msg of messages) {
                if (msg.id === sent.id) continue;
                const buttons = await msg.getButtons();
                if (buttons && buttons.length > 0) { btnMsg = msg; break; }
            }

            if (!btnMsg) {
                await new Promise(r => setTimeout(r, 3000));
                messages = await botClient.getMessages(bot, { limit: 10 });
                for (const msg of messages) {
                    if (msg.id === sent.id) continue;
                    const buttons = await msg.getButtons();
                    if (buttons && buttons.length > 0) { btnMsg = msg; break; }
                }
            }

            if (btnMsg) {
                primaryBtnMsg = btnMsg;
                let currentMsg = btnMsg;
                const seenTexts = new Set<string>();
                const MAX_PAGES = 10;

                for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
                    const buttons = (await currentMsg.getButtons()) || [];
                    let nextBtn: any = null;

                    for (let r = 0; r < buttons.length; r++) {
                        for (let c = 0; c < buttons[r].length; c++) {
                            const btn = buttons[r][c];
                            const text = ((btn as any).text || "").trim();
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
                                        // Last page
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
                                allPaged.push({
                                    globalIndex: allPaged.length + 1,
                                    text,
                                    sizeMB,
                                    page: pageNum,
                                    row: r,
                                    col: c,
                                });
                                results.push({ text, sizeMB });
                            }
                        }
                    }

                    if (nextBtn && pageNum < MAX_PAGES) {
                        try {
                            await nextBtn.click({});
                            await new Promise(res => setTimeout(res, 1500));
                            const msgs = await botClient.getMessages(bot, { ids: [btnMsg.id] });
                            if (msgs && msgs[0]) {
                                currentMsg = msgs[0];
                            } else {
                                break;
                            }
                        } catch {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
        } else {
            // TV Series: Strictly query episode-by-episode using TMDB episode counts (format: Name SXXEXX)
            const targetSeasons: number[] = [];
            const multiMatch = title.match(/(?:seasons?|s)\s*([\d\s,–\-and]+)/i);
            if (multiMatch) {
                const nums = multiMatch[1].match(/\d+/g);
                if (nums) targetSeasons.push(...nums.map(Number));
            } else {
                const sMatch = title.match(/\bS(\d{1,2})\b/i) || title.match(/\bSeason\s*(\d{1,2})\b/i);
                if (sMatch) targetSeasons.push(parseInt(sMatch[1], 10));
            }

            if (targetSeasons.length === 0) {
                const totalS = mediaMetadata?.totalSeasons || 1;
                for (let i = 1; i <= totalS; i++) targetSeasons.push(i);
            }

            console.log(`[SEARCH] Series episode-by-episode search for "${cleanTitle}" across seasons [${targetSeasons.join(", ")}]`);

            for (const s of targetSeasons) {
                const epCount = mediaMetadata?.episodesPerSeason?.[s - 1] || 10;
                for (let e = 1; e <= epCount; e++) {
                    const epTag = `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
                    const queryText = `${cleanTitle} ${epTag}`;
                    try {
                        const sent = await botClient.sendMessage(bot, { message: queryText });
                        let matched = false;
                        for (let attempt = 0; attempt < 4; attempt++) {
                            await new Promise(r => setTimeout(r, 1500));
                            const msgs = await botClient.getMessages(bot, { limit: 10 });
                            for (const msg of msgs) {
                                if (msg.id <= sent.id) continue;
                                const buttons = await msg.getButtons();
                                if (buttons && buttons.length > 0) {
                                    if (!primaryBtnMsg) primaryBtnMsg = msg;
                                    for (const row of buttons) {
                                        for (const btn of row) {
                                            const text = (btn as any).text || "";
                                            if (!text) continue;
                                            const lower = text.toLowerCase();
                                            if (lower.includes("srt") || lower.includes("sub")) continue;
                                            const sizeMB = extractSizeMB(text);
                                            if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;
                                            results.push({ text, sizeMB, season: s, episode: e });
                                        }
                                    }
                                    matched = true;
                                    break;
                                }
                                const text = msg.message || "";
                                if (text.toLowerCase().includes("no results found") || text.toLowerCase().includes("not found")) {
                                    matched = true;
                                    break;
                                }
                            }
                            if (matched) break;
                        }
                    } catch (err: any) {
                        console.error(`[SEARCH] Error querying "${queryText}":`, err.message);
                    }
                }
            }
        }

        if (results.length === 0 || !primaryBtnMsg) {
            return res.json({ searchId, status: "no_results", message: "Bot did not respond with results", results: [], mediaMetadata });
        }

        searchSessions.set(searchId, {
            bot,
            sentId: 0,
            btnMsgId: primaryBtnMsg.id,
            btnMsg: primaryBtnMsg,
            type,
            title: cleanTitle,
            year: cleanYear,
            pagedResults: allPaged,
            createdAt: Date.now(),
        });

        for (const [k, v] of searchSessions) {
            if (Date.now() - v.createdAt > 30 * 60 * 1000) searchSessions.delete(k);
        }

        let bestIdx = -1;
        let bestReason = "";
        if (results.length > 0) {
            const best = await pickBestResult(cleanTitle, type, results as any);
            bestIdx = best.index;
            bestReason = best.reason;
        }

        let seriesEpisodes: any[] = [];
        let uniqueSeasons: number[] = [];
        if (type === "series" && results.length > 0) {
            seriesEpisodes = groupByEpisode(results);
            uniqueSeasons = [...new Set(seriesEpisodes.map(e => e.season))].sort((a, b) => a - b);
        }

        console.log(`[SEARCH] Found ${results.length} results, best: #${bestIdx + 1} (${bestReason}), episodes: ${seriesEpisodes.length}`);
        return res.json({
            searchId, status: "results", title: cleanTitle, year: cleanYear,
            results, bestIdx, bestReason, seriesEpisodes, uniqueSeasons, mediaMetadata
        });

    } catch (err: any) {
        console.error(`[SEARCH] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── SELECT & DOWNLOAD ───

app.post("/api/select", requireAuth, async (req: any, res) => {
    const { searchId, buttonText } = req.body;
    if (!searchId || !buttonText) return res.status(400).json({ error: "searchId and buttonText required" });

    const session = searchSessions.get(searchId);
    if (!session) return res.status(400).json({ error: "Search session expired or not found" });

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
        // ─── HARNESS RULE 1: LANGUAGE RESTRICTION (ONLY BENGALI, HINDI, ENGLISH) ───
        const langCheck = isAllowedDownloadLanguage(buttonText || session.title);
        if (!langCheck.allowed) {
            return res.status(400).json({
                error: `You can't download this movie release (${langCheck.detectedLanguage}). Only Hindi, Bengali, and English (or Dual/Multi Audio) languages are supported.`
            });
        }

        // ─── HARNESS RULE 2: RESOLUTION CHECK (>720p BAN WARNING) ───
        const resCheck = checkResolutionHarnessRule(buttonText);
        if (resCheck.isHighRes) {
            const harness = getHarness();
            harness.logActivity(`[HARNESS RULE WARNING] High resolution download (${resCheck.resolution}) queued for "${session.title}" - Ban warning issued.`);
        }

        const typeLabel = session.type === "movie" ? "movie" : "series";
        await db.insert(schema.downloads).values({
            requestId,
            title: session.title,
            year: session.year || null,
            type: typeLabel,
            status: "queued",
            requestedBy: req.user.userId,
        });

        broadcastNewDownload({
            jobId: requestId,
            title: session.title,
            type: typeLabel,
            requestedBy: req.user.email,
        });

        const sizeMatch = buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
        const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;

        await updateDB(requestId, { status: "queued", fileSize });

        const matchingPaged = session.pagedResults?.find((p: any) => p.text === buttonText || p.text.toLowerCase().includes(buttonText.toLowerCase()));
        let securedInfo: { savedMsgId: number; fileName: string; totalSize: number } | null = null;
        try {
            if (session.btnMsg) {
                securedInfo = await secureBotFileToSavedMessages(
                    session.bot,
                    session.btnMsg,
                    buttonText,
                    matchingPaged?.page || 1,
                    matchingPaged?.row,
                    matchingPaged?.col
                );
            }
        } catch (secErr: any) {
            console.log(`[SELECT] Pre-secure notice: ${secErr?.message || secErr}`);
        }

        downloadQueue.addJob({
            requestId,
            bot: session.bot,
            btnMsgId: session.btnMsg?.id || 0,
            type: session.type,
            title: session.title,
            year: session.year,
            fileSize: fileSize || undefined,
            buttonText,
            page: matchingPaged?.page || 1,
            buttonRow: matchingPaged?.row,
            buttonCol: matchingPaged?.col,
            savedMsgId: securedInfo?.savedMsgId,
            fileName: securedInfo?.fileName,
            fileSizeBytes: securedInfo?.totalSize,
        });

        searchSessions.delete(searchId);

        return res.json({
            success: true,
            requestId,
            message: `Download queued for "${session.title}"`,
            warning: resCheck.isHighRes ? resCheck.warningMessage : null,
        });

    } catch (err: any) {
        console.error(`[SELECT] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── SERIES BULK DOWNLOAD ───

app.post("/api/select-all-episodes", requireAuth, async (req: any, res) => {
    const { searchId, season } = req.body;
    if (!searchId) return res.status(400).json({ error: "searchId required" });

    const session = searchSessions.get(searchId);
    if (!session) return res.status(400).json({ error: "Search session expired" });
    if (session.type !== "series") return res.status(400).json({ error: "Not a series" });

    const seasonNum = season || 1;

    try {
        const btnMsg = session.btnMsg;
        const buttons = (await btnMsg.getButtons())!;
        const allResults: { text: string; sizeMB: number }[] = [];
        for (const row of buttons) {
            for (const btn of row) {
                const text = (btn as any).text || "";
                if (!text) continue;
                const lower = text.toLowerCase();
                if (lower.includes("srt") || lower.includes("sub")) continue;
                const sizeMB = extractSizeMB(text);
                if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;
                allResults.push({ text, sizeMB });
            }
        }

        const grouped = groupByEpisode(allResults);
        const seasonEps = grouped.filter(e => e.season === seasonNum);

        console.log(`[BULK] Season ${seasonNum}: ${seasonEps.length} episodes found`);

        const queued: { episode: number; title: string; status: string; sizeMB: number }[] = [];

        for (const ep of seasonEps) {
            const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const epLabel = `${session.title} ${ep.label}`;

            try {
                await db.insert(schema.downloads).values({
                    requestId,
                    title: epLabel,
                    year: session.year || null,
                    type: "series",
                    status: "queued",
                    season: ep.season,
                    episode: ep.episode,
                    fileSize: `${ep.sizeMB.toFixed(0)} MB`,
                    requestedBy: req.user.userId,
                });

                downloadQueue.addJob({
                    requestId,
                    bot: session.bot,
                    btnMsgId: btnMsg.id,
                    type: "series",
                    title: epLabel,
                    year: session.year,
                    buttonText: ep.text,
                });

                queued.push({ episode: ep.episode, title: ep.label, status: "queued", sizeMB: ep.sizeMB });
            } catch (epErr: any) {
                console.error(`[BULK] Error on ${ep.label}:`, epErr.message);
                queued.push({ episode: ep.episode, title: ep.label, status: "error", sizeMB: 0 });
            }
        }

        searchSessions.delete(searchId);

        const totalSize = queued.reduce((sum, q) => sum + q.sizeMB, 0);
        return res.json({
            success: true,
            title: session.title,
            season: seasonNum,
            total: seasonEps.length,
            queued: queued.filter(q => q.status === "queued").length,
            totalSizeMB: Math.round(totalSize),
            episodes: queued,
        });

    } catch (err: any) {
        console.error(`[BULK] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── DOWNLOADS API ───

app.get("/api/downloads", requireAuth, async (req: any, res) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = (req.query.search as string) || "";

    const whereClause = search ? like(schema.downloads.title, `%${search}%`) : undefined;

    const totalResult = whereClause
        ? await db.select({ count: count() }).from(schema.downloads).where(whereClause)
        : await db.select({ count: count() }).from(schema.downloads);

    const items = whereClause
        ? await db.select().from(schema.downloads).where(whereClause).orderBy(desc(schema.downloads.createdAt)).limit(limit).offset(offset)
        : await db.select().from(schema.downloads).orderBy(desc(schema.downloads.createdAt)).limit(limit).offset(offset);

    res.json({
        downloads: items,
        pagination: { page, limit, total: Number(totalResult[0].count), pages: Math.ceil(Number(totalResult[0].count) / limit) },
    });
});

// ─── DOWNLOAD ACTIONS ───

app.post("/api/downloads/:id/pause", requireAuth, async (req: any, res) => {
    const { id } = req.params;
    downloadQueue.pauseJob(id);
    await db.update(schema.downloads).set({ status: "paused" }).where(eq(schema.downloads.requestId, id));
    res.json({ success: true, message: "Download paused" });
});

app.post("/api/downloads/:id/resume", requireAuth, async (req: any, res) => {
    const { id } = req.params;
    downloadQueue.resumeJob(id);
    await db.update(schema.downloads).set({ status: "queued" }).where(eq(schema.downloads.requestId, id));
    res.json({ success: true, message: "Download resumed" });
});

app.post("/api/downloads/:id/retry", requireAuth, async (req: any, res) => {
    const { id } = req.params;
    downloadQueue.retryJob(id);
    await db.update(schema.downloads).set({ status: "queued", error: null }).where(eq(schema.downloads.requestId, id));
    res.json({ success: true, message: "Download retry queued" });
});

app.delete("/api/downloads/:id", requireAuth, async (req: any, res) => {
    const { id } = req.params;
    downloadQueue.cancelJob(id);
    await db.delete(schema.downloads).where(eq(schema.downloads.requestId, id));
    res.json({ success: true, message: "Download cancelled and removed" });
});

app.delete("/api/downloads/clear/failed", requireAuth, async (_req: any, res) => {
    downloadQueue.clearFailed();
    await db.delete(schema.downloads).where(eq(schema.downloads.status, "failed"));
    res.json({ success: true, message: "Failed downloads cleared" });
});

app.delete("/api/downloads/clear/all", requireAuth, async (_req: any, res) => {
    downloadQueue.clearFailed();
    await db.delete(schema.downloads).where(sql`status IN ('completed', 'failed', 'cancelled')`);
    res.json({ success: true, message: "Download history cleared" });
});

// ─── REQUESTED MEDIA API ───

app.get("/api/requested-media", requireAuth, async (_req, res) => {
    try {
        const items = await db.select().from(schema.requestedMedia).orderBy(desc(schema.requestedMedia.createdAt)).limit(100);
        res.json({ items });
    } catch (err: any) {
        res.status(500).json({ error: err.message, items: [] });
    }
});

app.post("/api/requested-media", requireAuth, async (req: any, res) => {
    try {
        const { title, type, year } = req.body;
        if (!title) return res.status(400).json({ error: "Title required" });
        await db.insert(schema.requestedMedia).values({
            title: title.trim(),
            type: type === "series" ? "series" : "movie",
            year: year || null,
            status: "requested",
            requestedBy: req.user.email,
        });
        res.json({ success: true, message: `Added "${title}" to requested list` });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/requested-media/:id", requireAuth, async (req: any, res) => {
    try {
        const id = Number(req.params.id);
        await db.delete(schema.requestedMedia).where(eq(schema.requestedMedia.id, id));
        res.json({ success: true, message: "Entry removed" });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/requested-media/clear", requireAuth, async (_req: any, res) => {
    try {
        await db.delete(schema.requestedMedia);
        res.json({ success: true, message: "All requested media cleared" });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});


// ─── JELLYFIN API ───

app.get("/api/jellyfin/stats", requireAuth, async (_req, res) => {
    const stats = await getLibraryStats();
    res.json(stats);
});

app.get("/api/jellyfin/movies", requireAuth, async (_req, res) => {
    const items = await getAllMovies();
    res.json({ items });
});

app.get("/api/jellyfin/series", requireAuth, async (_req, res) => {
    const items = await getAllSeries();
    res.json({ items });
});

app.get("/api/jellyfin/shows", requireAuth, async (_req, res) => {
    const items = await getAllSeries();
    res.json({ items });
});

app.get("/api/jellyfin/check", requireAuth, async (req, res) => {
    const title = req.query.title as string;
    const year = req.query.year as string;
    const type = (req.query.type as string) || "movie";
    if (!title) return res.status(400).json({ error: "Title required" });
    if (type === "series") {
        res.json(await checkSeriesExists(title));
    } else {
        res.json(await checkMovieExists(title, year));
    }
});

// ─── QUEUE STATUS ───

app.get("/api/queue", requireAuth, (_req, res) => {
    res.json({ stats: downloadQueue.getStats() });
});

// ─── TELEGRAM AUDIT LOGS ───

import { getRecentTelegramAuditLogs, getTelegramAuditLogFilePath } from "../../common/logger/telegram-audit.js";

app.get("/api/telegram-logs", requireAuth, (req: any, res) => {
    const limit = Number(req.query.limit) || 50;
    const logs = getRecentTelegramAuditLogs(limit);
    res.json({
        logFile: getTelegramAuditLogFilePath(),
        count: logs.length,
        logs
    });
});

// ─── CHAT AGENT ───

app.post("/api/chat", requireAuth, async (req: any, res) => {
    try {
        const { message, history, sessionId } = req.body;
        if (!message) return res.status(400).json({ error: "Message required" });

        const sid = sessionId || `chat_${req.user.userId}_${Date.now()}`;
        console.log(`[CHAT] User: ${message} (session: ${sid})`);
        const result = await handleChat(message, history || [], sid);

        res.json({ ...result, sessionId: sid });
    } catch (err: any) {
        console.error(`[CHAT] Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── INNGEST SERVE ───

import { serve } from "inngest/express";
import { inngest } from "../inngest/client.js";
import { mediaRequestWorkflow, movieSearchWorkflow, seriesSearchWorkflow, downloadWorkflow } from "../inngest/functions.js";

const inngestApp = serve({
    client: inngest,
    functions: [mediaRequestWorkflow, movieSearchWorkflow, seriesSearchWorkflow, downloadWorkflow],
});
app.use("/api/inngest", inngestApp);

// ─── PAGES & ROUTES ───

const pageRoutes = [
    "/", "/ai",
    "/download", "/downloads", "/downlaod",
    "/request", "/requests", "/requested",
    "/jellyfin",
    "/telegram", "/bot",
    "/user", "/users",
    "/admin",
    "/studio", "/search"
];

app.get(pageRoutes, (req, res) => {
    const user = extractUser(req);
    if (!user) return res.redirect("/login");

    const path = req.path.toLowerCase();
    let initialView = "chat";
    if (path.startsWith("/download") || path.startsWith("/downlaod")) initialView = "downloads";
    else if (path.startsWith("/request")) initialView = "requested";
    else if (path.startsWith("/jellyfin")) initialView = "jellyfin";
    else if (path.startsWith("/telegram") || path.startsWith("/bot")) initialView = "bot";
    else if (path.startsWith("/user") || path.startsWith("/admin")) initialView = "admin";
    else if (path.startsWith("/studio") || path.startsWith("/search")) initialView = "studio";
    else initialView = "chat";

    res.send(getDashboardPage(user, initialView));
});

app.get("/login", (req, res) => {
    if (extractUser(req)) return res.redirect("/");
    res.send(getLoginPage());
});

app.get("/register", (req, res) => {
    if (extractUser(req)) return res.redirect("/");
    res.send(getRegisterPage());
});

// ─── HELPERS ───

async function updateDB(requestId: string, updates: Record<string, any>) {
    try {
        await db.update(schema.downloads).set({ ...updates, updatedAt: new Date() }).where(eq(schema.downloads.requestId, requestId));
    } catch (err) {
        console.error("[DB] Update error:", err);
    }
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

// ─── UI TEMPLATES ───

function getLoginPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sign In - CineGrab</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div class="auth-page-container">
        <div class="auth-glass-box">
            <div class="auth-header">
                <div class="brand-icon-box" style="width: 36px; height: 36px;">
                    <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/><path d="M4 8l4 0"/><path d="M4 16l4 0"/><path d="M4 12l16 0"/><path d="M16 8l4 0"/><path d="M16 16l4 0"/></svg>
                </div>
                <div>
                    <h1 style="font-size: 20px; font-weight: 700;">Sign in to CineGrab</h1>
                    <p style="font-size: 12.5px; color: var(--text-secondary); margin-top: 2px;">Enter your credentials to access the hub</p>
                </div>
            </div>
            <div class="auth-error-alert" id="authError"></div>
            <form class="auth-form" onsubmit="handleAuthLogin(event)">
                <div class="form-group">
                    <label class="form-label">Email</label>
                    <input type="email" id="email" class="form-input" required placeholder="admin@admin.com" autocomplete="email">
                </div>
                <div class="form-group">
                    <label class="form-label">Password</label>
                    <input type="password" id="password" class="form-input" required placeholder="••••••••" autocomplete="current-password">
                </div>
                <button type="submit" id="btnAuthSubmit" class="btn-primary-action" style="width: 100%; padding: 10px; margin-top: 4px;">
                    Sign In
                </button>
            </form>
            <div class="auth-links">
                Don't have an account? <a href="/register">Create one</a>
            </div>
        </div>
    </div>
    <script src="/js/auth.js"></script>
</body>
</html>`;
}

function getRegisterPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Create Account - CineGrab</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <div class="auth-page-container">
        <div class="auth-glass-box">
            <div class="auth-header">
                <div class="brand-icon-box" style="width: 36px; height: 36px;">
                    <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/><path d="M4 8l4 0"/><path d="M4 16l4 0"/><path d="M4 12l16 0"/><path d="M16 8l4 0"/><path d="M16 16l4 0"/></svg>
                </div>
                <div>
                    <h1 style="font-size: 20px; font-weight: 700;">Create an Account</h1>
                    <p style="font-size: 12.5px; color: var(--text-secondary); margin-top: 2px;">Join CineGrab Media Manager</p>
                </div>
            </div>
            <div class="auth-error-alert" id="authError"></div>
            <form class="auth-form" onsubmit="handleAuthRegister(event)">
                <div class="form-group">
                    <label class="form-label">Full Name</label>
                    <input type="text" id="name" class="form-input" required placeholder="John Doe" autocomplete="name">
                </div>
                <div class="form-group">
                    <label class="form-label">Email</label>
                    <input type="email" id="email" class="form-input" required placeholder="you@example.com" autocomplete="email">
                </div>
                <div class="form-group">
                    <label class="form-label">Password</label>
                    <input type="password" id="password" class="form-input" required minlength="6" placeholder="Min 6 characters" autocomplete="new-password">
                </div>
                <button type="submit" id="btnAuthSubmit" class="btn-primary-action" style="width: 100%; padding: 10px; margin-top: 4px;">
                    Create Account
                </button>
            </form>
            <div class="auth-links">
                Already have an account? <a href="/login">Sign in</a>
            </div>
        </div>
    </div>
    <script src="/js/auth.js"></script>
</body>
</html>`;
}

function getDashboardPage(user: any, initialView: string = "chat"): string {
    const isAdmin = user.role === "admin";
    const activeView = initialView || "chat";
    const userJson = JSON.stringify({
        id: user.userId || user.id,
        name: user.name || (user.email ? user.email.split("@")[0] : "User"),
        email: user.email || "user@example.com",
        role: user.role || "user"
    });

    const titles: Record<string, string> = {
        chat: "AI Copilot Assistant",
        downloads: "Download Station",
        requested: "Requested Media Hub",
        jellyfin: "Jellyfin Media Hub",
        bot: "Telegram Bot",
        admin: "User Management",
        studio: "Search & Discover Studio"
    };

    const headerTitle = titles[activeView] || "AI Copilot Assistant";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>CineGrab - ${headerTitle}</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/style.css">
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
    <div class="app-container">
        <!-- Sidebar Navigation -->
        <aside class="app-sidebar" id="appSidebar">
            <div class="sidebar-header">
                <a href="/" class="brand-logo" onclick="navigateRoute(event, 'chat')">
                    <div class="brand-icon-box">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/><path d="M4 8l4 0"/><path d="M4 16l4 0"/><path d="M4 12l16 0"/><path d="M16 8l4 0"/><path d="M16 16l4 0"/></svg>
                    </div>
                    <span class="brand-name">CineGrab</span>
                    <span class="brand-tag">Studio</span>
                </a>
                <button class="sidebar-toggle-btn" onclick="toggleSidebar()">
                    <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>
                </button>
            </div>

            <div class="sidebar-content">
                <div>
                    <div class="nav-group-title">Navigation</div>
                    <nav class="sidebar-nav">
                        <a class="nav-link ${activeView === 'chat' ? 'active' : ''}" href="/" data-view="chat" onclick="navigateRoute(event, 'chat')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/></svg>
                            <span>AI Copilot</span>
                        </a>
                        <a class="nav-link ${activeView === 'downloads' ? 'active' : ''}" href="/download" data-view="downloads" onclick="navigateRoute(event, 'downloads')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                            <span>Download Station</span>
                            <span class="nav-badge" id="activeDownloadsBadge" style="display:none">0</span>
                        </a>
                        <a class="nav-link ${activeView === 'requested' ? 'active' : ''}" href="/request" data-view="requested" onclick="navigateRoute(event, 'requested')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M19 4v16h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12z"/><path d="M19 16h-12a2 2 0 0 0 -2 2"/><path d="M9 8h6"/></svg>
                            <span>Requested Media</span>
                        </a>
                        <a class="nav-link ${activeView === 'jellyfin' ? 'active' : ''}" href="/jellyfin" data-view="jellyfin" onclick="navigateRoute(event, 'jellyfin')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                            <span>Jellyfin Library</span>
                        </a>
                        <a class="nav-link ${activeView === 'bot' ? 'active' : ''}" href="/telegram" data-view="bot" onclick="navigateRoute(event, 'bot')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M15 10l-4 4l6 6l4 -16l-18 7l4 2l2 6l3 -4"/></svg>
                            <span>Telegram Bot</span>
                        </a>
                        ${isAdmin ? `
                        <a class="nav-link ${activeView === 'admin' ? 'active' : ''}" href="/user" data-view="admin" onclick="navigateRoute(event, 'admin')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/></svg>
                            <span>User Management</span>
                        </a>` : ""}
                    </nav>
                </div>
            </div>

            <div class="sidebar-footer">
                <div class="user-card" id="userCardTrigger" onclick="toggleUserMenu()">
                    <div class="user-avatar">${(user.name || user.email || "U").charAt(0).toUpperCase()}</div>
                    <div class="user-info">
                        <div class="user-name">${user.name || (user.email ? user.email.split("@")[0] : "User")}</div>
                        <div class="user-role-badge">${user.role || "user"}</div>
                    </div>
                </div>

                <div class="user-popover hidden" id="userPopover">
                    <button class="popover-item" onclick="startNewChat()">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M12 5l0 14"/><path d="M5 12l14 0"/></svg>
                        New Chat Session
                    </button>
                    ${isAdmin ? `
                    <button class="popover-item" onclick="navigateRoute(event, 'admin')">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>
                        Admin Panel
                    </button>` : ""}
                    <button class="popover-item danger" onclick="logoutUser()">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2"/><path d="M9 12h12l-3 -3"/><path d="M18 15l3 -3"/></svg>
                        Log Out
                    </button>
                </div>
            </div>
        </aside>

        <!-- Main Content Area -->
        <main class="app-main">
            <!-- Header Bar -->
            <header class="main-header">
                <div class="header-left">
                    <button class="sidebar-toggle-btn" onclick="toggleSidebar()">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 6l16 0"/><path d="M4 12l16 0"/><path d="M4 18l16 0"/></svg>
                    </button>
                    <div class="header-title-wrap">
                        <h2 class="header-view-title" id="headerViewTitle">${headerTitle}</h2>
                        <div class="bot-status-pill" onclick="navigateRoute(event, 'bot')">
                            <span class="status-dot connecting" id="headerBotDot"></span>
                            <span id="headerBotStatusText" style="font-size:11.5px;">Checking bot...</span>
                        </div>
                    </div>
                </div>
                <div class="header-right">
                    <button class="btn-header" onclick="navigateRoute(event, 'studio')">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>
                        Search
                    </button>
                    <button class="btn-header primary" onclick="startNewChat()">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M12 5l0 14"/><path d="M5 12l14 0"/></svg>
                        New Chat
                    </button>
                </div>
            </header>

            <!-- VIEW 1: AI COPILOT CHAT -->
            <section class="view-container ${activeView === 'chat' ? 'active' : ''}" id="view-chat">
                <div class="chat-scroll-area" id="chatMessagesBox">
                    <div class="chat-welcome-card">
                        <div class="welcome-icon-box">
                            <svg class="tabler-icon" style="width:24px;height:24px;" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/><path d="M4 8l4 0"/><path d="M4 16l4 0"/><path d="M4 12l16 0"/><path d="M16 8l4 0"/><path d="M16 16l4 0"/></svg>
                        </div>
                        <h2>Search Movies to add on movie.pallabdev.in</h2>
                        <p>Type any movie title to check releases and download directly to your streaming server.</p>
                    </div>
                </div>

                <div class="chat-input-container">
                    <div class="chat-input-bar">
                        <textarea id="chatInput" class="chat-textarea" placeholder="Search movies to add on movie.pallabdev.in (e.g. Inception 2010)..." rows="1"></textarea>
                        <button class="btn-chat-send" id="btnSendChat" onclick="sendChatMessage()" title="Send">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M10 14l11 -11"/><path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5"/></svg>
                        </button>
                    </div>
                </div>
            </section>

            <!-- VIEW 2: SEARCH & DISCOVER STUDIO -->
            <section class="view-container ${activeView === 'studio' ? 'active' : ''}" id="view-studio">
                <div class="studio-wrap">
                    <div class="studio-header">
                        <h1>Search & Discover Studio</h1>
                        <p>Direct search Telegram ProSearch Bots with instant quality matrix recommendations.</p>
                    </div>

                    <div class="studio-search-card">
                        <div class="search-type-tabs">
                            <button class="type-tab-btn active" id="studioTypeMovie" onclick="setStudioType('movie')">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/><path d="M4 8l4 0"/><path d="M4 16l4 0"/><path d="M4 12l16 0"/><path d="M16 8l4 0"/><path d="M16 16l4 0"/></svg>
                                Movie
                            </button>
                            <button class="type-tab-btn" id="studioTypeSeries" onclick="setStudioType('series')">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M3 7m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/><path d="M16 3l-4 4l-4 -4"/></svg>
                                TV Series
                            </button>
                        </div>
                        <div class="search-input-group">
                            <input type="text" id="studioSearchInput" class="form-input" placeholder="Title (e.g. Interstellar, Severance, Arcane)...">
                            <input type="text" id="studioYearInput" class="form-input" placeholder="Year (e.g. 2024)">
                            <button class="btn-primary-action" id="btnStudioSearch" onclick="performStudioSearch()">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>
                                Search Releases
                            </button>
                        </div>
                    </div>

                    <div class="studio-results-area" id="studioResultsArea">
                        <div style="text-align:center; padding: 40px; color: var(--text-muted);">
                            <div style="font-weight: 600; color: #fff; font-size: 14px;">Ready to Search</div>
                            <div style="font-size: 12.5px; margin-top: 4px;">Enter a title above to discover release qualities, file sizes, and season packs.</div>
                        </div>
                    </div>
                </div>
            </section>

            <!-- VIEW 3: LIVE DOWNLOAD STATION -->
            <section class="view-container ${activeView === 'downloads' ? 'active' : ''}" id="view-downloads">
                <div class="download-station-wrap">
                    <div class="metrics-row">
                        <div class="metric-card">
                            <div class="metric-icon-box active">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricActiveCount">0</div>
                                <div class="metric-label">Active Downloads</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box waiting">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricWaitingCount">0</div>
                                <div class="metric-label">Queued Jobs</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box completed">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricCompletedCount">0</div>
                                <div class="metric-label">Completed Files</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box failed">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricFailedCount">0</div>
                                <div class="metric-label">Failed / Retries</div>
                            </div>
                        </div>
                    </div>

                    <div class="active-downloads-section">
                        <div class="section-title-wrap">
                            <h2 style="font-size: 15px;">Active Live Streams</h2>
                        </div>
                        <div class="live-downloads-grid" id="liveDownloadsGrid"></div>
                        <div id="noActiveDownloadsMsg" style="text-align:center; padding: 24px; color: var(--text-muted); background: var(--bg-surface); border-radius: var(--radius-sm); border: 1px dashed var(--border-subtle);">
                            No active downloads in progress. Start one from AI Copilot or Search Studio.
                        </div>
                    </div>

                    <div class="history-card">
                        <div class="history-toolbar">
                            <div>
                                <h2 style="font-size: 15px;">Download History & Controls</h2>
                                <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">Manage active and completed Telegram file downloads.</p>
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <input type="text" id="historySearchFilter" class="search-filter-input" placeholder="Filter downloads..." oninput="loadDownloadHistory(1)">
                                <button class="btn-header" style="color: var(--accent-amber);" onclick="clearFailedDownloads()" title="Remove failed jobs">Clear Failed</button>
                                <button class="btn-header" style="color: var(--text-muted);" onclick="clearAllDownloads()" title="Clear completed and cancelled">Clear All</button>
                            </div>
                        </div>
                        <div class="data-table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>Title</th>
                                        <th>Type</th>
                                        <th>Size</th>
                                        <th>Status</th>
                                        <th>Date</th>
                                        <th style="text-align:right;">Actions</th>
                                    </tr>
                                </thead>
                                <tbody id="downloadHistoryTableBody">
                                    <tr><td colspan="6" style="text-align:center; padding: 20px;">Loading records...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </section>

            <!-- VIEW: DEDICATED REQUESTED MEDIA HUB -->
            <section class="view-container ${activeView === 'requested' ? 'active' : ''}" id="view-requested">
                <div class="download-station-wrap">
                    <div class="jf-hero-card">
                        <div>
                            <span class="chip quality">Watchlist & Queue</span>
                            <h1 style="font-size: 20px; margin: 6px 0 2px;">Requested Media Hub</h1>
                            <p style="color: var(--text-secondary); font-size: 12.5px;">All movies and TV series requested through AI Copilot and search queries.</p>
                        </div>
                        <div class="metric-icon-box active" style="width: 44px; height: 44px;">
                            <svg class="tabler-icon" style="width:24px;height:24px;" viewBox="0 0 24 24"><path d="M19 4v16h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12z"/><path d="M19 16h-12a2 2 0 0 0 -2 2"/><path d="M9 8h6"/></svg>
                        </div>
                    </div>

                    <div class="history-card" style="margin-top: 16px;">
                        <div class="history-toolbar">
                            <div style="display: flex; gap: 8px; align-items: center; flex: 1;">
                                <input type="text" id="requestedSearchFilter" class="search-filter-input" placeholder="Search requested titles..." oninput="loadRequestedMedia()">
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <button class="btn-header" style="color: var(--accent-rose);" onclick="clearAllRequestedMedia()">Clear All Requests</button>
                            </div>
                        </div>
                        <div class="data-table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>Title</th>
                                        <th>Type</th>
                                        <th>Year</th>
                                        <th>Status</th>
                                        <th>Requested Date</th>
                                        <th style="text-align:right;">Action</th>
                                    </tr>
                                </thead>
                                <tbody id="requestedMediaTableBody">
                                    <tr><td colspan="6" style="text-align:center; padding: 20px;">Loading requested media...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </section>

            <!-- VIEW 4: JELLYFIN MEDIA HUB -->
            <section class="view-container ${activeView === 'jellyfin' ? 'active' : ''}" id="view-jellyfin">
                <div class="jellyfin-wrap">
                    <div class="jf-hero-card">
                        <div>
                            <span class="chip jellyfin">Media Server</span>
                            <h1 style="font-size: 20px; margin: 6px 0 2px;">Jellyfin Integration</h1>
                            <p style="color: var(--text-secondary); font-size: 12.5px;">Direct library inspection prevents duplicate downloads.</p>
                        </div>
                        <div class="metric-icon-box completed" style="width: 44px; height: 44px;">
                            <svg class="tabler-icon" style="width:24px;height:24px;" viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                        </div>
                    </div>

                    <div class="jf-stats-grid">
                        <div class="metric-card">
                            <div class="metric-icon-box active">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="jfMoviesCount">--</div>
                                <div class="metric-label">Movies in Library</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box waiting">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M3 7m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="jfSeriesCount">--</div>
                                <div class="metric-label">TV Series in Library</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box completed">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="jfTotalCount">--</div>
                                <div class="metric-label">Total Library Items</div>
                            </div>
                        </div>
                    </div>

                    <div class="studio-search-card">
                        <h3 style="font-size: 14px;">Library Duplicate Checker</h3>
                        <p style="font-size: 12.5px; color: var(--text-secondary);">Test whether any title exists on your Jellyfin server before searching Telegram.</p>
                        <div style="display: flex; gap: 8px; margin-top: 8px;">
                            <input type="text" id="jfCheckInput" class="form-input" placeholder="Title (e.g. Breaking Bad, Dune)..." style="flex: 1;">
                            <button class="btn-primary-action" onclick="checkJellyfinItem()">Check Jellyfin</button>
                        </div>
                        <div id="jfCheckResultBox" style="display:none; margin-top: 10px; padding: 10px; background: var(--bg-input); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);"></div>
                    </div>
                </div>
            </section>

            <!-- VIEW 5: TELEGRAM BOT & 2FA CONTROL -->
            <section class="view-container ${activeView === 'bot' ? 'active' : ''}" id="view-bot">
                <div class="bot-center-wrap">
                    <div class="bot-connection-card">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <h2 style="font-size: 16px;">Telegram Bot Gateway</h2>
                                <p style="font-size: 12.5px; color: var(--text-secondary); margin-top: 2px;">MTProto client session and authentication state.</p>
                            </div>
                            <button class="btn-primary-action" onclick="startBotReconnect()">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                Reconnect Bot
                            </button>
                        </div>

                        <div class="bot-state-banner">
                            <div style="display:flex; align-items:center; gap: 10px;">
                                <div class="status-dot connecting" id="botCenterStatusDot"></div>
                                <div>
                                    <strong style="font-size: 13px; color: #fff;">MTProto Client Connection</strong>
                                    <div style="font-size: 11.5px; color: var(--text-secondary);" id="botCenterStatusDetail">Monitoring connection...</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div id="botAuthWizardArea" style="display:none;"></div>
                </div>
            </section>

            <!-- VIEW 6: ADMIN USER MANAGEMENT -->
            ${isAdmin ? `
            <section class="view-container ${activeView === 'admin' ? 'active' : ''}" id="view-admin">
                <div class="admin-wrap">
                    <div class="studio-search-card">
                        <h2 style="font-size: 15px;">Create New User</h2>
                        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 110px auto; gap: 8px; margin-top: 10px;">
                            <input type="text" id="adminNewName" class="form-input" placeholder="Name">
                            <input type="email" id="adminNewEmail" class="form-input" placeholder="Email">
                            <input type="password" id="adminNewPass" class="form-input" placeholder="Password">
                            <select id="adminNewRole" class="form-input" style="background: var(--bg-input);">
                                <option value="user">User</option>
                                <option value="admin">Admin</option>
                            </select>
                            <button class="btn-primary-action" onclick="addAdminUser()">Add User</button>
                        </div>
                    </div>

                    <div class="history-card">
                        <h2 style="font-size: 15px;">Registered Users</h2>
                        <div class="data-table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Email</th>
                                        <th>Role</th>
                                        <th>Registered</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody id="adminUsersTableBody">
                                    <tr><td colspan="5" style="text-align:center; padding: 20px;">Loading users...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </section>` : ""}
        </main>
    </div>

    <script>
        window.__APP_USER__ = ${userJson};
        window.__INITIAL_VIEW__ = "${activeView}";
    </script>
    <script src="/js/app.js"></script>
</body>
</html>`;
}

export function startServer(port: number) {
    const server = app.listen(port, () => {
        console.log(`[WEB] Server running at http://localhost:${port}`);
        console.log(`[WEB] Dashboard: http://localhost:${port}/`);
    });
    return server;
}

export { app };

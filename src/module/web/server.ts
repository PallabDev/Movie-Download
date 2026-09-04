import express from "express";
import cookieParser from "cookie-parser";
import { db, schema } from "../../common/db/index.js";
import { eq, desc, like, sql, count } from "drizzle-orm";
import { register, login, extractUser, getAllUsers, updateUser, deleteUser, type UserRole } from "../../common/auth/auth.js";
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
    searchTV as tmdbSearchTV,
    syncIndianOTTReleasesToDB,
    discoverIndianOTTReleases
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

function requireMod(req: any, res: any, next: any) {
    const user = extractUser(req);
    if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    if (user.role !== "admin" && user.role !== "mod") {
        return res.status(403).json({ error: "Moderator or Admin access required" });
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
        if (existingUsers.length > 0) {
            return res.status(403).json({ error: "Public registration is disabled. Only administrators can create new accounts." });
        }
        const user = await register(email, password, name, "admin");
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

app.post("/api/admin/users", requireAdmin, async (req, res) => {
    try {
        const { email, password, name, role } = req.body;
        if (!email || !password || !name) {
            return res.status(400).json({ error: "Name, email, and password required" });
        }
        const userRole = (role === "admin" || role === "mod" || role === "user") ? role : "user";
        const user = await register(email, password, name, userRole as UserRole);
        res.json({ success: true, user });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

app.put("/api/admin/users/:id", requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid user ID" });
        const { name, email, role, password } = req.body;
        const user = await updateUser(id, { name, email, role, password });
        res.json({ success: true, user });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

app.delete("/api/admin/users/:id", requireAdmin, async (req: any, res) => {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid user ID" });
    if (req.user?.userId === id) {
        return res.status(400).json({ error: "You cannot delete your own account" });
    }
    await deleteUser(id);
    res.json({ success: true });
});

// ─── BOT STATUS & WEB AUTH ───

app.get("/api/bot/status", requireMod, (_req, res) => {
    const auth = getAuthState();
    res.json({ connected: isBotConnected(), connecting: isBotConnecting(), auth });
});

app.post("/api/bot/reconnect", requireMod, async (_req, res) => {
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

app.post("/api/bot/auth/phone", requireMod, async (req, res) => {
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

app.post("/api/bot/auth/code", requireMod, async (req, res) => {
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

app.post("/api/bot/auth/password", requireMod, async (req, res) => {
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

app.get("/api/bot/auth/status", requireMod, (_req, res) => {
    const state = getAuthState();
    return res.json(state);
});

// ─── TMDB DISCOVERY ENDPOINTS ───

app.get("/api/tmdb/search", requireMod, async (req: any, res) => {
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

app.get("/api/tmdb/details", requireMod, async (req: any, res) => {
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

app.get("/api/tmdb/seasons", requireMod, async (req: any, res) => {
    try {
        const title = (req.query.title as string || "").trim();
        if (!title) return res.status(400).json({ error: "Title required" });

        const info = await getSeriesSeasonsAndEpisodes(title);
        return res.json(info);
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

app.get("/api/tmdb/episodes", requireMod, async (req: any, res) => {
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

// ─── NEW INDIAN OTT RELEASES API ───

let cachedJellyfinMovies: { title: string; cleanTitle: string; year?: string; name: string }[] | null = null;
let lastJellyfinFetch = 0;

async function getCachedJellyfinMovies() {
    const now = Date.now();
    if (cachedJellyfinMovies && now - lastJellyfinFetch < 30000) {
        return cachedJellyfinMovies;
    }
    try {
        const jfItems = await getAllMovies();
        cachedJellyfinMovies = (jfItems || []).map(item => ({
            name: item.Name,
            title: item.Name.toLowerCase().trim(),
            cleanTitle: item.Name.toLowerCase().replace(/[^a-z0-9]/g, ""),
            year: item.Year ? String(item.Year) : undefined,
        }));
        lastJellyfinFetch = now;
    } catch {
        cachedJellyfinMovies = cachedJellyfinMovies || [];
    }
    return cachedJellyfinMovies;
}

function checkMovieInLibrary(title: string, year?: string | null, originalTitle?: string | null, jfList: { title: string; cleanTitle: string; year?: string; name: string }[] = []): boolean {
    if (!title || jfList.length === 0) return false;
    
    const cleanT = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const cleanOrig = (originalTitle || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const targetYear = year ? String(year).trim() : "";

    for (const item of jfList) {
        // 1. Exact match on normalized alphanumeric string
        if (item.cleanTitle === cleanT || (cleanOrig && item.cleanTitle === cleanOrig)) {
            return true;
        }

        // 2. Year check with substring match
        const yearMatches = !targetYear || !item.year || item.year === targetYear || Math.abs(Number(item.year) - Number(targetYear)) <= 1;

        if (yearMatches) {
            if (cleanT.length >= 4 && item.cleanTitle.length >= 4) {
                if (cleanT.includes(item.cleanTitle) || item.cleanTitle.includes(cleanT)) {
                    return true;
                }
            }
            if (cleanOrig && cleanOrig.length >= 4 && item.cleanTitle.length >= 4) {
                if (cleanOrig.includes(item.cleanTitle) || item.cleanTitle.includes(cleanOrig)) {
                    return true;
                }
            }
        }
    }

    return false;
}

app.get("/api/new-releases", requireMod, async (req: any, res) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 24));
        const offset = (page - 1) * limit;

        const provider = (req.query.provider as string || "").trim().toLowerCase();
        const industry = (req.query.industry as string || "").trim().toLowerCase();
        const search = (req.query.search as string || "").trim();
        const sort = (req.query.sort as string || "date_desc").toLowerCase();

        const conditions: any[] = [];

        if (search) {
            conditions.push(like(schema.ottReleases.title, `%${search}%`));
        }

        if (industry && industry !== "all") {
            conditions.push(sql`LOWER(${schema.ottReleases.industry}) = ${industry}`);
        }

        if (provider && provider !== "all") {
            conditions.push(sql`EXISTS (
                SELECT 1 FROM jsonb_array_elements(${schema.ottReleases.providers}) AS elem
                WHERE LOWER(elem->>'name') LIKE ${`%${provider}%`}
            )`);
        }

        const whereClause = conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined;

        let orderByClause = desc(schema.ottReleases.releaseDate);
        if (sort === "rating_desc") {
            orderByClause = desc(schema.ottReleases.rating);
        } else if (sort === "popularity_desc") {
            orderByClause = desc(schema.ottReleases.popularity);
        }

        const countQuery = whereClause
            ? db.select({ count: count() }).from(schema.ottReleases).where(whereClause)
            : db.select({ count: count() }).from(schema.ottReleases);

        const itemsQuery = whereClause
            ? db.select().from(schema.ottReleases).where(whereClause).orderBy(orderByClause).limit(limit).offset(offset)
            : db.select().from(schema.ottReleases).orderBy(orderByClause).limit(limit).offset(offset);

        const [totalRes, items, jfMovies] = await Promise.all([countQuery, itemsQuery, getCachedJellyfinMovies()]);
        const total = Number(totalRes[0]?.count || 0);

        const enrichedReleases = items.map(item => {
            const inJellyfin = checkMovieInLibrary(item.title, item.year, item.originalTitle, jfMovies);
            return {
                ...item,
                jellyfinExists: inJellyfin || Boolean(item.jellyfinExists),
            };
        });

        return res.json({
            releases: enrichedReleases,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit) || 1,
            }
        });
    } catch (err: any) {
        console.error("[NEW RELEASES] Fetch error:", err);
        return res.status(500).json({ error: err.message, releases: [] });
    }
});

// Rate limiting map: userId -> array of successful refresh epoch timestamps
const userRefreshTimestamps = new Map<number | string, number[]>();
const REFRESH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_RATE_LIMIT_MAX = 2; // max 2 successful refreshes per 15 minutes

app.post("/api/new-releases/refresh", requireMod, async (req: any, res) => {
    try {
        const userId = req.user?.userId || req.user?.id || req.user?.email || "anonymous";
        const now = Date.now();

        // 1. Clean up timestamps older than 15 minutes for this user
        const userHistory = (userRefreshTimestamps.get(userId) || []).filter(t => now - t < REFRESH_RATE_LIMIT_WINDOW_MS);
        userRefreshTimestamps.set(userId, userHistory);

        // 2. Check rate limit
        if (userHistory.length >= REFRESH_RATE_LIMIT_MAX) {
            const oldestInWindow = userHistory[0];
            const waitMs = (oldestInWindow + REFRESH_RATE_LIMIT_WINDOW_MS) - now;
            const waitMinutes = Math.max(1, Math.ceil(waitMs / 60000));
            return res.status(429).json({
                error: `Rate limit reached: You can only refresh OTT releases 2 times per 15 minutes. Please try again in ${waitMinutes} minute${waitMinutes > 1 ? "s" : ""}.`,
                retryAfterMinutes: waitMinutes,
                retryAfterSeconds: Math.ceil(waitMs / 1000),
            });
        }

        let daysBack = Number(req.body.daysBack);
        if (isNaN(daysBack) || daysBack <= 0) {
            daysBack = 90; // Default 3 months
        }

        console.log(`[NEW RELEASES] Refresh triggered by user ${userId} (daysBack: ${daysBack}, attempt #${userHistory.length + 1} in 15m window)`);
        const syncStats = await syncIndianOTTReleasesToDB({ daysBack, pageLimit: 6 });

        // 3. ONLY record successful refresh
        userHistory.push(Date.now());
        userRefreshTimestamps.set(userId, userHistory);

        const remaining = Math.max(0, REFRESH_RATE_LIMIT_MAX - userHistory.length);

        return res.json({
            success: true,
            message: `Successfully refreshed OTT releases (${syncStats.totalFetched} scanned, ${syncStats.newlyAdded} new, ${syncStats.updated} updated). ${remaining} refresh${remaining === 1 ? '' : 'es'} remaining in this 15-min window.`,
            stats: syncStats,
            remainingRefreshes: remaining,
        });
    } catch (err: any) {
        console.error("[NEW RELEASES REFRESH] Error:", err);
        return res.status(500).json({ error: err.message });
    }
});

app.get("/api/new-releases/stats", requireMod, async (_req, res) => {
    try {
        const totalRes = await db.select({ count: count() }).from(schema.ottReleases);
        const total = Number(totalRes[0]?.count || 0);

        const platforms = ["Netflix", "Amazon Prime Video", "Disney+ Hotstar", "Zee5", "Sony LIV", "JioCinema", "YouTube"];
        const platformCounts: Record<string, number> = {};

        for (const p of platforms) {
            const pRes = await db.select({ count: count() }).from(schema.ottReleases).where(
                sql`EXISTS (
                    SELECT 1 FROM jsonb_array_elements(${schema.ottReleases.providers}) AS elem
                    WHERE LOWER(elem->>'name') LIKE ${`%${p.toLowerCase()}%`}
                )`
            );
            platformCounts[p] = Number(pRes[0]?.count || 0);
        }

        const latestItem = await db.select({ releaseDate: schema.ottReleases.releaseDate, updatedAt: schema.ottReleases.updatedAt })
            .from(schema.ottReleases)
            .orderBy(desc(schema.ottReleases.updatedAt))
            .limit(1);

        return res.json({
            total,
            platformCounts,
            lastRefreshed: latestItem[0]?.updatedAt || null,
            latestReleaseDate: latestItem[0]?.releaseDate || null,
        });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── SEARCH (Direct Studio & AI Workflow) ───

app.post("/api/search", requireMod, async (req: any, res) => {
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

        const formattedResults = (allPaged.length > 0 ? allPaged : results.map((r, i) => ({ globalIndex: i + 1, ...r, page: 1 }))).map((r, i) => ({
            index: r.globalIndex || i + 1,
            text: r.text,
            sizeMB: r.sizeMB,
            page: (r as any).page || 1,
            isBest: i === bestIdx,
            reason: i === bestIdx ? bestReason : ""
        }));

        console.log(`[SEARCH] Found ${results.length} results, best: #${bestIdx + 1} (${bestReason}), episodes: ${seriesEpisodes.length}`);
        return res.json({
            searchId, status: "results", title: cleanTitle, year: cleanYear,
            results: formattedResults, bestIdx, bestReason, seriesEpisodes, uniqueSeasons, mediaMetadata
        });

    } catch (err: any) {
        console.error(`[SEARCH] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── SELECT & DOWNLOAD ───

app.post("/api/select", requireMod, async (req: any, res) => {
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

app.post("/api/select-all-episodes", requireMod, async (req: any, res) => {
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

app.get("/api/downloads", requireMod, async (req: any, res) => {
    try {
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const search = (req.query.search as string) || "";

        // 1-hour completion filter: Hide completed items older than 1 hour, and hide soft-deleted items
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const baseCondition = sql`${schema.downloads.status} != 'deleted' AND (${schema.downloads.status} != 'completed' OR COALESCE(${schema.downloads.updatedAt}, ${schema.downloads.createdAt}) >= ${oneHourAgo}::timestamp)`;

        const whereClause = search
            ? sql`${baseCondition} AND ${schema.downloads.title} ILIKE ${'%' + search + '%'}`
            : baseCondition;

        const totalResult = await db.select({ count: count() }).from(schema.downloads).where(whereClause);

        const items = await db.select().from(schema.downloads).where(whereClause).orderBy(desc(schema.downloads.createdAt)).limit(limit).offset(offset);

        res.json({
            downloads: items,
            pagination: { page, limit, total: Number(totalResult[0]?.count || 0), pages: Math.ceil(Number(totalResult[0]?.count || 0) / limit) },
        });
    } catch (err: any) {
        console.error("[DOWNLOADS] Error fetching downloads:", err.message);
        res.status(500).json({ error: err.message, downloads: [] });
    }
});

// ─── DOWNLOAD ACTIONS ───

app.post("/api/downloads/:id/pause", requireMod, async (req: any, res) => {
    const { id } = req.params;
    downloadQueue.pauseJob(id);
    await db.update(schema.downloads).set({ status: "paused" }).where(eq(schema.downloads.requestId, id));
    res.json({ success: true, message: "Download paused" });
});

app.post("/api/downloads/:id/resume", requireMod, async (req: any, res) => {
    const { id } = req.params;
    downloadQueue.resumeJob(id);
    await db.update(schema.downloads).set({ status: "queued" }).where(eq(schema.downloads.requestId, id));
    res.json({ success: true, message: "Download resumed" });
});

app.post("/api/downloads/:id/retry", requireMod, async (req: any, res) => {
    const { id } = req.params;
    downloadQueue.retryJob(id);
    await db.update(schema.downloads).set({ status: "queued", error: null }).where(eq(schema.downloads.requestId, id));
    res.json({ success: true, message: "Download retry queued" });
});

app.delete("/api/downloads/:id", requireMod, async (req: any, res) => {
    const { id } = req.params;
    downloadQueue.cancelJob(id);
    await db.update(schema.downloads).set({ status: "deleted", updatedAt: new Date() }).where(eq(schema.downloads.requestId, id));
    res.json({ success: true, message: "Download cancelled and removed" });
});

app.delete("/api/downloads/clear/failed", requireMod, async (_req: any, res) => {
    downloadQueue.clearFailed();
    await db.update(schema.downloads).set({ status: "deleted", updatedAt: new Date() }).where(eq(schema.downloads.status, "failed"));
    res.json({ success: true, message: "Failed downloads cleared" });
});

app.delete("/api/downloads/clear/all", requireMod, async (_req: any, res) => {
    downloadQueue.clearFailed();
    await db.update(schema.downloads).set({ status: "deleted", updatedAt: new Date() }).where(sql`${schema.downloads.status} IN ('completed', 'failed', 'cancelled', 'paused')`);
    res.json({ success: true, message: "Download history cleared" });
});

// ─── REQUESTED MEDIA API ───

app.get("/api/requested-media", requireMod, async (_req, res) => {
    try {
        const items = await db.select().from(schema.requestedMedia).where(sql`${schema.requestedMedia.status} != 'deleted'`).orderBy(desc(schema.requestedMedia.createdAt)).limit(100);
        res.json({ items });
    } catch (err: any) {
        res.status(500).json({ error: err.message, items: [] });
    }
});

app.post("/api/requested-media", requireMod, async (req: any, res) => {
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

app.delete("/api/requested-media/clear", requireMod, async (_req: any, res) => {
    try {
        await db.update(schema.requestedMedia).set({ status: "deleted", updatedAt: new Date() }).where(sql`${schema.requestedMedia.status} != 'deleted'`);
        res.json({ success: true, message: "All requested media cleared" });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/api/requested-media/:id", requireMod, async (req: any, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
        await db.update(schema.requestedMedia).set({ status: "deleted", updatedAt: new Date() }).where(eq(schema.requestedMedia.id, id));
        res.json({ success: true, message: "Entry removed" });
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
    try {
        const items = await getAllMovies();
        res.json({ items: items || [] });
    } catch (err: any) {
        res.status(500).json({ error: err.message, items: [] });
    }
});

app.get("/api/jellyfin/series", requireAuth, async (_req, res) => {
    const items = await getAllSeries();
    res.json({ items });
});

app.get("/api/jellyfin/shows", requireAuth, async (_req, res) => {
    const items = await getAllSeries();
    res.json({ items });
});

app.get("/api/jellyfin/image/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const jellyfinUrl = process.env.JELLYFIN_URL || "";
        const jellyfinToken = process.env.JELLYFIN_TOKEN || "";
        if (!jellyfinUrl || !jellyfinToken) {
            return res.status(404).send("Jellyfin not configured");
        }
        const imgUrl = `${jellyfinUrl}/Items/${id}/Images/Primary?maxWidth=400&quality=85`;
        const response = await fetch(imgUrl, {
            headers: { "X-Emby-Token": jellyfinToken }
        });
        if (!response.ok) {
            return res.status(response.status).send("Image not found");
        }
        const contentType = response.headers.get("content-type") || "image/jpeg";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        const arrayBuffer = await response.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
    } catch (err: any) {
        res.status(500).send(err.message);
    }
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

app.get("/api/queue", requireMod, (_req, res) => {
    res.json({ stats: downloadQueue.getStats() });
});

// ─── TELEGRAM AUDIT LOGS ───

import { getRecentTelegramAuditLogs, getTelegramAuditLogFilePath } from "../../common/logger/telegram-audit.js";

app.get("/api/telegram-logs", requireMod, (req: any, res) => {
    const limit = Number(req.query.limit) || 50;
    const logs = getRecentTelegramAuditLogs(limit);
    res.json({
        logFile: getTelegramAuditLogFilePath(),
        count: logs.length,
        logs
    });
});

// ─── CHAT AGENT ───

app.post("/api/chat", requireMod, async (req: any, res) => {
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
    "/releases", "/new-releases", "/ott",
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

    const role = user.role || "user";
    const path = req.path.toLowerCase();

    // 1. Regular 'user' role is strictly restricted to Jellyfin
    if (role === "user") {
        if (!path.startsWith("/jellyfin")) {
            return res.redirect("/jellyfin");
        }
        return res.send(getDashboardPage(user, "jellyfin"));
    }

    // 2. 'mod' role is restricted from user management
    if (role === "mod") {
        if (path.startsWith("/user") || path.startsWith("/users") || path.startsWith("/admin")) {
            return res.redirect("/");
        }
    }

    // 3. Resolve initial view for mod and admin
    let initialView = "chat";
    if (path.startsWith("/releases") || path.startsWith("/new-releases") || path.startsWith("/ott")) initialView = "releases";
    else if (path.startsWith("/download") || path.startsWith("/downlaod")) initialView = "downloads";
    else if (path.startsWith("/request")) initialView = "requested";
    else if (path.startsWith("/jellyfin")) initialView = "jellyfin";
    else if (path.startsWith("/telegram") || path.startsWith("/bot")) initialView = "bot";
    else if (path.startsWith("/user") || path.startsWith("/admin")) {
        if (role === "admin") initialView = "admin";
        else initialView = "chat";
    }
    else if (path.startsWith("/studio") || path.startsWith("/search")) initialView = "studio";
    else initialView = "chat";

    res.send(getDashboardPage(user, initialView));
});

app.get("/login", (req, res) => {
    if (extractUser(req)) return res.redirect("/");
    res.send(getLoginPage());
});

app.get("/register", async (req, res) => {
    if (extractUser(req)) return res.redirect("/");
    const existingUsers = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
    if (existingUsers.length > 0) {
        return res.redirect("/login");
    }
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
                    <h1 style="font-size: 20px; font-weight: 700;">Create Initial Admin Account</h1>
                    <p style="font-size: 12.5px; color: var(--text-secondary); margin-top: 2px;">Set up the primary administrator for CineGrab</p>
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
                    Create Admin Account
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
    const isMod = user.role === "mod";
    const isUser = user.role === "user";
    const activeView = isUser ? "jellyfin" : (initialView || "chat");
    const userJson = JSON.stringify({
        id: user.userId || user.id,
        name: user.name || (user.email ? user.email.split("@")[0] : "User"),
        email: user.email || "user@example.com",
        role: user.role || "user"
    });

    const titles: Record<string, string> = {
        chat: "AI Downloader",
        releases: "New Releases",
        downloads: "Download Station",
        requested: "Requested Media",
        jellyfin: "Jellyfin Library",
        bot: "Telegram Bot",
        admin: "User Management",
        studio: "Search Studio"
    };

    const headerTitle = titles[activeView] || "Jellyfin Library";

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
                <a href="${isUser ? '/jellyfin' : '/'}" class="brand-logo" onclick="navigateRoute(event, '${isUser ? 'jellyfin' : 'chat'}')">
                    <div class="brand-icon-box">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/><path d="M4 8l4 0"/><path d="M4 16l4 0"/><path d="M4 12l16 0"/><path d="M16 8l4 0"/><path d="M16 16l4 0"/></svg>
                    </div>
                    <span class="brand-name">CineGrab</span>
                    <span class="brand-tag">${isAdmin ? 'Admin' : isMod ? 'Mod' : 'Viewer'}</span>
                </a>
                <button class="sidebar-toggle-btn" onclick="toggleSidebar()">
                    <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>
                </button>
            </div>

            <div class="sidebar-content">
                <div>
                    <div class="nav-group-title">Navigation</div>
                    <nav class="sidebar-nav">
                        ${isUser ? `
                        <a class="nav-link active" href="/jellyfin" data-view="jellyfin" onclick="navigateRoute(event, 'jellyfin')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                            <span>Jellyfin Library</span>
                        </a>
                        ` : `
                        <a class="nav-link ${activeView === 'chat' ? 'active' : ''}" href="/" data-view="chat" onclick="navigateRoute(event, 'chat')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/></svg>
                            <span>AI Copilot</span>
                        </a>
                        <a class="nav-link ${activeView === 'studio' ? 'active' : ''}" href="/studio" data-view="studio" onclick="navigateRoute(event, 'studio')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>
                            <span>Search & Download</span>
                        </a>
                        <a class="nav-link ${activeView === 'releases' ? 'active' : ''}" href="/releases" data-view="releases" onclick="navigateRoute(event, 'releases')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4v16"/><path d="M16 4v16"/><path d="M4 8h4"/><path d="M4 16h4"/><path d="M4 12h16"/><path d="M16 8h4"/><path d="M16 16h4"/></svg>
                            <span>New Releases</span>
                            <span class="nav-badge" style="background: rgba(229, 9, 20, 0.2); color: #ff5252; border: 1px solid rgba(229, 9, 20, 0.4);">OTT</span>
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
                        </a>` : ""}`}
                    </nav>
                </div>
            </div>

            <div class="sidebar-footer">
                <div class="user-card" id="userCardTrigger" onclick="toggleUserMenu()">
                    <div class="user-avatar">${(user.name || user.email || "U").charAt(0).toUpperCase()}</div>
                    <div class="user-info">
                        <div class="user-name">${user.name || (user.email ? user.email.split("@")[0] : "User")}</div>
                    </div>
                </div>

                <div class="user-popover hidden" id="userPopover">
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
                        ${!isUser ? `
                        <div class="bot-status-pill" onclick="navigateRoute(event, 'bot')">
                            <span class="status-dot connecting" id="headerBotDot"></span>
                            <span id="headerBotStatusText" class="header-bot-status-text" style="font-size:11.5px;">Checking bot...</span>
                        </div>` : ""}
                    </div>
                </div>
                <div class="header-right">
                    ${!isUser ? `
                    <button class="btn-header header-search-btn" onclick="navigateRoute(event, 'studio')">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>
                        Search
                    </button>
                    <button class="btn-header primary" onclick="startNewChat()">
                        <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M12 5l0 14"/><path d="M5 12l14 0"/></svg>
                        New Chat
                    </button>` : ""}
                </div>
            </header>

            ${!isUser ? `
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

            <!-- VIEW: NEW OTT RELEASES (BOLLYWOOD & SOUTH INDIAN) -->
            <section class="view-container ${activeView === 'releases' ? 'active' : ''}" id="view-releases">
                <div class="releases-container">
                    <!-- Compact Header & Refresh Panel -->
                    <div class="releases-compact-header">
                        <div class="releases-header-left">
                            <h1 style="font-size: 15px; font-weight: 700; color: #fff; margin: 0;">New OTT Releases</h1>
                            <span class="chip quality" style="background: rgba(229, 9, 20, 0.18); color: #ff5252; border-color: rgba(229, 9, 20, 0.35); font-size: 10px; padding: 1px 6px;">OTT Radar</span>
                            <span id="releasesLastUpdatedTag" style="font-size: 11px; color: var(--text-muted);">Loading...</span>
                        </div>
                        <div class="releases-header-right">
                            <button class="btn-primary-action" id="btnManualRefreshReleases" onclick="triggerManualReleasesRefresh(90)" style="padding: 5px 12px; font-size: 11.5px; display: inline-flex; align-items: center; gap: 5px;">
                                <svg class="tabler-icon" viewBox="0 0 24 24" style="width:13px;height:13px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                <span>Refresh</span>
                            </button>
                        </div>
                    </div>

                    <!-- Cards Grid -->
                    <div class="releases-grid" id="releasesGrid">
                        <div style="grid-column: 1 / -1; text-align: center; padding: 50px 20px; color: var(--text-muted);">
                            <div class="spinner" style="margin: 0 auto 12px;"></div>
                            <div>Loading new OTT releases...</div>
                        </div>
                    </div>

                    <!-- Pagination -->
                    <div class="pagination-bar" id="releasesPaginationBar" style="display:none;"></div>
                </div>
            </section>

            <!-- VIEW 2: SEARCH & DISCOVER STUDIO -->
            <section class="view-container ${activeView === 'studio' ? 'active' : ''}" id="view-studio">
                <div class="studio-wrap">
                    <div class="studio-header">
                        <h1>Search & Discover Studio</h1>
                        <p>Direct search Telegram ProSearch Bots with instant quality matrix recommendations for movies.</p>
                    </div>

                    <div class="studio-search-card">
                        <div class="search-input-group">
                            <input type="text" id="studioSearchInput" class="form-input" placeholder="Movie Title (e.g. Interstellar, Dune, Jawan, Animal)..." onkeydown="if(event.key==='Enter') performStudioSearch()">
                            <input type="text" id="studioYearInput" class="form-input" placeholder="Year (e.g. 2024)" onkeydown="if(event.key==='Enter') performStudioSearch()">
                            <button class="btn-primary-action" id="btnStudioSearch" onclick="performStudioSearch()">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>
                                Search Releases
                            </button>
                        </div>
                    </div>

                    <div class="studio-results-area" id="studioResultsArea">
                        <div style="text-align:center; padding: 40px; color: var(--text-muted);">
                            <div style="font-weight: 600; color: #fff; font-size: 14px;">Ready to Search Movies</div>
                            <div style="font-size: 12.5px; margin-top: 4px;">Enter a movie title above to discover release qualities, file sizes, and audio tracks.</div>
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
                    <div class="history-card">
                        <div class="history-toolbar">
                            <div>
                                <h2 style="font-size: 15px;">Requested Media List</h2>
                                <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">All tracked movie requests and status</p>
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
            ` : ""}

            <!-- VIEW 4: JELLYFIN MEDIA HUB -->
            <section class="view-container ${activeView === 'jellyfin' ? 'active' : ''}" id="view-jellyfin">
                <div class="jellyfin-wrap">
                    <!-- Compact 1-Line Header Bar on small/large screens -->
                    <div class="jf-compact-header">
                        <div class="jf-compact-title">
                            <span class="chip jellyfin">Media Server</span>
                            <h1 style="font-size: 16px; margin: 2px 0 0; color: #fff; font-weight: 700;">Jellyfin Library</h1>
                        </div>
                        <div class="jf-compact-stats">
                            <div class="jf-stat-pill">
                                <span class="jf-stat-val tabular-nums" id="jfMoviesCount">--</span>
                                <span class="jf-stat-lbl">Movies in Library</span>
                            </div>
                            <div class="jf-stat-pill sync">
                                <span class="status-dot online"></span>
                                <span class="jf-stat-lbl" style="color: var(--accent-emerald);">Synchronized</span>
                            </div>
                        </div>
                    </div>

                    <div class="studio-search-card" style="padding: 14px 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                            <h3 style="font-size: 13.5px; margin: 0;">Movie Duplicate Checker</h3>
                            <span style="font-size: 11px; color: var(--text-secondary);">Instant poster lookup & library search</span>
                        </div>
                        <div style="display: flex; gap: 8px; margin-top: 10px;">
                            <input type="text" id="jfCheckInput" class="form-input" placeholder="Type a movie name (e.g. Your Name, 3 Idiots, 2012, Dune)..." style="flex: 1; font-size: 12.5px;" oninput="handleJellyfinSearchInput(this.value)" onkeydown="if(event.key==='Enter') checkJellyfinItem()">
                            <button class="btn-primary-action" onclick="checkJellyfinItem()" style="padding: 6px 14px; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                                <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>
                                Check
                            </button>
                        </div>
                        <div id="jfCheckResultBox" style="display:none; margin-top: 10px; padding: 12px; background: var(--bg-surface-elevated); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 12px;"></div>
                    </div>

                    <!-- JELLYFIN MOVIE LIBRARY COLLECTION -->
                    <div class="history-card" style="margin-top: 4px;">
                        <div class="history-toolbar">
                            <div>
                                <h2 style="font-size: 15px;">Movies Collection</h2>
                                <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">Your indexed Jellyfin movie library</p>
                            </div>
                            <div>
                                <button class="btn-header" onclick="loadJellyfinLibrary(true)" title="Refresh Movie Library" style="display: inline-flex; align-items: center; gap: 4px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                    Refresh
                                </button>
                            </div>
                        </div>
                        <div id="jfMoviesGrid" class="jf-movies-grid">
                            <div style="text-align: center; color: var(--text-muted); padding: 40px; width: 100%; grid-column: 1 / -1;">
                                Loading movie library...
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            ${!isUser ? `
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
            ` : ""}

            <!-- VIEW 6: ADMIN USER MANAGEMENT -->
            ${isAdmin ? `
            <section class="view-container ${activeView === 'admin' ? 'active' : ''}" id="view-admin">
                <div class="admin-wrap">
                    <div class="studio-search-card">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                            <h2 style="font-size: 15px; margin: 0;">Create New User</h2>
                            <span class="chip best" style="font-size: 11px;">Admin Only</span>
                        </div>
                        <div class="admin-create-user-grid">
                            <input type="text" id="adminNewName" class="form-input" placeholder="Full Name">
                            <input type="email" id="adminNewEmail" class="form-input" placeholder="Email Address">
                            <input type="password" id="adminNewPass" class="form-input" placeholder="Password">
                            <select id="adminNewRole" class="form-input" style="background: var(--bg-input);">
                                <option value="user">User (Jellyfin Library Only)</option>
                                <option value="mod">Mod (Full Access except Users)</option>
                                <option value="admin">Admin (Full Access + Users)</option>
                            </select>
                            <button class="btn-primary-action" onclick="addAdminUser()">Add User</button>
                        </div>
                    </div>

                    <div class="history-card">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                            <h2 style="font-size: 15px; margin: 0;">Registered Users</h2>
                            <button class="btn-header" onclick="loadAdminUsers()" title="Refresh Users" style="display: inline-flex; align-items: center; gap: 4px;">
                                <svg class="tabler-icon" viewBox="0 0 24 24" style="width:13px;height:13px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                Refresh
                            </button>
                        </div>
                        <div class="data-table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Email</th>
                                        <th>Role</th>
                                        <th>Registered</th>
                                        <th style="text-align:right;">Actions</th>
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

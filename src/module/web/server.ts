import express from "express";
import cookieParser from "cookie-parser";
import { db, schema } from "../../common/db/index.js";
import { eq, or, and, desc, like, ilike, sql, count } from "drizzle-orm";
import { register, login, extractUser, extractUserAsync, tryRefreshToken, getAllUsers, updateUser, deleteUser, type UserRole } from "../../common/auth/auth.js";
import { checkMovieExists, checkSeriesExists, getLibraryStats, getAllMovies, getAllSeries, checkMediaExists, getSeriesEpisodes } from "../../common/jellyfin/client.js";
import { downloadQueue, secureBotFileToSavedMessages } from "../queue/queue.js";
import { getHarness } from "../../../command/harness.js";
import { broadcastNewDownload } from "./ws.js";
import { isBotConnected, isBotConnecting, ensureBotConnected, setBotConnected, setBotConnecting, getAuthState, submitPhone, submitCode, submitPassword, startWebAuth } from "../bot/bot.js";
import { getEpisodeDetails, pickBestResult, groupByEpisode, getSeriesInfo, isAllowedDownloadLanguage, checkResolutionHarnessRule } from "../ai/brain.js";
import {
    lookupMedia,
    cleanMediaTitle,
    getSeriesSeasonsAndEpisodes,
    getSeasonEpisodesList,
    searchMulti as tmdbSearchMulti,
    searchMovie as tmdbSearchMovie,
    searchTV as tmdbSearchTV,
    syncIndianOTTReleasesToDB,
    discoverIndianOTTReleases,
    discoverComprehensiveOTTMedia,
    fetchCuratedOTTMedia
} from "../../common/tmdb/client.js";
import { cleanSeriesTitleAndSeason } from "../download/downloader.js";
import { searchMedia, getDownloadLinks, getMediaFormatDetails, resolveSpecificFormatLink, selectBest720pQuality, sortServersByPriority, parseAvailableMediaFormats, cleanFileSize, testScraperSource } from "../download/api-client.js";
import { handleChat } from "./chat.js";
import { parseMediaWithAI, formatMediaJobTitle, formatMediaFileName } from "../ai/cleaner.js";
import { notifyFlickWebhook, autoSearchAndDownloadForRequest } from "../flick/webhook.js";

const app = express();
app.use(express.json({ limit: "50mb", type: ["application/json", "text/plain", "application/*+json"] }));
app.use(cookieParser());

// Disable static caching for immediate updates
app.use((req, res, next) => {
    if (req.url.startsWith('/css/') || req.url.startsWith('/js/')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

app.use(express.static("public", { maxAge: 0, etag: false }));

// In-memory search sessions: searchId -> { botUsername, sentId, btnMsgId, buttons, title, type, year }
const searchSessions = new Map<string, any>();
const downloadTraceLogs = new Map<string, any>();

// ─── AUTH MIDDLEWARE ───

async function requireAuth(req: any, res: any, next: any) {
    const user = await extractUserAsync(req, res);
    if (!user) {
        res.clearCookie("token", { path: "/" });
        return res.status(401).json({ error: "Session expired. Please log in again.", code: "AUTH_EXPIRED" });
    }
    req.user = user;
    next();
}

async function requireMod(req: any, res: any, next: any) {
    const user = await extractUserAsync(req, res);
    if (!user) {
        res.clearCookie("token", { path: "/" });
        return res.status(401).json({ error: "Session expired. Please log in again.", code: "AUTH_EXPIRED" });
    }
    if (user.role !== "admin" && user.role !== "mod") {
        return res.status(403).json({ error: "Moderator or Admin access required" });
    }
    req.user = user;
    next();
}

async function requireAdmin(req: any, res: any, next: any) {
    const user = await extractUserAsync(req, res);
    if (!user) {
        res.clearCookie("token", { path: "/" });
        return res.status(401).json({ error: "Session expired. Please log in again.", code: "AUTH_EXPIRED" });
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
    res.clearCookie("token", { path: "/" });
    res.json({ success: true });
});

app.post("/api/auth/refresh", async (req, res) => {
    try {
        let token = "";
        const authHeader = req.headers?.authorization;
        if (authHeader?.startsWith("Bearer ")) {
            token = authHeader.slice(7);
        } else if (req.headers?.cookie) {
            const match = req.headers.cookie.match(/token=([^;]+)/);
            if (match) token = match[1];
        }

        if (!token) {
            res.clearCookie("token", { path: "/" });
            return res.status(401).json({ error: "No token provided", code: "AUTH_EXPIRED" });
        }

        const refreshed = await tryRefreshToken(token);
        if (!refreshed) {
            res.clearCookie("token", { path: "/" });
            return res.status(401).json({ error: "Session expired or invalid. Please log in again.", code: "AUTH_EXPIRED" });
        }

        res.cookie("token", refreshed.token, {
            httpOnly: true,
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: "lax",
            path: "/"
        });

        res.json({ success: true, token: refreshed.token, user: refreshed.user });
    } catch (err: any) {
        res.clearCookie("token", { path: "/" });
        res.status(401).json({ error: err.message || "Failed to refresh session", code: "AUTH_EXPIRED" });
    }
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

// ─── ADMIN SCRAPER SOURCES MANAGEMENT ───

async function getOrSeedScraperSources() {
    try {
        const existing = await db.select().from(schema.scraperSources).orderBy(schema.scraperSources.priority);
        if (existing.length > 0) return existing;

        const defaultSources = [
            { name: "HDHub4u", type: "hdhub4u", baseUrl: "https://hdhub4u.bi", enabled: true, priority: 1 },
            { name: "Modlist (UHD & MoviesMod)", type: "modlist", baseUrl: "https://modlist.in", enabled: true, priority: 2 },
            { name: "Vegamovies", type: "vegamovies", baseUrl: "https://vegamoviess.foo", enabled: true, priority: 3 }
        ];

        for (const src of defaultSources) {
            await db.insert(schema.scraperSources).values(src);
        }

        return await db.select().from(schema.scraperSources).orderBy(schema.scraperSources.priority);
    } catch (e: any) {
        console.warn("[SCRAPER SOURCES] Seed check warning:", e.message);
        return [];
    }
}

app.get("/api/admin/sources", requireAdmin, async (_req, res) => {
    try {
        const sources = await getOrSeedScraperSources();
        res.json({ success: true, sources });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/admin/sources", requireAdmin, async (req, res) => {
    try {
        const { name, type, baseUrl, enabled, priority, headers, metadata } = req.body;
        if (!name || !baseUrl) return res.status(400).json({ error: "Source Name and Base URL are required" });
        const [created] = await db.insert(schema.scraperSources).values({
            name: name.trim(),
            type: (type || "custom").trim().toLowerCase(),
            baseUrl: baseUrl.trim(),
            enabled: enabled !== false,
            priority: Number(priority) || 1,
            headers: headers || null,
            metadata: metadata || null
        }).returning();
        res.json({ success: true, source: created });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

app.put("/api/admin/sources/:id", requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid source ID" });
        const { name, type, baseUrl, enabled, priority, headers, metadata } = req.body;
        const [updated] = await db.update(schema.scraperSources).set({
            ...(name ? { name: name.trim() } : {}),
            ...(type ? { type: type.trim().toLowerCase() } : {}),
            ...(baseUrl ? { baseUrl: baseUrl.trim() } : {}),
            ...(typeof enabled === "boolean" ? { enabled } : {}),
            ...(priority !== undefined ? { priority: Number(priority) } : {}),
            ...(headers !== undefined ? { headers } : {}),
            ...(metadata !== undefined ? { metadata } : {}),
            updatedAt: new Date()
        }).where(eq(schema.scraperSources.id, id)).returning();
        res.json({ success: true, source: updated });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/admin/sources/toggle/:id", requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid source ID" });
        const [src] = await db.select().from(schema.scraperSources).where(eq(schema.scraperSources.id, id)).limit(1);
        if (!src) return res.status(404).json({ error: "Source not found" });
        const [updated] = await db.update(schema.scraperSources).set({
            enabled: !src.enabled,
            updatedAt: new Date()
        }).where(eq(schema.scraperSources.id, id)).returning();
        res.json({ success: true, source: updated });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

app.delete("/api/admin/sources/:id", requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid source ID" });
        await db.delete(schema.scraperSources).where(eq(schema.scraperSources.id, id));
        res.json({ success: true });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/admin/sources/test", requireAdmin, async (req, res) => {
    try {
        const { url, type } = req.body;
        if (!url) return res.status(400).json({ error: "URL is required" });
        const testResult = await testScraperSource(url, type || "hdhub4u");
        res.json(testResult);
    } catch (err: any) {
        res.status(500).json({ success: false, status: "error", latency_ms: 0, message: err.message });
    }
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

let cachedJellyfinMedia: { movies: any[]; series: any[] } | null = null;
let lastJellyfinFetch = 0;

async function getCachedJellyfinMedia() {
    const now = Date.now();
    if (cachedJellyfinMedia && now - lastJellyfinFetch < 30000) {
        return cachedJellyfinMedia;
    }
    try {
        const [jfMovies, jfSeries] = await Promise.all([getAllMovies(), getAllSeries()]);
        cachedJellyfinMedia = {
            movies: (jfMovies || []).map(item => ({
                name: item.Name,
                title: item.Name.toLowerCase().trim(),
                cleanTitle: item.Name.toLowerCase().replace(/[^a-z0-9]/g, ""),
                year: (item.ProductionYear || item.Year) ? String(item.ProductionYear || item.Year) : undefined,
                tmdbId: item.ProviderIds?.Tmdb ? Number(item.ProviderIds.Tmdb) : undefined,
            })),
            series: (jfSeries || []).map(item => ({
                name: item.Name,
                title: item.Name.toLowerCase().trim(),
                cleanTitle: item.Name.toLowerCase().replace(/[^a-z0-9]/g, ""),
                year: (item.ProductionYear || item.Year) ? String(item.ProductionYear || item.Year) : undefined,
                tmdbId: item.ProviderIds?.Tmdb ? Number(item.ProviderIds.Tmdb) : undefined,
            }))
        };
        lastJellyfinFetch = now;
    } catch {
        cachedJellyfinMedia = cachedJellyfinMedia || { movies: [], series: [] };
    }
    return cachedJellyfinMedia;
}

function cleanForComparison(str: string): string {
    return str
        .toLowerCase()
        .replace(/^(the|a|an)\s+/i, "")
        .replace(/[^a-z0-9]/g, "")
        .trim();
}

function checkMovieInLibrary(
    title: string,
    year?: string | null,
    originalTitle?: string | null,
    jfList: { title: string; cleanTitle: string; year?: string; name: string; tmdbId?: number }[] = [],
    tmdbId?: number | null
): boolean {
    if (!title || jfList.length === 0) return false;

    const rawCleanT = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const rawCleanOrig = (originalTitle || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const cleanT = cleanForComparison(title);
    const cleanOrig = originalTitle ? cleanForComparison(originalTitle) : "";
    const targetYear = year ? String(year).trim() : "";

    for (const item of jfList) {
        // 1. Infallible TMDB ID match if both have it
        if (tmdbId && item.tmdbId && Number(tmdbId) === Number(item.tmdbId)) {
            return true;
        }

        const itemRawClean = item.cleanTitle;
        const itemClean = cleanForComparison(item.name);

        // 2. Exact title match (allowing for punctuation or leading articles)
        const isTitleExact =
            itemRawClean === rawCleanT ||
            (rawCleanOrig && itemRawClean === rawCleanOrig) ||
            itemClean === cleanT ||
            (cleanOrig && itemClean === cleanOrig);

        if (isTitleExact) {
            // If both candidate and item have a release year, verify they match (within 1 year margin)
            if (targetYear && item.year) {
                const y1 = parseInt(targetYear, 10);
                const y2 = parseInt(item.year, 10);
                if (!isNaN(y1) && !isNaN(y2)) {
                    if (Math.abs(y1 - y2) <= 1) {
                        return true;
                    }
                    continue;
                }
            }
            return true;
        }
    }

    return false;
}

let lastAutoSyncEpoch = 0;
let isSyncingChunk = false;

async function ensureFreshOTTReleasesChunk(force = false) {
    const now = Date.now();
    if (isSyncingChunk) return;
    if (!force && (now - lastAutoSyncEpoch < 15 * 60 * 1000)) return;

    isSyncingChunk = true;
    lastAutoSyncEpoch = now;
    try {
        console.log("[AUTO-SYNC] Fetching fresh chunk of Indian OTT releases from TMDB...");
        await syncIndianOTTReleasesToDB({ daysBack: 30, pageLimit: 1 });
    } catch (e: any) {
        console.warn(`[AUTO-SYNC] Background chunk sync error: ${e.message}`);
    } finally {
        isSyncingChunk = false;
    }
}

app.get("/api/new-releases", requireMod, async (req: any, res) => {
    try {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 24));
        const type = (req.query.type as string || "all").trim().toLowerCase();
        const provider = (req.query.provider as string || "").trim().toLowerCase();
        const industry = (req.query.industry as string || "").trim().toLowerCase();
        const search = (req.query.search as string || "").trim();
        const sort = (req.query.sort as string || "date_desc").toLowerCase();

        const [discovery, jfMedia] = await Promise.all([
            discoverComprehensiveOTTMedia({
                page,
                limit,
                type,
                provider,
                industry,
                search,
                sort,
            }),
            getCachedJellyfinMedia()
        ]);

        const enrichedReleases = discovery.results.map(item => {
            const isSeries = item.mediaType === "series";
            const jfList = isSeries ? jfMedia.series : jfMedia.movies;
            const inJellyfin = checkMovieInLibrary(item.title, item.year, item.originalTitle, jfList, item.tmdbId);
            return {
                ...item,
                jellyfinExists: inJellyfin,
            };
        });

        // Fire-and-forget background upsert into local database
        (async () => {
            for (const it of discovery.results) {
                try {
                    await db.insert(schema.ottReleases).values({
                        tmdbId: it.tmdbId,
                        mediaType: it.mediaType,
                        title: it.title,
                        originalTitle: it.originalTitle,
                        originalLanguage: it.originalLanguage || "hi",
                        industry: it.industry || "Cinema",
                        releaseDate: it.releaseDate,
                        ottReleaseDate: it.ottReleaseDate || it.releaseDate,
                        trailerKey: it.trailerKey || null,
                        year: it.year,
                        overview: it.overview,
                        posterUrl: it.posterUrl,
                        backdropUrl: it.backdropUrl,
                        rating: it.rating,
                        voteCount: it.voteCount,
                        popularity: it.popularity,
                        providers: it.providers,
                        jellyfinExists: it.jellyfinExists || false,
                    }).onConflictDoNothing();
                } catch {}
            }
        })().catch(() => {});

        return res.json({
            releases: enrichedReleases,
            pagination: {
                page: discovery.page,
                limit,
                total: discovery.totalResults,
                totalPages: discovery.totalPages,
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
        const [totalRes, moviesRes, seriesRes] = await Promise.all([
            db.select({ count: count() }).from(schema.ottReleases),
            db.select({ count: count() }).from(schema.ottReleases).where(eq(schema.ottReleases.mediaType, "movie")),
            db.select({ count: count() }).from(schema.ottReleases).where(eq(schema.ottReleases.mediaType, "series")),
        ]);
        const total = Number(totalRes[0]?.count || 0);
        const moviesCount = Number(moviesRes[0]?.count || 0);
        const seriesCount = Number(seriesRes[0]?.count || 0);

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
            moviesCount,
            seriesCount,
            platformCounts,
            lastRefreshed: latestItem[0]?.updatedAt || null,
            latestReleaseDate: latestItem[0]?.releaseDate || null,
        });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

app.get("/api/releases/trailer", requireMod, async (req: any, res) => {
    try {
        const tmdbId = Number(req.query.tmdbId);
        const mediaType = req.query.type === "series" ? "series" : "movie";
        const tmdbType = mediaType === "series" ? "tv" : "movie";

        if (!tmdbId) return res.status(400).json({ error: "Missing tmdbId" });

        // 1. Check DB first
        const existing = await db
            .select({ trailerKey: schema.ottReleases.trailerKey })
            .from(schema.ottReleases)
            .where(and(
                eq(schema.ottReleases.tmdbId, tmdbId),
                eq(schema.ottReleases.mediaType, mediaType)
            ))
            .limit(1);

        if (existing.length > 0 && existing[0]?.trailerKey) {
            return res.json({ trailerKey: existing[0].trailerKey });
        }

        // 2. Lookup TMDB
        const { getMediaTrailerKey } = await import("../../common/tmdb/client.js");
        const trailerKey = await getMediaTrailerKey(tmdbId, tmdbType);

        if (trailerKey) {
            await db
                .update(schema.ottReleases)
                .set({ trailerKey, updatedAt: new Date() })
                .where(and(
                    eq(schema.ottReleases.tmdbId, tmdbId),
                    eq(schema.ottReleases.mediaType, mediaType)
                ));
        }

        return res.json({ trailerKey: trailerKey || null });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── CURATED TRENDING & POPULAR OTT MEDIA APIS ───

app.get("/api/trending", requireMod, async (req: any, res) => {
    try {
        const window = (req.query.window as string || "3m").toLowerCase() as "3m" | "12m" | "10y";
        const type = (req.query.type as string || "all").toLowerCase() as "all" | "movie" | "series";
        const industry = (req.query.industry as string || "all").toLowerCase() as any;
        const page = Math.max(1, Number(req.query.page) || 1);
        const search = (req.query.search as string || "").trim();

        const result = await fetchCuratedOTTMedia({
            mode: "trending",
            window,
            type,
            industry,
            page,
            search,
            limit: 100,
        });

        const jfMedia = await getCachedJellyfinMedia();
        const enrichedItems = result.items.map(item => {
            const isSeries = item.mediaType === "series";
            const jfList = isSeries ? jfMedia.series : jfMedia.movies;
            const inJellyfin = checkMovieInLibrary(item.title, item.year, item.originalTitle, jfList, item.tmdbId);
            return {
                ...item,
                jellyfinExists: inJellyfin,
            };
        });

        return res.json({
            success: true,
            items: enrichedItems,
            pagination: {
                page: result.page,
                pageSize: result.pageSize,
                total: result.total,
                totalPages: result.totalPages,
            },
        });
    } catch (err: any) {
        console.error("[API TRENDING] Error:", err);
        return res.status(500).json({ success: false, error: err.message, items: [] });
    }
});

app.get("/api/popular", requireMod, async (req: any, res) => {
    try {
        const window = (req.query.window as string || "3m").toLowerCase() as "3m" | "12m" | "10y";
        const type = (req.query.type as string || "all").toLowerCase() as "all" | "movie" | "series";
        const industry = (req.query.industry as string || "all").toLowerCase() as any;
        const page = Math.max(1, Number(req.query.page) || 1);
        const search = (req.query.search as string || "").trim();

        const result = await fetchCuratedOTTMedia({
            mode: "popular",
            window,
            type,
            industry,
            page,
            search,
            limit: 100,
        });

        const jfMedia = await getCachedJellyfinMedia();
        const enrichedItems = result.items.map(item => {
            const isSeries = item.mediaType === "series";
            const jfList = isSeries ? jfMedia.series : jfMedia.movies;
            const inJellyfin = checkMovieInLibrary(item.title, item.year, item.originalTitle, jfList, item.tmdbId);
            return {
                ...item,
                jellyfinExists: inJellyfin,
            };
        });

        return res.json({
            success: true,
            items: enrichedItems,
            pagination: {
                page: result.page,
                pageSize: result.pageSize,
                total: result.total,
                totalPages: result.totalPages,
            },
        });
    } catch (err: any) {
        console.error("[API POPULAR] Error:", err);
        return res.status(500).json({ success: false, error: err.message, items: [] });
    }
});

// ─── SEARCH (Direct Studio & AI Workflow via dl.pallabdev.in) ───

app.post("/api/search", requireMod, async (req: any, res) => {
    let { title, type, year } = req.body;
    if (!title) return res.status(400).json({ error: "Title required" });

    const searchId = `srch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
        console.log(`[SEARCH] Searching dl.pallabdev.in for "${title}" (type: ${type || "all"})`);

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
            }
        } catch (e: any) {
            console.warn(`[SEARCH] TMDB resolution fallback: ${e.message}`);
        }

        const query = cleanTitle;
        // Generate alternate query variant by stripping punctuation/apostrophes
        const altQuery = cleanTitle.replace(/['’`:\-_.]+/g, " ").replace(/\s+/g, " ").trim();

        // Fetch enabled scraper sources from DB
        let activeSources: any[] = [];
        try {
            activeSources = await db.select().from(schema.scraperSources)
                .where(eq(schema.scraperSources.enabled, true))
                .orderBy(schema.scraperSources.priority);
            if (activeSources.length === 0) {
                activeSources = await getOrSeedScraperSources();
            }
        } catch (dbErr: any) {
            console.warn(`[SEARCH] DB scraper sources lookup warning: ${dbErr.message}`);
        }

        let results = await searchMedia(query, activeSources);
        if ((!results || results.length === 0) && altQuery && altQuery.toLowerCase() !== query.toLowerCase()) {
            console.log(`[SEARCH] Primary search returned 0 results. Retrying with cleaned variant: "${altQuery}"`);
            results = await searchMedia(altQuery, activeSources);
        }

        if (!results || results.length === 0) {
            return res.json({ searchId, status: "no_results", message: "No releases found", results: [], mediaMetadata });
        }

        searchSessions.set(searchId, {
            searchId,
            title: cleanTitle,
            year: cleanYear,
            type: type || "movie",
            results,
            createdAt: Date.now(),
        });

        for (const [k, v] of searchSessions) {
            if (Date.now() - v.createdAt > 30 * 60 * 1000) searchSessions.delete(k);
        }

        const formattedResults = results.map((r, i) => {
            let thumb = (r.thumbnail || "").trim();
            // 1. Strip WordPress photon proxy prefixes (e.g. https://i0.wp.com/) that get blocked by ad blockers
            thumb = thumb.replace(/^https?:\/\/i\d+\.wp\.com\//i, "https://");

            // 2. Dead image domains return broken images - clear thumbnail, do NOT fall back to searched media's poster
            const isDeadDomain = /imagetot\.com|extraimage\.net|extraimages\.net|jiopic\.com|keepimg\.com/i.test(thumb);
            if (isDeadDomain) {
                thumb = "";
            }

            const srcName = r.source || (r.sourceType === "vegamovies" ? "Vegamovies" : (r.sourceType === "modlist" ? "Modlist" : "HDHub4u"));

            return {
                index: i + 1,
                text: r.name,
                name: r.name,
                url: r.url,
                thumbnail: thumb,
                category: r.category || [],
                director: r.director || [],
                stars: r.stars || [],
                imdb_id: r.imdb_id || "",
                post_date: r.post_date || "",
                source: srcName,
                sourceType: r.sourceType || r.source_type || "hdhub4u",
                qualityTags: r.qualityTags || r.quality_tags || [],
                isBest: i === 0,
                reason: i === 0 ? `Top Match (${srcName})` : ""
            };
        });

        console.log(`[SEARCH] Found ${results.length} releases for "${cleanTitle}"`);
        return res.json({
            searchId,
            status: "results",
            title: cleanTitle,
            year: cleanYear,
            results: formattedResults,
            bestIdx: 0,
            mediaMetadata
        });

    } catch (err: any) {
        console.error(`[SEARCH] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── MEDIA FORMAT DETAILS (Fast 1-Second Resolution) ───

app.post("/api/media/details", requireMod, async (req: any, res) => {
    const { targetUrl, searchId, optionIndex } = req.body;
    let chosenUrl = targetUrl;

    if (!chosenUrl && searchId) {
        const session = searchSessions.get(searchId);
        if (session && session.results.length > 0) {
            const idx = typeof optionIndex === "number" && optionIndex >= 1 && optionIndex <= session.results.length
                ? optionIndex - 1
                : 0;
            const item = session.results[idx];
            if (item) chosenUrl = item.url;
        }
    }

    if (!chosenUrl) {
        return res.status(400).json({ error: "targetUrl or valid searchId required" });
    }

    try {
        console.log(`[MEDIA-DETAILS] Fetching download options for: ${chosenUrl}`);
        const parsed = await getMediaFormatDetails(chosenUrl);
        if (!parsed) {
            return res.status(404).json({ error: "No downloadable formats found for this release." });
        }

        // Check if batches or episodes exist in Jellyfin library for this release
        if (parsed.isSeries && parsed.name) {
            try {
                const clean = cleanMediaTitle(parsed.name);
                const seasonMatch = parsed.name.match(/season\s*(\d{1,2})|\bS(\d{1,2})\b/i);
                const targetSeason = clean.season || (seasonMatch ? parseInt(seasonMatch[1] || seasonMatch[2], 10) : 1);
                
                const sCheck = await checkSeriesExists(clean.title || parsed.name, targetSeason);
                if (sCheck.seriesExists && sCheck.item) {
                    if (sCheck.exists && parsed.seriesBatches) {
                        for (const b of parsed.seriesBatches) {
                            (b as any).inLibrary = true;
                        }
                    }
                    if (parsed.seriesEpisodes && parsed.seriesEpisodes.length > 0) {
                        const jfEps = await getSeriesEpisodes(sCheck.item.Id, targetSeason);
                        const realEpNums = new Set(
                            jfEps.filter(e => e.LocationType !== "Virtual").map(e => e.IndexNumber)
                        );
                        for (const ep of parsed.seriesEpisodes) {
                            if (realEpNums.has(ep.episodeNum)) {
                                (ep as any).inLibrary = true;
                                if (ep.qualities) {
                                    for (const q of ep.qualities) {
                                        (q as any).inLibrary = true;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (jfErr: any) {
                console.warn(`[MEDIA-DETAILS] Jellyfin pre-check warning:`, jfErr?.message);
            }
        }

        // Pre-validate movie formats (verify upstream CDN health) so modal opens with accurate broken badges
        if (!parsed.isSeries && parsed.movieFormats && parsed.movieFormats.length > 0) {
            try {
                await Promise.all(parsed.movieFormats.map(async (f) => {
                    if (!f.linkUrl) return;
                    try {
                        const resolved = await resolveSpecificFormatLink(chosenUrl, f.qualityKey, f.linkUrl);
                        if (!resolved.servers || resolved.servers.length === 0) {
                            (f as any).isBroken = true;
                            f.isRecommended = false;
                        } else {
                            (f as any).isBroken = false;
                        }
                    } catch (verErr: any) {
                        console.warn(`[MEDIA-DETAILS] Format ${f.resolution || f.label} broken:`, verErr.message);
                        (f as any).isBroken = true;
                        f.isRecommended = false;
                    }
                }));

                const hasWorkingRec = parsed.movieFormats.some(f => f.isRecommended && !(f as any).isBroken);
                if (!hasWorkingRec) {
                    const working = parsed.movieFormats.filter(f => !(f as any).isBroken);
                    if (working.length > 0) {
                        const pref1080 = working.find(f => /1080p/i.test(f.resolution || f.label || ""));
                        if (pref1080) {
                            pref1080.isRecommended = true;
                        } else {
                            working[0].isRecommended = true;
                        }
                    }
                }
            } catch (valErr: any) {
                console.warn(`[MEDIA-DETAILS] Pre-validation failed:`, valErr.message);
            }
        }

        return res.json({ success: true, details: parsed });
    } catch (err: any) {
        console.error(`[MEDIA-DETAILS] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

app.post("/api/media/validate-formats", requireMod, async (req: any, res) => {
    const { targetUrl, formats } = req.body;
    if (!targetUrl || !Array.isArray(formats) || formats.length === 0) {
        return res.json({ success: true, statuses: {} });
    }

    const statuses: Record<string, { isBroken: boolean; aliveCount: number; error?: string }> = {};

    await Promise.all(formats.map(async (f: any) => {
        const key = f.qualityKey || f.linkUrl;
        if (!key) return;
        try {
            const resolved = await resolveSpecificFormatLink(targetUrl, f.qualityKey, f.linkUrl);
            statuses[key] = {
                isBroken: !resolved.servers || resolved.servers.length === 0,
                aliveCount: resolved.servers ? resolved.servers.length : 0
            };
        } catch (err: any) {
            statuses[key] = {
                isBroken: true,
                aliveCount: 0,
                error: err.message
            };
        }
    }));

    let suggestedWorkingKey: string | null = null;
    const working = formats.filter((f: any) => {
        const key = f.qualityKey || f.linkUrl;
        return statuses[key] && !statuses[key].isBroken;
    });

    if (working.length > 0) {
        const pref1080 = working.find((f: any) => /1080p/i.test(f.label || f.resolution || ""));
        if (pref1080) {
            suggestedWorkingKey = pref1080.qualityKey || pref1080.linkUrl;
        } else {
            suggestedWorkingKey = working[0].qualityKey || working[0].linkUrl;
        }
    }

    return res.json({ success: true, statuses, suggestedWorkingKey });
});

// ─── SPECIFIC FORMAT / EPISODE DOWNLOAD ───

app.post("/api/download-specific", requireMod, async (req: any, res) => {
    const { targetUrl, qualityKey, customTitle, isBatch, episodeNum, fileSize, linkUrl, type, mediaType: reqMediaType, flickRequestId } = req.body;

    if (!targetUrl && !linkUrl) {
        return res.status(400).json({ error: "targetUrl or linkUrl is required" });
    }

    try {
        console.log(`[DOWNLOAD-SPECIFIC] Fast targeted resolving: qualityKey="${qualityKey || 'default'}" for url="${targetUrl || linkUrl}"`);
        let resolvedDetails: { name: string; servers: any[]; fileSize?: string };

        let failedResolution = "720p";
        if (/4k|2160p/i.test(qualityKey || "")) failedResolution = "4K";
        else if (/1080p/i.test(qualityKey || "")) failedResolution = "1080p";
        else if (/720p/i.test(qualityKey || "")) failedResolution = "720p";
        else if (/480p/i.test(qualityKey || "")) failedResolution = "480p";

        let suggestedResolution = failedResolution === "720p" ? "1080p" : "720p";
        try {
            if (targetUrl) {
                const formats = await getMediaFormatDetails(targetUrl);
                if (formats?.movieFormats && formats.movieFormats.length > 0) {
                    const alt = formats.movieFormats.find(f => f.resolution && f.resolution !== failedResolution && f.resolution !== "480p");
                    if (alt) {
                        suggestedResolution = alt.resolution;
                    } else {
                        const anyAlt = formats.movieFormats.find(f => f.resolution && f.resolution !== failedResolution);
                        if (anyAlt) suggestedResolution = anyAlt.resolution;
                    }
                }
            }
        } catch { /* ignore fallback error */ }

        try {
            resolvedDetails = await resolveSpecificFormatLink(targetUrl || "", qualityKey, linkUrl);
        } catch (resolveErr: any) {
            console.warn(`[DOWNLOAD-SPECIFIC] Target resolution failed: ${resolveErr.message}`);
            return res.status(200).json({
                success: false,
                isBroken: true,
                failedResolution,
                suggestedResolution,
                qualityKey,
                error: `The ${failedResolution} download link is broken from the provider end. Please try downloading with the ${suggestedResolution} link.`
            });
        }

        const servers = resolvedDetails.servers;
        if (!servers || servers.length === 0) {
            return res.status(200).json({
                success: false,
                isBroken: true,
                failedResolution,
                suggestedResolution,
                qualityKey,
                error: `The ${failedResolution} download link is broken from the provider end. Please try downloading with the ${suggestedResolution} link.`
            });
        }

        let actualFileSize = (fileSize && fileSize !== "Direct Download") ? cleanFileSize(fileSize) : "";
        if (!actualFileSize && resolvedDetails.fileSize) {
            actualFileSize = cleanFileSize(resolvedDetails.fileSize);
        }
        if (!actualFileSize) {
            for (const s of servers) {
                const sSize = cleanFileSize(s.file_size || "") || cleanFileSize(s.server_name || "");
                if (sSize) {
                    actualFileSize = sSize;
                    break;
                }
            }
        }
        if (!actualFileSize) {
            actualFileSize = "Direct Download";
        }

        // Propagate discovered file size to servers
        for (const s of servers) {
            if (!s.file_size && actualFileSize !== "Direct Download") {
                s.file_size = actualFileSize;
            }
        }

        // AI Metadata Extraction: Send raw name/title to extract clean title, release year, season, episode
        const rawNameToParse = customTitle || resolvedDetails.name || "Media";
        const aiMeta = await parseMediaWithAI(rawNameToParse);

        // Fallback season / episode extraction if AI missed it
        if (!aiMeta.season) {
            const sMatch = rawNameToParse.match(/season\s*(\d{1,2})|\bS(\d{1,2})\b/i);
            if (sMatch) {
                aiMeta.season = parseInt(sMatch[1] || sMatch[2], 10);
            }
        }
        if (episodeNum !== undefined) {
            aiMeta.episode = episodeNum;
        } else if (aiMeta.episode === null || aiMeta.episode === undefined) {
            const eMatch = rawNameToParse.match(/(?:ep|episode)\s*(\d{1,3})|\bE(\d{1,3})\b/i);
            if (eMatch) {
                aiMeta.episode = parseInt(eMatch[1] || eMatch[2], 10);
            }
        }

        const incomingType = type || reqMediaType;
        const isExplicitSeries = Boolean(
            incomingType === "series" || 
            incomingType === "tv" || 
            incomingType === "show" || 
            (incomingType !== "movie" && (isBatch || episodeNum !== undefined || (qualityKey && (qualityKey.startsWith("batch_") || qualityKey.startsWith("episode_")))))
        );

        if (incomingType === "movie" && episodeNum === undefined) {
            aiMeta.type = "movie";
            aiMeta.isBatch = false;
            // Ensure movie has canonical TMDB title and year
            try {
                const tmdb = await lookupMedia(aiMeta.title, aiMeta.year);
                if (tmdb && tmdb.found && tmdb.title) {
                    aiMeta.title = tmdb.title;
                    if (tmdb.year) aiMeta.year = tmdb.year;
                }
            } catch {}
        } else if (isExplicitSeries) {
            aiMeta.type = "series";
            if (episodeNum !== undefined) {
                aiMeta.episode = episodeNum;
                aiMeta.isBatch = false;
            } else {
                aiMeta.isBatch = true;
            }
        } else {
            // Ensure movie has canonical TMDB title and year
            try {
                const tmdb = await lookupMedia(aiMeta.title, aiMeta.year);
                if (tmdb && tmdb.found && tmdb.title) {
                    aiMeta.title = tmdb.title;
                    if (tmdb.year) aiMeta.year = tmdb.year;
                }
            } catch {}
            if (aiMeta.type !== "series") {
                aiMeta.type = "movie";
                aiMeta.isBatch = false;
            }
        }

        const mediaType = aiMeta.type;
        const movieYear = aiMeta.year;
        const jobTitle = formatMediaJobTitle(aiMeta);
        const jobFileName = formatMediaFileName(aiMeta);

        // Enforce Jellyfin library duplicate check before downloading
        try {
            const targetSeason = mediaType === "series" ? (aiMeta.season || undefined) : undefined;
            const targetEpisode = mediaType === "series" ? (aiMeta.episode ?? undefined) : undefined;
            const jfCheck = await checkMediaExists(
                aiMeta.title,
                mediaType,
                movieYear,
                targetSeason,
                targetEpisode
            );
            if (jfCheck.exists) {
                let duplicateDesc = aiMeta.title;
                if (mediaType === "series") {
                    if (targetSeason !== undefined && targetEpisode !== undefined) {
                        duplicateDesc = `${aiMeta.title} - S${String(targetSeason).padStart(2, "0")}E${String(targetEpisode).padStart(2, "0")}`;
                    } else if (targetSeason !== undefined) {
                        duplicateDesc = `${aiMeta.title} (Season ${targetSeason})`;
                    }
                }
                console.log(`[DOWNLOAD-SPECIFIC] "${duplicateDesc}" is already in Jellyfin library (${jfCheck.type}). Blocking duplicate download.`);
                return res.status(409).json({
                    success: false,
                    alreadyInJellyfin: true,
                    error: `"${duplicateDesc}" already exists in your Jellyfin ${jfCheck.type || "media"} library! Re-download is prevented.`
                });
            }
        } catch (jfErr: any) {
            console.warn(`[DOWNLOAD-SPECIFIC] Jellyfin check warning: ${jfErr?.message}`);
        }

        // Deduplication check in downloads queue
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
                console.log(`[DOWNLOAD-SPECIFIC DEDUP] "${jobTitle}" is already ${existing[0].status}.`);
                return res.json({
                    success: true,
                    requestId: existing[0].requestId,
                    message: `"${jobTitle}" is already active in your download station.`,
                    fileSize: actualFileSize,
                    alreadyActive: true
                });
            }
        } catch (dbErr: any) {
            console.warn(`[DOWNLOAD-SPECIFIC DEDUP] Warning: ${dbErr?.message}`);
        }

        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        let effectiveFlickId = flickRequestId;
        if (!effectiveFlickId && aiMeta.title) {
            try {
                const [matchedReq] = await db.select().from(schema.requestedMedia)
                    .where(
                        and(
                            eq(schema.requestedMedia.title, aiMeta.title),
                            or(
                                eq(schema.requestedMedia.status, "pending"),
                                eq(schema.requestedMedia.status, "approved")
                            )
                        )
                    ).limit(1);
                if (matchedReq && matchedReq.flickRequestId) {
                    effectiveFlickId = matchedReq.flickRequestId;
                }
            } catch {}
        }

        await db.insert(schema.downloads).values({
            requestId,
            title: jobTitle,
            year: movieYear || null,
            type: mediaType,
            status: "queued",
            season: mediaType === "series" ? (aiMeta.season || 1) : null,
            episode: mediaType === "series" ? (aiMeta.episode ?? null) : null,
            fileSize: actualFileSize,
            requestedBy: req.user.userId,
            flickRequestId: effectiveFlickId || null,
        });

        downloadQueue.addJob({
            requestId,
            type: mediaType,
            title: jobTitle,
            cleanTitle: aiMeta.title,
            year: movieYear,
            season: mediaType === "series" ? (aiMeta.season || 1) : undefined,
            episode: mediaType === "series" ? (aiMeta.episode ?? undefined) : undefined,
            servers,
            fileSize: actualFileSize,
            isBatchPack: Boolean(aiMeta.isBatch),
            fileName: jobFileName,
            linkUrl,
            flickRequestId: effectiveFlickId || undefined,
        });

        // If this download fulfills a Flick request, update status and send webhook
        if (effectiveFlickId) {
            db.update(schema.requestedMedia).set({
                status: "downloading",
                note: `Downloading ${jobTitle} (${actualFileSize})`,
                updatedAt: new Date(),
            }).where(eq(schema.requestedMedia.flickRequestId, effectiveFlickId)).catch(() => {});

            notifyFlickWebhook({
                id: effectiveFlickId,
                status: "downloading",
                note: `Queued and downloading "${jobTitle}" (${actualFileSize}).`
            }).catch(() => {});
        }

        downloadTraceLogs.set(requestId, {
            requestId,
            title: jobTitle,
            targetUrl,
            linkUrl,
            qualityKey,
            servers,
            primaryServer: servers[0] || null,
            totalServers: servers.length,
            fileSize: actualFileSize,
            fileName: jobFileName,
            resolvedAt: new Date().toISOString()
        });

        broadcastNewDownload({
            jobId: requestId,
            title: jobTitle,
            type: mediaType,
            requestedBy: req.user.email,
        });

        return res.json({
            success: true,
            requestId,
            message: `Download started for "${jobTitle}" (${actualFileSize}).`,
            fileSize: actualFileSize,
            qualityKey,
            trace: downloadTraceLogs.get(requestId)
        });

    } catch (err: any) {
        console.error(`[DOWNLOAD-SPECIFIC] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── DOWNLOAD LINK & STAGE INSPECTOR ───

app.get("/api/download/inspect/:requestId", requireMod, async (req: any, res) => {
    const { requestId } = req.params;
    const trace = downloadTraceLogs.get(requestId);
    const [row] = await db.select().from(schema.downloads).where(eq(schema.downloads.requestId, requestId)).limit(1);
    if (!row && !trace) {
        return res.status(404).json({ success: false, error: "Download record not found" });
    }
    return res.json({
        success: true,
        requestId,
        download: row || null,
        trace: trace || null
    });
});

// ─── SELECT & DOWNLOAD ───

app.post("/api/select", requireMod, async (req: any, res) => {
    const { searchId, optionIndex, targetUrl, buttonText, type } = req.body;
    let chosenUrl = targetUrl;
    let chosenTitle = "Media";
    let chosenYear = "";

    const session = searchId ? searchSessions.get(searchId) : null;
    if (session && session.results.length > 0) {
        const idx = typeof optionIndex === "number" && optionIndex >= 1 && optionIndex <= session.results.length
            ? optionIndex - 1
            : 0;
        const item = session.results[idx];
        if (item) {
            chosenUrl = chosenUrl || item.url;
            chosenTitle = item.name;
            chosenYear = session.year || "";
        }
    }

    if (!chosenUrl && buttonText && session) {
        const match = session.results.find((r: any) => r.name === buttonText || r.name.toLowerCase().includes(buttonText.toLowerCase()));
        if (match) {
            chosenUrl = match.url;
            chosenTitle = match.name;
        }
    }

    if (!chosenUrl) {
        return res.status(400).json({ error: "targetUrl or valid searchId required" });
    }

    try {
        console.log(`[SELECT] Resolving download links for: ${chosenUrl}`);
        const details = await getDownloadLinks(chosenUrl);
        const quality = selectBest720pQuality(details);

        if (!quality) {
            return res.status(404).json({ error: "No downloadable servers found for this item." });
        }

        const incomingType = type || (session ? session.type : undefined);
        const isSeries = (incomingType === "series" || incomingType === "tv" || incomingType === "show") 
            ? true 
            : (incomingType === "movie" ? false : (quality.isBatchPack || quality.isEpisodeList));
        let mediaType: "movie" | "series" = isSeries ? "series" : "movie";

        if (!chosenYear && mediaType === "movie") {
            const yMatch = (details.name || chosenTitle).match(/(?:\(|\b)(19\d{2}|20\d{2})(?:\)|\b)/);
            if (yMatch) chosenYear = yMatch[1];
        }

        // Check if this media is already downloading or queued
        try {
            const existing = await db.select()
                .from(schema.downloads)
                .where(
                    and(
                        eq(schema.downloads.title, details.name),
                        or(
                            eq(schema.downloads.status, "queued"),
                            eq(schema.downloads.status, "downloading")
                        )
                    )
                )
                .limit(1);

            if (existing && existing.length > 0) {
                console.log(`[SELECT DEDUP] "${details.name}" is already ${existing[0].status}. Skipping duplicate.`);
                return res.json({
                    success: true,
                    requestId: existing[0].requestId,
                    message: `"${details.name}" is already active in your download queue.`,
                    fileSize: existing[0].fileSize || quality.fileSize,
                    alreadyActive: true
                });
            }
        } catch (dbErr: any) {
            console.warn(`[SELECT DEDUP] Warning checking existing download: ${dbErr?.message}`);
        }

        if (quality.isEpisodeList && quality.episodes && quality.episodes.length > 0) {
            const rawNameToParse = [details.name, chosenYear].filter(Boolean).join(" ");
            const aiMeta = await parseMediaWithAI(rawNameToParse);
            const cleanSeriesTitle = aiMeta.title;
            const cleanSeason = aiMeta.season || 1;
            const queuedEps: string[] = [];
            for (const ep of quality.episodes) {
                const epReqId = `req_${Date.now()}_ep${ep.episodeNum}_${Math.random().toString(36).slice(2, 6)}`;
                const epTitle = `${cleanSeriesTitle} - S${String(cleanSeason).padStart(2, "0")}E${String(ep.episodeNum).padStart(2, "0")}`;
                const epFileName = `${cleanSeriesTitle} - S${String(cleanSeason).padStart(2, "0")}E${String(ep.episodeNum).padStart(2, "0")}.mkv`;

                await db.insert(schema.downloads).values({
                    requestId: epReqId,
                    title: epTitle,
                    type: "series",
                    status: "queued",
                    season: cleanSeason,
                    episode: ep.episodeNum,
                    fileSize: ep.servers[0]?.file_size || "720p",
                    requestedBy: req.user.userId,
                });

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

                broadcastNewDownload({
                    jobId: epReqId,
                    title: epTitle,
                    type: "series",
                    requestedBy: req.user.email,
                });

                queuedEps.push(`Episode ${ep.episodeNum}`);
            }

            return res.json({
                success: true,
                message: `Queued ${queuedEps.length} episodes for "${cleanSeriesTitle}" in 720p.`,
                queuedEpisodes: queuedEps,
            });
        }

        const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const fileSize = quality.fileSize || "720p";

        // AI Metadata Extraction: clean title, real release year, type, season
        const rawNameToParse = [details.name, chosenYear].filter(Boolean).join(" ");
        const aiMeta = await parseMediaWithAI(rawNameToParse);
        if (isSeries) {
            aiMeta.type = "series";
            aiMeta.isBatch = true;
        } else {
            aiMeta.type = "movie";
            aiMeta.isBatch = false;
            try {
                const tmdb = await lookupMedia(aiMeta.title, aiMeta.year || chosenYear);
                if (tmdb && tmdb.found && tmdb.title) {
                    aiMeta.title = tmdb.title;
                    if (tmdb.year) aiMeta.year = tmdb.year;
                }
            } catch {}
        }
        mediaType = aiMeta.type;
        chosenYear = aiMeta.year || chosenYear;
        const jobTitle = formatMediaJobTitle(aiMeta);
        const jobFileName = formatMediaFileName(aiMeta);

        await db.insert(schema.downloads).values({
            requestId,
            title: jobTitle,
            year: chosenYear || null,
            type: mediaType,
            status: "queued",
            season: mediaType === "series" ? (aiMeta.season || 1) : null,
            episode: mediaType === "series" ? (aiMeta.episode ?? null) : null,
            fileSize,
            requestedBy: req.user.userId,
        });

        downloadQueue.addJob({
            requestId,
            type: mediaType,
            title: jobTitle,
            cleanTitle: aiMeta.title,
            year: chosenYear || undefined,
            servers: quality.servers,
            fileSize,
            isBatchPack: mediaType === "series" && (quality.isBatchPack || Boolean(aiMeta.isBatch)),
            season: mediaType === "series" ? (aiMeta.season || 1) : undefined,
            fileName: jobFileName,
        });

        broadcastNewDownload({
            jobId: requestId,
            title: jobTitle,
            type: mediaType,
            requestedBy: req.user.email,
        });

        return res.json({
            success: true,
            requestId,
            message: `Download queued for "${details.name}" (${fileSize}) in 720p.`,
            fileSize,
            qualityKey: quality.qualityKey,
        });

    } catch (err: any) {
        console.error(`[SELECT] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// Direct Download Endpoint
app.post("/api/download", requireMod, async (req: any, res) => {
    return app._router.handle(Object.assign(req, { url: "/api/select" }), res);
});

// ─── SERIES BULK DOWNLOAD ───

app.post("/api/select-all-episodes", requireMod, async (req: any, res) => {
    const { searchId, targetUrl } = req.body;
    let chosenUrl = targetUrl;
    const session = searchId ? searchSessions.get(searchId) : null;
    if (session && session.results.length > 0) {
        chosenUrl = chosenUrl || session.results[0].url;
    }

    if (!chosenUrl) return res.status(400).json({ error: "targetUrl or valid searchId required" });

    try {
        const details = await getDownloadLinks(chosenUrl);
        const quality = selectBest720pQuality(details);

        if (!quality) {
            return res.status(404).json({ error: "No download links found." });
        }

        const aiMeta = await parseMediaWithAI(details.name);

        if (quality.isBatchPack) {
            const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const fileSize = quality.fileSize || "Full Season Pack 720p";
            const batchMeta = { ...aiMeta, type: "series" as const, isBatch: true };
            const jobTitle = formatMediaJobTitle(batchMeta);
            const jobFileName = formatMediaFileName(batchMeta);

            await db.insert(schema.downloads).values({
                requestId,
                title: jobTitle,
                type: "series",
                status: "queued",
                season: batchMeta.season || 1,
                year: batchMeta.year || null,
                fileSize,
                requestedBy: req.user.userId,
            });

            downloadQueue.addJob({
                requestId,
                type: "series",
                title: jobTitle,
                year: batchMeta.year || undefined,
                servers: quality.servers,
                fileSize,
                isBatchPack: true,
                season: batchMeta.season || 1,
                fileName: jobFileName,
            });

            broadcastNewDownload({
                jobId: requestId,
                title: jobTitle,
                type: "series",
                requestedBy: req.user.email,
            });

            return res.json({
                success: true,
                message: `Batch Season Pack queued for "${jobTitle}" (${fileSize}).`,
                isBatchPack: true,
            });
        }

        if (quality.isEpisodeList && quality.episodes) {
            const cleanSeriesTitle = aiMeta.title;
            const cleanSeason = aiMeta.season || 1;
            const queued: any[] = [];
            for (const ep of quality.episodes) {
                const epReqId = `req_${Date.now()}_ep${ep.episodeNum}_${Math.random().toString(36).slice(2, 6)}`;
                const epTitle = `${cleanSeriesTitle} - S${String(cleanSeason).padStart(2, "0")}E${String(ep.episodeNum).padStart(2, "0")}`;
                const epFileName = `${cleanSeriesTitle} - S${String(cleanSeason).padStart(2, "0")}E${String(ep.episodeNum).padStart(2, "0")}.mkv`;

                await db.insert(schema.downloads).values({
                    requestId: epReqId,
                    title: epTitle,
                    type: "series",
                    status: "queued",
                    season: cleanSeason,
                    episode: ep.episodeNum,
                    year: aiMeta.year || null,
                    fileSize: ep.servers[0]?.file_size || "720p",
                    requestedBy: req.user.userId,
                });

                downloadQueue.addJob({
                    requestId: epReqId,
                    type: "series",
                    title: epTitle,
                    season: cleanSeason,
                    episode: ep.episodeNum,
                    year: aiMeta.year || undefined,
                    servers: ep.servers,
                    fileSize: ep.servers[0]?.file_size || "720p",
                    fileName: epFileName,
                });

                queued.push({ episode: ep.episodeNum, title: epTitle, status: "queued" });
            }

            return res.json({
                success: true,
                title: cleanSeriesTitle,
                total: queued.length,
                queued: queued.length,
                episodes: queued,
            });
        }

        return res.json({ success: true, message: `Processed download for "${details.name}"` });

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
    try {
        const { id } = req.params;
        downloadQueue.pauseJob(id);
        await db.update(schema.downloads).set({ status: "paused", updatedAt: new Date() }).where(
            or(eq(schema.downloads.requestId, id), ...(isNaN(Number(id)) ? [] : [eq(schema.downloads.id, Number(id))]))
        );
        res.json({ success: true, message: "Download paused" });
    } catch (err: any) {
        console.error("[PAUSE] Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/downloads/:id/resume", requireMod, async (req: any, res) => {
    try {
        const { id } = req.params;
        const resumed = downloadQueue.resumeJob(id);
        if (!resumed) {
            const rows = await db.select().from(schema.downloads).where(
                or(eq(schema.downloads.requestId, id), ...(isNaN(Number(id)) ? [] : [eq(schema.downloads.id, Number(id))]))
            );
            if (rows && rows[0]) {
                const row = rows[0];
                downloadQueue.addJob({
                    requestId: row.requestId,
                    bot: (row as any).botUsername || "ProSearchM11Bot",
                    btnMsgId: 0,
                    type: (row.type as any) || "movie",
                    title: row.title,
                    year: row.year || undefined,
                    fileSize: row.fileSize || undefined,
                    fileName: row.title + ".mp4",
                });
            }
        }
        await db.update(schema.downloads).set({ status: "queued", updatedAt: new Date() }).where(
            or(eq(schema.downloads.requestId, id), ...(isNaN(Number(id)) ? [] : [eq(schema.downloads.id, Number(id))]))
        );
        res.json({ success: true, message: "Download resumed" });
    } catch (err: any) {
        console.error("[RESUME] Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/downloads/:id/retry", requireMod, async (req: any, res) => {
    try {
        const { id } = req.params;
        const retried = downloadQueue.retryJob(id);
        if (!retried) {
            const rows = await db.select().from(schema.downloads).where(
                or(eq(schema.downloads.requestId, id), ...(isNaN(Number(id)) ? [] : [eq(schema.downloads.id, Number(id))]))
            );
            if (rows && rows[0]) {
                const row = rows[0];
                downloadQueue.addJob({
                    requestId: row.requestId,
                    bot: (row as any).botUsername || "ProSearchM11Bot",
                    btnMsgId: 0,
                    type: (row.type as any) || "movie",
                    title: row.title,
                    year: row.year || undefined,
                    fileSize: row.fileSize || undefined,
                    fileName: row.title + ".mp4",
                });
            }
        }
        await db.update(schema.downloads).set({ status: "queued", error: null, updatedAt: new Date() }).where(
            or(eq(schema.downloads.requestId, id), ...(isNaN(Number(id)) ? [] : [eq(schema.downloads.id, Number(id))]))
        );
        res.json({ success: true, message: "Download retry queued" });
    } catch (err: any) {
        console.error("[RETRY] Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete("/api/downloads/:id", requireMod, async (req: any, res) => {
    try {
        const { id } = req.params;
        downloadQueue.cancelJob(id);
        await db.update(schema.downloads).set({ status: "deleted", updatedAt: new Date() }).where(
            or(eq(schema.downloads.requestId, id), ...(isNaN(Number(id)) ? [] : [eq(schema.downloads.id, Number(id))]))
        );
        res.json({ success: true, message: "Download cancelled and removed" });
    } catch (err: any) {
        console.error("[CANCEL] Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete("/api/downloads/clear/failed", requireMod, async (_req: any, res) => {
    try {
        downloadQueue.clearFailed();
        await db.update(schema.downloads).set({ status: "deleted", updatedAt: new Date() }).where(eq(schema.downloads.status, "failed"));
        res.json({ success: true, message: "Failed downloads cleared" });
    } catch (err: any) {
        console.error("[CLEAR_FAILED] Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete("/api/downloads/clear/all", requireMod, async (_req: any, res) => {
    try {
        downloadQueue.clearFailed();
        await db.update(schema.downloads).set({ status: "deleted", updatedAt: new Date() }).where(sql`${schema.downloads.status} IN ('completed', 'failed', 'cancelled', 'paused')`);
        res.json({ success: true, message: "Download history cleared" });
    } catch (err: any) {
        console.error("[CLEAR_ALL] Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── REQUESTED MEDIA & FLICK INTEGRATION API ───

// Public endpoint for Flick to submit media requests (User-Agent: Flick-Paywall/1.0)
app.post("/api/request", async (req: any, res) => {
    try {
        const { id, title, posterUrl, type, year, tmdbId, overview, requestedBy, requestedAt } = req.body;

        if (!id || !title || !type) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields: id, title, type"
            });
        }

        const mediaType = (type === "series" || type === "tv" || type === "show") ? "series" : "movie";
        const cleanReqTitle = title.trim();
        console.log(`[DLM] Incoming Flick request: "${cleanReqTitle}" (${mediaType}, ${year || "N/A"}) [Flick ID: ${id}]`);

        // 1. Check if media already exists in Jellyfin library
        const jfCheck = await checkMediaExists(cleanReqTitle, mediaType, year ? String(year) : undefined);
        if (jfCheck.exists) {
            console.log(`[DLM] "${cleanReqTitle}" is ALREADY in Jellyfin (${jfCheck.type || "library"}). Notifying Flick immediately.`);

            const existingReq = await db.select().from(schema.requestedMedia)
                .where(eq(schema.requestedMedia.flickRequestId, id))
                .limit(1);

            let recordId: number;
            if (existingReq.length > 0) {
                recordId = existingReq[0].id;
                await db.update(schema.requestedMedia).set({
                    status: "inlibrary",
                    note: "Already available on Jellyfin!",
                    updatedAt: new Date(),
                }).where(eq(schema.requestedMedia.id, recordId));
            } else {
                const [created] = await db.insert(schema.requestedMedia).values({
                    title: cleanReqTitle,
                    type: mediaType,
                    year: year ? String(year) : null,
                    status: "inlibrary",
                    flickRequestId: id,
                    tmdbId: tmdbId ? Number(tmdbId) : null,
                    posterUrl: posterUrl || null,
                    overview: overview || null,
                    userEmail: requestedBy?.email || null,
                    userName: requestedBy?.name || null,
                    userId: requestedBy?.userId || null,
                    requestedBy: requestedBy?.name || requestedBy?.email || "Flick Member",
                    note: "Already available on Jellyfin!",
                    metadata: { requestedBy, requestedAt, overview, posterUrl, tmdbId, jfCheck },
                }).returning();
                recordId = created.id;
            }

            // Fire-and-forget celebratory webhook to Flick
            notifyFlickWebhook({
                id,
                status: "inlibrary",
                note: "This title is already available in your Jellyfin library! Enjoy streaming in 4K HDR."
            }).catch(() => {});

            return res.status(200).json({
                success: true,
                message: `Media "${cleanReqTitle}" is already in Jellyfin library and ready to stream`,
                data: {
                    requestId: `dlm_${recordId}`,
                    flickId: id,
                    title: cleanReqTitle,
                    status: "inlibrary"
                }
            });
        }

        // 2. Title not in Jellyfin: Record in DB as "pending" for admin/mod review
        const existingReq = await db.select().from(schema.requestedMedia)
            .where(eq(schema.requestedMedia.flickRequestId, id))
            .limit(1);

        let recordId: number;
        if (existingReq.length > 0) {
            recordId = existingReq[0].id;
            await db.update(schema.requestedMedia).set({
                status: "pending",
                note: "Pending Admin/Mod review",
                updatedAt: new Date(),
            }).where(eq(schema.requestedMedia.id, recordId));
        } else {
            const [created] = await db.insert(schema.requestedMedia).values({
                title: cleanReqTitle,
                type: mediaType,
                year: year ? String(year) : null,
                status: "pending",
                flickRequestId: id,
                tmdbId: tmdbId ? Number(tmdbId) : null,
                posterUrl: posterUrl || null,
                overview: overview || null,
                userEmail: requestedBy?.email || null,
                userName: requestedBy?.name || null,
                userId: requestedBy?.userId || null,
                requestedBy: requestedBy?.name || requestedBy?.email || "Flick Member",
                note: "Pending Admin/Mod review",
                metadata: { requestedBy, requestedAt, overview, posterUrl, tmdbId },
            }).returning();
            recordId = created.id;
        }

        // 3. Respond 200 OK to Flick (status: "pending")
        return res.status(200).json({
            success: true,
            message: `Media request for "${cleanReqTitle}" received and awaiting review`,
            data: {
                requestId: `dlm_${recordId}`,
                flickId: id,
                title: cleanReqTitle,
                status: "pending"
            }
        });

    } catch (err: any) {
        console.error("[DLM] /api/request error:", err);
        res.status(500).json({ success: false, error: "Internal server error" });
    }
});

app.get("/api/requested-media", requireMod, async (_req, res) => {
    try {
        const items = await db.select().from(schema.requestedMedia)
            .where(sql`${schema.requestedMedia.status} != 'deleted'`)
            .orderBy(desc(schema.requestedMedia.createdAt))
            .limit(200);
        res.json({ items });
    } catch (err: any) {
        res.status(500).json({ error: err.message, items: [] });
    }
});

app.post("/api/requested-media", requireMod, async (req: any, res) => {
    try {
        const { title, type, year } = req.body;
        if (!title) return res.status(400).json({ error: "Title required" });
        const [created] = await db.insert(schema.requestedMedia).values({
            title: title.trim(),
            type: type === "series" ? "series" : "movie",
            year: year || null,
            status: "requested",
            requestedBy: req.user.email || req.user.name,
            userEmail: req.user.email,
            userName: req.user.name,
        }).returning();

        res.json({ success: true, message: `Added "${title}" to requested list`, item: created });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: Auto-download requested media
app.post("/api/requested-media/:id/auto-download", requireMod, async (req: any, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid request ID" });
        const result = await autoSearchAndDownloadForRequest(id);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Admin: Reject requested media with optional note (notifies Flick)
app.post("/api/requested-media/:id/reject", requireMod, async (req: any, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid request ID" });
        const { note } = req.body;
        const [row] = await db.select().from(schema.requestedMedia).where(eq(schema.requestedMedia.id, id)).limit(1);
        if (!row) return res.status(404).json({ error: "Request not found" });

        const rejectionNote = (note || "").trim() || "Request could not be fulfilled at this time.";
        await db.update(schema.requestedMedia).set({
            status: "rejected",
            note: rejectionNote,
            updatedAt: new Date(),
        }).where(eq(schema.requestedMedia.id, id));

        if (row.flickRequestId) {
            await notifyFlickWebhook({
                id: row.flickRequestId,
                status: "rejected",
                note: rejectionNote,
            });
        }

        res.json({ success: true, message: `Request "${row.title}" rejected and user notified.` });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Admin: Approve requested media with optional note (notifies Flick)
app.post("/api/requested-media/:id/approve", requireMod, async (req: any, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid request ID" });
        const { note } = req.body;
        const [row] = await db.select().from(schema.requestedMedia).where(eq(schema.requestedMedia.id, id)).limit(1);
        if (!row) return res.status(404).json({ error: "Request not found" });

        const approvalNote = (note || "").trim() || "Request approved. Searching release indexers...";
        await db.update(schema.requestedMedia).set({
            status: "approved",
            note: approvalNote,
            updatedAt: new Date(),
        }).where(eq(schema.requestedMedia.id, id));

        if (row.flickRequestId) {
            await notifyFlickWebhook({
                id: row.flickRequestId,
                status: "approved",
                note: approvalNote,
            });
        }

        res.json({ success: true, message: `Request "${row.title}" approved and Flick notified.` });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Admin: Manual status update & webhook dispatch (approved, downloading, inlibrary, rejected)
app.post("/api/requested-media/:id/status", requireMod, async (req: any, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || isNaN(id)) return res.status(400).json({ error: "Invalid request ID" });
        const { status, note } = req.body;
        if (!status) return res.status(400).json({ error: "Status is required" });

        const [row] = await db.select().from(schema.requestedMedia).where(eq(schema.requestedMedia.id, id)).limit(1);
        if (!row) return res.status(404).json({ error: "Request not found" });

        await db.update(schema.requestedMedia).set({
            status,
            note: note !== undefined ? note : row.note,
            updatedAt: new Date(),
        }).where(eq(schema.requestedMedia.id, id));

        if (row.flickRequestId) {
            await notifyFlickWebhook({
                id: row.flickRequestId,
                status,
                note: note || undefined,
            });
        }

        res.json({ success: true, message: `Updated status to "${status}" and notified Flick.` });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Admin: Test webhook connection with Flick
app.post("/api/requested-media/test-webhook", requireMod, async (req: any, res) => {
    try {
        const { id, status, note } = req.body;
        const result = await notifyFlickWebhook({
            id: id || "test_req_id",
            status: status || "approved",
            note: note || "Test webhook notification from DLM admin",
        });
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
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
    try {
        const items = await getAllSeries();
        res.json({ items: items || [] });
    } catch (err: any) {
        res.status(500).json({ error: err.message, items: [] });
    }
});

app.get("/api/jellyfin/shows", requireAuth, async (_req, res) => {
    try {
        const items = await getAllSeries();
        res.json({ items: items || [] });
    } catch (err: any) {
        res.status(500).json({ error: err.message, items: [] });
    }
});

app.get("/api/jellyfin/all", requireAuth, async (_req, res) => {
    try {
        const [movies, series] = await Promise.all([getAllMovies(), getAllSeries()]);
        res.json({
            movies: movies || [],
            series: series || [],
            total: (movies?.length || 0) + (series?.length || 0)
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, movies: [], series: [], total: 0 });
    }
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

app.get("/api/queue", requireMod, async (_req, res) => {
    try {
        const stats = downloadQueue.getStats();
        const activeInDb = await db.select({ count: count() }).from(schema.downloads).where(
            sql`${schema.downloads.status} IN ('pending', 'analyzing', 'searching', 'clicking', 'downloading')`
        );
        const activeDbCount = Number(activeInDb[0]?.count || 0);
        const hasActiveDownloads = (stats.active > 0) || (stats.waiting > 0) || (activeDbCount > 0);

        res.json({
            stats,
            activeDbCount,
            hasActiveDownloads
        });
    } catch (err: any) {
        res.json({ stats: downloadQueue.getStats(), hasActiveDownloads: false });
    }
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

// ─── MEDIA MANAGER & OPTIMIZER PROXY ROUTES ───

const MEDIA_MANAGER_URL = process.env.MEDIA_MANAGER_URL || "http://localhost:5687";

async function proxyMediaManager(res: express.Response, path: string, options: RequestInit = {}) {
    try {
        const response = await fetch(`${MEDIA_MANAGER_URL}${path}`, {
            headers: { "Content-Type": "application/json" },
            ...options,
        });
        const data: any = await response.json().catch(() => ({}));
        if (response.ok && data && typeof data === 'object') {
            data.success = (data.status !== 'error');
        }
        res.status(response.status).json(data);
    } catch (err: any) {
        res.status(502).json({ success: false, error: `Media Manager offline or unreachable: ${err.message}` });
    }
}

app.get("/api/media/health", requireMod, (_req, res) => proxyMediaManager(res, "/api/health"));
app.get("/api/media/analyze", requireMod, (_req, res) => proxyMediaManager(res, "/api/media/analyze"));
app.post("/api/media/move", requireMod, async (req, res) => {
    try {
        const response = await fetch(`${MEDIA_MANAGER_URL}/api/media/move`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body),
        });
        const data: any = await response.json().catch(() => ({}));
        if (response.ok && data && typeof data === 'object') {
            data.success = (data.status !== 'error');
            // Proactively trigger Jellyfin library refresh
            import("../../common/jellyfin/client.js").then(({ refreshJellyfinLibrary }) => {
                refreshJellyfinLibrary().catch(() => {});
            });
        }
        res.status(response.status).json(data);
    } catch (err: any) {
        res.status(502).json({ success: false, error: `Media Manager offline or unreachable: ${err.message}` });
    }
});
app.get("/api/media/status", requireMod, (_req, res) => proxyMediaManager(res, "/api/media/status"));
app.get("/api/media/history", requireMod, (_req, res) => proxyMediaManager(res, "/api/media/history"));

app.post("/api/jellyfin/refresh", requireAuth, async (_req, res) => {
    try {
        const { refreshJellyfinLibrary } = await import("../../common/jellyfin/client.js");
        const success = await refreshJellyfinLibrary();
        res.json({ success, message: success ? "Jellyfin media scan started" : "Failed to trigger scan" });
    } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
    }
});


app.get("/api/optimize/list", requireMod, (_req, res) => proxyMediaManager(res, "/api/optimize/list"));
app.post("/api/optimize/queue", requireMod, (req, res) => {
    const bodyStr = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    return proxyMediaManager(res, "/api/optimize/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr
    });
});
app.get("/api/optimize/status", requireMod, (_req, res) => proxyMediaManager(res, "/api/optimize/status"));
app.post("/api/optimize/scan", requireMod, (req, res) => proxyMediaManager(res, "/api/optimize/scan", { method: "POST", body: JSON.stringify(req.body) }));
app.post("/api/optimize/cancel/:id", requireMod, (req, res) => proxyMediaManager(res, `/api/optimize/cancel/${encodeURIComponent(req.params.id)}`, { method: "POST" }));
app.post("/api/optimize/clear-history", requireMod, (req, res) => proxyMediaManager(res, "/api/optimize/clear-history", { method: "POST" }));
app.post("/api/optimize/clear-all", requireMod, (req, res) => proxyMediaManager(res, "/api/optimize/clear-all", { method: "POST" }));

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
    "/", "/ai", "/chat",
    "/releases", "/new-releases", "/ott",
    "/download/select", "/download-picker",
    "/trending",
    "/popular",
    "/download", "/downloads", "/downlaod",
    "/request", "/requests", "/requested",
    "/jellyfin",
    "/media", "/medias",
    "/optimizer", "/optimise",
    "/user", "/users",
    "/admin"
];

app.get(["/telegram", "/bot"], (req, res) => res.redirect("/"));

app.get(pageRoutes, async (req, res) => {
    const user = await extractUserAsync(req, res);
    if (!user) {
        res.clearCookie("token", { path: "/" });
        return res.redirect("/login");
    }

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

    // 3. Resolve initial view for mod and admin (Default: unified Media Catalog)
    let initialView = "releases";
    if (path.startsWith("/download/select") || path.startsWith("/download-picker")) initialView = "download-picker";
    else if (path.startsWith("/releases") || path.startsWith("/new-releases") || path.startsWith("/ott")) initialView = "releases";
    else if (path.startsWith("/trending")) initialView = "trending";
    else if (path.startsWith("/popular")) initialView = "popular";
    else if (path.startsWith("/download") || path.startsWith("/downlaod")) initialView = "downloads";
    else if (path.startsWith("/request")) initialView = "requested";
    else if (path.startsWith("/jellyfin")) initialView = "jellyfin";
    else if (path.startsWith("/media")) initialView = "media";
    else if (path.startsWith("/optimizer") || path.startsWith("/optimise")) initialView = "optimizer";
    else if (path.startsWith("/user") || path.startsWith("/admin")) {
        if (role === "admin") initialView = "admin";
        else initialView = "releases";
    }
    else if (path === "/ai" || path === "/chat") initialView = "chat";
    else initialView = "releases";

    res.send(getDashboardPage(user, initialView));
});

app.get("/login", async (req, res) => {
    if (await extractUserAsync(req, res)) return res.redirect("/");
    res.send(getLoginPage());
});

app.get("/register", async (req, res) => {
    if (await extractUserAsync(req, res)) return res.redirect("/");
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
        releases: "Media Catalog",
        "download-picker": "Download Media",
        downloads: "Download Station",
        requested: "Requested Media",
        media: "Library Mover",
        optimizer: "Library Optimizer",
        jellyfin: "Jellyfin Library",
        admin: "Admin Settings",
        chat: "AI Copilot"
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
    <link rel="stylesheet" href="/css/style.css?v=${Date.now()}">
    <style>
        .msg-bubble img {
            width: 76px !important;
            height: 112px !important;
            max-width: 76px !important;
            max-height: 112px !important;
            object-fit: cover !important;
            border-radius: 6px !important;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45) !important;
            margin: 4px 14px 8px 0 !important;
            flex-shrink: 0 !important;
            display: block !important;
            float: left !important;
        }
        .msg-bubble::after {
            content: "" !important;
            display: table !important;
            clear: both !important;
        }
        .chat-release-thumb {
            width: 44px !important;
            height: 62px !important;
            max-width: 44px !important;
            max-height: 62px !important;
            object-fit: cover !important;
            border-radius: 5px !important;
            float: none !important;
            margin: 0 !important;
        }
        .window-pill {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: var(--text-secondary);
            padding: 4px 11px;
            border-radius: 20px;
            font-size: 11.5px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        .window-pill:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }
        .window-pill.active {
            background: rgba(236, 72, 153, 0.2);
            border-color: rgba(236, 72, 153, 0.5);
            color: #f472b6;
        }
        .window-pill.active.gold {
            background: rgba(245, 158, 11, 0.2);
            border-color: rgba(245, 158, 11, 0.5);
            color: #fbbf24;
        }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</head>
<body>
    <div class="app-container">
        <!-- Sidebar Navigation -->
        <aside class="app-sidebar" id="appSidebar">
            <div class="sidebar-header">
                <a href="${isUser ? '/jellyfin' : '/'}" class="brand-logo" onclick="navigateRoute(event, '${isUser ? 'jellyfin' : 'releases'}')">
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
                        <a class="nav-link ${activeView === 'releases' ? 'active' : ''}" href="/" data-view="releases" onclick="navigateRoute(event, 'releases')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4v16"/><path d="M16 4v16"/><path d="M4 8h4"/><path d="M4 16h4"/><path d="M4 12h16"/><path d="M16 8h4"/><path d="M16 16h4"/></svg>
                            <span>Media</span>
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
                        <a class="nav-link ${activeView === 'media' ? 'active' : ''}" href="/media" data-view="media" onclick="navigateRoute(event, 'media')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4z"/><path d="M3 6m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z"/></svg>
                            <span>Library Mover</span>
                            <span class="nav-badge" id="pendingMediaBadge" style="display:none; background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4);">0</span>
                        </a>
                        <a class="nav-link ${activeView === 'optimizer' ? 'active' : ''}" href="/optimizer" data-view="optimizer" onclick="navigateRoute(event, 'optimizer')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"/></svg>
                            <span>Optimizer</span>
                            <span class="nav-badge" id="optimizerPendingBadge" style="display:none; background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4);">0</span>
                        </a>
                        <a class="nav-link ${activeView === 'jellyfin' ? 'active' : ''}" href="/jellyfin" data-view="jellyfin" onclick="navigateRoute(event, 'jellyfin')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                            <span>Jellyfin Library</span>
                        </a>
                        ${isAdmin ? `
                        <a class="nav-link ${activeView === 'admin' ? 'active' : ''}" href="/user" data-view="admin" onclick="navigateRoute(event, 'admin')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/></svg>
                            <span>Admin Settings</span>
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
                    </div>
                </div>
                <div class="header-right" id="headerRightActions">
                    ${!isUser ? `
                    <button class="btn-header primary" id="btnHeaderAction" onclick="${activeView === 'releases' ? 'toggleMediaCatalogSearch()' : (activeView === 'requested' ? 'loadRequestedMedia()' : 'startNewChat()')}">
                        ${activeView === 'releases' ? `
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>
                            <span id="btnHeaderActionText">Search</span>
                        ` : (activeView === 'requested' ? `
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -5v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 5v-5h-5"/></svg>
                            <span id="btnHeaderActionText">Refresh</span>
                        ` : `
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M12 5l0 14"/><path d="M5 12l14 0"/></svg>
                            <span id="btnHeaderActionText">New Chat</span>
                        `)}
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
                    <!-- Top Media Search Bar (Radarr / Jellyseerr style) -->
                    <div class="media-search-header hidden" id="mediaSearchHeader">
                        <div class="media-search-input-wrap">
                            <svg class="tabler-icon media-search-icon" viewBox="0 0 24 24"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>
                            <input 
                                type="text" 
                                id="mediaCatalogSearchInput" 
                                class="media-catalog-search-input" 
                                placeholder="Search movies & TV shows released on OTT / streaming services..." 
                                autocomplete="off"
                                oninput="handleMediaCatalogSearch(this.value)"
                                onkeydown="if (event.key === 'Escape') toggleMediaCatalogSearch(false); if (event.key === 'Enter') handleMediaCatalogSearch(this.value, true)"
                            />
                            <button class="btn-clear-media-search hidden" id="btnClearMediaSearch" onclick="clearMediaCatalogSearch()" title="Clear Search">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>
                            </button>
                        </div>
                    </div>

                    <!-- Industry Pills (Centered) -->
                    <div class="releases-filters-bar" style="justify-content: center;">
                        <div class="releases-industry-pills" style="justify-content: center;">
                            <button class="rel-industry-pill active" data-industry="all" onclick="setReleasesIndustryFilter('all')">All</button>
                            <button class="rel-industry-pill" data-industry="bollywood" onclick="setReleasesIndustryFilter('bollywood')">Bollywood</button>
                            <button class="rel-industry-pill" data-industry="tollywood" onclick="setReleasesIndustryFilter('tollywood')">Tollywood</button>
                            <button class="rel-industry-pill" data-industry="south" onclick="setReleasesIndustryFilter('south')">South Cinema</button>
                            <button class="rel-industry-pill" data-industry="hollywood" onclick="setReleasesIndustryFilter('hollywood')">Hollywood</button>
                            <button class="rel-industry-pill" data-industry="k-drama" onclick="setReleasesIndustryFilter('k-drama')">K-Drama</button>
                        </div>
                    </div>

                    <!-- Cards Grid -->
                    <div class="releases-grid" id="releasesGrid">
                        <div style="grid-column: 1 / -1; text-align: center; padding: 50px 20px; color: var(--text-muted);">
                            <div class="spinner" style="margin: 0 auto 12px;"></div>
                            <div>Loading OTT releases...</div>
                        </div>
                    </div>

                    <!-- Infinite Scroll Sentinel & Status -->
                    <div id="releasesInfiniteScrollSentinel" class="releases-infinite-sentinel">
                        <div id="releasesInfiniteLoader" class="releases-infinite-loader hidden">
                            <div class="spinner" style="width:24px; height:24px; border-width:2px; margin:0 auto 8px;"></div>
                            <span style="font-size: 13px; color: var(--text-muted);">Loading more releases...</span>
                        </div>
                        <div id="releasesInfiniteEnd" class="releases-infinite-end hidden">
                            <span class="releases-infinite-end-badge">✓ You've reached the end of the catalog</span>
                        </div>
                    </div>
                </div>
            </section>

            <!-- VIEW: DEDICATED DOWNLOAD PICKER (RADARR / JELLYSEERR SCRAPER INTERFACE) -->
            <section class="view-container ${activeView === 'download-picker' ? 'active' : ''}" id="view-download-picker">
                <div class="download-picker-container">
                    <!-- Top navigation bar -->
                    <div class="picker-top-nav">
                        <button class="btn-picker-back" onclick="closeDownloadPicker()">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M5 12l14 0"/><path d="M5 12l6 6"/><path d="M5 12l6 -6"/></svg>
                            <span>Back to Media Catalog</span>
                        </button>
                        <div class="picker-breadcrumbs" id="pickerBreadcrumbs">
                            <span class="crumb-root">Media</span>
                            <span class="crumb-sep">/</span>
                            <span class="crumb-title" id="pickerCrumbTitle">Download Media</span>
                        </div>
                    </div>

                    <!-- Target Media Hero Banner -->
                    <div class="picker-hero" id="pickerHeroCard">
                        <div class="picker-hero-poster-wrap">
                            <img id="pickerPosterImg" src="https://via.placeholder.com/300x450/111827/ffffff?text=Loading..." alt="Poster" class="picker-hero-poster">
                        </div>
                        <div class="picker-hero-info">
                            <div class="picker-hero-title-row">
                                <h1 class="picker-hero-title" id="pickerHeroTitle">Loading title...</h1>
                                <span class="picker-hero-year" id="pickerHeroYear"></span>
                                <span class="card-type-tag" id="pickerHeroTypeBadge">Movie</span>
                            </div>
                            <p class="picker-hero-overview" id="pickerHeroOverview"></p>
                            <div class="picker-hero-actions">
                                <button class="btn-picker-trailer" id="btnPickerTrailer" onclick="playPickerTrailer()" style="display:none;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z"/></svg>
                                    <span>Watch Trailer</span>
                                </button>
                                <button class="btn-header" style="color: var(--accent-cyan); display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 6px 12px;" onclick="openScraperLiveMonitor(downloadPickerState.title)" title="Open Real-time Scraper Pipeline Tracer">
                                    <span>⚡ Scraper Tracer</span>
                                </button>
                                <span class="picker-hero-status-note" id="pickerHeroStatusNote">Searching scraper service for HD/OTT releases...</span>
                            </div>
                        </div>
                    </div>

                    <!-- Scraper Search & Query Bar -->
                    <div class="picker-scraper-section">
                        <div class="picker-section-header">
                            <div class="picker-section-title-wrap">
                                <h3>Available Releases on Scraper Index</h3>
                                <span class="picker-results-count-badge" id="pickerResultsCountBadge">Searching...</span>
                            </div>
                            <div class="picker-custom-search-wrap">
                                <input type="text" id="pickerCustomSearchInput" placeholder="Adjust search query..." onkeydown="if (event.key === 'Enter') triggerPickerCustomSearch()">
                                <button class="btn-primary-action" onclick="triggerPickerCustomSearch()" style="padding: 6px 14px; font-size: 12px;">Search</button>
                            </div>
                        </div>

                        <!-- Scraper Releases Cards Grid -->
                        <div class="picker-releases-grid" id="pickerReleasesGrid">
                            <div class="picker-loading-state">
                                <div class="spinner" style="margin: 0 auto 12px;"></div>
                                <div>Searching releases on scraper index...</div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <!-- VIEW: TRENDING OTT MEDIA -->
            <section class="view-container ${activeView === 'trending' ? 'active' : ''}" id="view-trending">
                <div class="releases-container">
                    <div class="releases-compact-header">
                        <div class="releases-header-left">
                            <h1 style="font-size: 15px; font-weight: 700; color: #fff; margin: 0;">Trending on OTT</h1>
                            <span class="chip quality" style="background: rgba(236, 72, 153, 0.18); color: #f472b6; border-color: rgba(236, 72, 153, 0.35); font-size: 10px; padding: 1px 6px;">Hot Buzz</span>
                            <span style="font-size: 11px; color: var(--text-muted);">Top 100 trending shows & movies on OTT in India</span>
                        </div>
                        <div class="releases-header-right">
                            <button class="btn-primary-action" id="btnRefreshTrending" onclick="loadTrendingMedia(1, true)" style="padding: 5px 12px; font-size: 11.5px; display: inline-flex; align-items: center; gap: 5px;">
                                <svg class="tabler-icon" viewBox="0 0 24 24" style="width:13px;height:13px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                <span>Refresh</span>
                            </button>
                        </div>
                    </div>

                    <!-- Filter Bar: Time Window, Type, Industry & Search -->
                    <div class="releases-filters-bar" style="gap: 10px; flex-wrap: wrap;">
                        <!-- Time Window Filter: 3m (default), 12m, 10y -->
                        <div class="time-window-pills" style="display: flex; gap: 6px; align-items: center;">
                            <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-right: 2px;">Window:</span>
                            <button class="window-pill active" data-window="3m" id="trendWin3m" onclick="setTrendingWindowFilter('3m')">3 Months</button>
                            <button class="window-pill" data-window="12m" id="trendWin12m" onclick="setTrendingWindowFilter('12m')">12 Months</button>
                            <button class="window-pill" data-window="10y" id="trendWin10y" onclick="setTrendingWindowFilter('10y')">10 Years</button>
                        </div>

                        <!-- Media Type Tabs -->
                        <div class="jf-filter-tabs">
                            <button class="jf-tab-btn active" id="trendTabAll" onclick="setTrendingTypeFilter('all')">
                                <span>All</span>
                                <span class="tab-badge" id="trendCountAll">-</span>
                            </button>
                            <button class="jf-tab-btn" id="trendTabMovie" onclick="setTrendingTypeFilter('movie')">
                                <span>Movies</span>
                            </button>
                            <button class="jf-tab-btn" id="trendTabSeries" onclick="setTrendingTypeFilter('series')">
                                <span>TV Shows</span>
                            </button>
                        </div>

                        <!-- Industry Pills -->
                        <div class="releases-industry-pills">
                            <button class="rel-industry-pill active" data-industry="all" onclick="setTrendingIndustryFilter('all')">All</button>
                            <button class="rel-industry-pill" data-industry="bollywood" onclick="setTrendingIndustryFilter('bollywood')">Bollywood</button>
                            <button class="rel-industry-pill" data-industry="tollywood" onclick="setTrendingIndustryFilter('tollywood')">Tollywood</button>
                            <button class="rel-industry-pill" data-industry="south" onclick="setTrendingIndustryFilter('south')">South Cinema</button>
                            <button class="rel-industry-pill" data-industry="hollywood" onclick="setTrendingIndustryFilter('hollywood')">Hollywood</button>
                            <button class="rel-industry-pill" data-industry="k-drama" onclick="setTrendingIndustryFilter('k-drama')">K-Drama</button>
                        </div>

                        <!-- Search Box -->
                        <div style="margin-left: auto; display: flex; align-items: center; min-width: 180px;">
                            <input type="text" id="trendSearchInput" placeholder="Filter title..." oninput="handleTrendingSearch(this.value)" style="width: 100%; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 5px 10px; font-size: 12px; color: #fff; outline: none;">
                        </div>
                    </div>

                    <!-- Cards Grid -->
                    <div class="releases-grid" id="trendingGrid">
                        <div style="grid-column: 1 / -1; text-align: center; padding: 50px 20px; color: var(--text-muted);">
                            <div class="spinner" style="margin: 0 auto 12px;"></div>
                            <div>Loading trending OTT media...</div>
                        </div>
                    </div>

                    <!-- Pagination -->
                    <div class="pagination-bar" id="trendingPaginationBar" style="display:none;"></div>
                </div>
            </section>

            <!-- VIEW: POPULAR OTT MEDIA -->
            <section class="view-container ${activeView === 'popular' ? 'active' : ''}" id="view-popular">
                <div class="releases-container">
                    <div class="releases-compact-header">
                        <div class="releases-header-left">
                            <h1 style="font-size: 15px; font-weight: 700; color: #fff; margin: 0;">Popular on OTT</h1>
                            <span class="chip quality" style="background: rgba(245, 158, 11, 0.18); color: #fbbf24; border-color: rgba(245, 158, 11, 0.35); font-size: 10px; padding: 1px 6px;">All-Time & Period Hits</span>
                            <span style="font-size: 11px; color: var(--text-muted);">Most watched & highest acclaimed OTT media in India</span>
                        </div>
                        <div class="releases-header-right">
                            <button class="btn-primary-action" id="btnRefreshPopular" onclick="loadPopularMedia(1, true)" style="padding: 5px 12px; font-size: 11.5px; display: inline-flex; align-items: center; gap: 5px;">
                                <svg class="tabler-icon" viewBox="0 0 24 24" style="width:13px;height:13px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                <span>Refresh</span>
                            </button>
                        </div>
                    </div>

                    <!-- Filter Bar: Time Window, Type, Industry & Search -->
                    <div class="releases-filters-bar" style="gap: 10px; flex-wrap: wrap;">
                        <!-- Time Window Filter: 3m (default), 12m, 10y -->
                        <div class="time-window-pills" style="display: flex; gap: 6px; align-items: center;">
                            <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-right: 2px;">Window:</span>
                            <button class="window-pill active gold" data-window="3m" id="popWin3m" onclick="setPopularWindowFilter('3m')">3 Months</button>
                            <button class="window-pill gold" data-window="12m" id="popWin12m" onclick="setPopularWindowFilter('12m')">12 Months</button>
                            <button class="window-pill gold" data-window="10y" id="popWin10y" onclick="setPopularWindowFilter('10y')">10 Years</button>
                        </div>

                        <!-- Media Type Tabs -->
                        <div class="jf-filter-tabs">
                            <button class="jf-tab-btn active" id="popTabAll" onclick="setPopularTypeFilter('all')">
                                <span>All</span>
                                <span class="tab-badge" id="popCountAll">-</span>
                            </button>
                            <button class="jf-tab-btn" id="popTabMovie" onclick="setPopularTypeFilter('movie')">
                                <span>Movies</span>
                            </button>
                            <button class="jf-tab-btn" id="popTabSeries" onclick="setPopularTypeFilter('series')">
                                <span>TV Shows</span>
                            </button>
                        </div>

                        <!-- Industry Pills -->
                        <div class="releases-industry-pills">
                            <button class="rel-industry-pill active" data-industry="all" onclick="setPopularIndustryFilter('all')">All</button>
                            <button class="rel-industry-pill" data-industry="bollywood" onclick="setPopularIndustryFilter('bollywood')">Bollywood</button>
                            <button class="rel-industry-pill" data-industry="tollywood" onclick="setPopularIndustryFilter('tollywood')">Tollywood</button>
                            <button class="rel-industry-pill" data-industry="south" onclick="setPopularIndustryFilter('south')">South Cinema</button>
                            <button class="rel-industry-pill" data-industry="hollywood" onclick="setPopularIndustryFilter('hollywood')">Hollywood</button>
                            <button class="rel-industry-pill" data-industry="k-drama" onclick="setPopularIndustryFilter('k-drama')">K-Drama</button>
                        </div>

                        <!-- Search Box -->
                        <div style="margin-left: auto; display: flex; align-items: center; min-width: 180px;">
                            <input type="text" id="popSearchInput" placeholder="Filter title..." oninput="handlePopularSearch(this.value)" style="width: 100%; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 5px 10px; font-size: 12px; color: #fff; outline: none;">
                        </div>
                    </div>

                    <!-- Cards Grid -->
                    <div class="releases-grid" id="popularGrid">
                        <div style="grid-column: 1 / -1; text-align: center; padding: 50px 20px; color: var(--text-muted);">
                            <div class="spinner" style="margin: 0 auto 12px;"></div>
                            <div>Loading popular OTT media...</div>
                        </div>
                    </div>

                    <!-- Pagination -->
                    <div class="pagination-bar" id="popularPaginationBar" style="display:none;"></div>
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
                            No active downloads in progress. Start one from AI Copilot or New Releases.
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
                                <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">Tracked requests synced from Flick</p>
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                <button class="btn-header" onclick="loadRequestedMedia()" style="display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 5px 12px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -5v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 5v-5h-5"/></svg>
                                    Refresh
                                </button>
                                <button class="btn-header" style="color: var(--accent-rose);" onclick="clearAllRequestedMedia()">Clear All Requests</button>
                            </div>
                        </div>
                        <div class="data-table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th style="min-width: 260px;">Media Title</th>
                                        <th>Type</th>
                                        <th>Requester</th>
                                        <th>Status</th>
                                        <th>Requested Date</th>
                                        <th style="text-align:right; min-width: 220px;">Actions</th>
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

            <!-- VIEW: MEDIA MOVER & SAFE INGEST -->
            <section class="view-container ${activeView === 'media' ? 'active' : ''}" id="view-media">
                <div class="download-station-wrap">
                    <!-- Metrics Row -->
                    <div class="metrics-row">
                        <div class="metric-card">
                            <div class="metric-icon-box active">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4z"/><path d="M3 6m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricMediaPendingCount">0</div>
                                <div class="metric-label">Pending Ingest</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box waiting">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricMediaMoviesCount">0</div>
                                <div class="metric-label">Movies Ready</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box waiting">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><polyline points="16 3 12 7 8 3"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricMediaShowsCount">0</div>
                                <div class="metric-label">TV Shows / Zips</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box completed">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricMediaTotalSize">0 GB</div>
                                <div class="metric-label">Pending Size</div>
                            </div>
                        </div>
                    </div>

                    <!-- Active Ingest Transfer Banner (Dynamic) -->
                    <div id="activeMoveCard" class="studio-search-card" style="display:none; border-color: rgba(59, 130, 246, 0.4); background: linear-gradient(180deg, rgba(59, 130, 246, 0.08) 0%, rgba(18, 21, 27, 0.95) 100%);">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span class="status-dot online"></span>
                                <span style="font-weight: 600; font-size: 13.5px; color: #fff;" id="activeMoveFileName">Transferring File...</span>
                                <span class="chip" id="activeMoveStageChip" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); font-size: 10.5px;">Hashing & Copying</span>
                            </div>
                            <div style="font-size: 12px; color: var(--text-secondary);" id="activeMoveSpeedEta">0 MB/s</div>
                        </div>
                        <div style="font-size: 11.5px; color: var(--text-secondary); margin-bottom: 8px;" id="activeMoveStageLabel">Calculating SHA-256 integrity checksum...</div>
                        <div style="height: 6px; width: 100%; background: var(--bg-surface-elevated); border-radius: 3px; overflow: hidden;">
                            <div id="activeMoveProgressBar" style="height: 100%; width: 0%; background: linear-gradient(90deg, #3b82f6, #10b981); transition: width 0.2s ease;"></div>
                        </div>
                    </div>

                    <!-- Pending Downloads Table -->
                    <div class="history-card">
                        <div class="history-toolbar" style="flex-wrap: wrap; gap: 10px;">
                            <div>
                                <h2 style="font-size: 15px;">Pending Downloads for Library Ingest</h2>
                                <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">
                                    Safe SHA-256 verified move into Jellyfin storage. Automatically detects existing series folders.
                                </p>
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                <button class="btn-header" onclick="scanPendingMedia()" style="display: inline-flex; align-items: center; gap: 5px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                    Scan Pending
                                </button>
                                <button class="btn-primary-action" id="btnMoveAllMedia" onclick="moveAllPendingMedia()" style="padding: 5px 14px; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                                    Move All to Library
                                </button>
                            </div>
                        </div>

                        <div class="data-table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>Media Title</th>
                                        <th>Type</th>
                                        <th>Size</th>
                                        <th>Target Jellyfin Path</th>
                                        <th style="text-align:right;">Action</th>
                                    </tr>
                                </thead>
                                <tbody id="pendingMediaTableBody">
                                    <tr><td colspan="5" style="text-align:center; padding: 25px; color: var(--text-muted);">Click "Scan Pending" or wait for download completion...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- Ingest Move History & Audit Log -->
                    <div class="history-card" style="margin-top: 16px;">
                        <div class="history-toolbar">
                            <div>
                                <h2 style="font-size: 15px;">Ingest Audit Log</h2>
                                <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">Completed safe file moves with verified SHA-256 checksums.</p>
                            </div>
                            <button class="btn-header" onclick="loadMediaHistory()" title="Refresh Log" style="display: inline-flex; align-items: center; gap: 4px;">
                                <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                Refresh
                            </button>
                        </div>
                        <div class="data-table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>Source File</th>
                                        <th>Destination</th>
                                        <th>SHA-256 Checksum</th>
                                        <th>Status</th>
                                        <th>Completed</th>
                                    </tr>
                                </thead>
                                <tbody id="mediaHistoryTableBody">
                                    <tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--text-muted);">Loading audit history...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </section>

            <!-- VIEW: LIBRARY VIDEO OPTIMIZER -->
            <section class="view-container ${activeView === 'optimizer' ? 'active' : ''}" id="view-optimizer">
                <div class="download-station-wrap">
                    <!-- Metrics Row -->
                    <div class="metrics-row">
                        <div class="metric-card">
                            <div class="metric-icon-box active">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricOptTotalScanned">0</div>
                                <div class="metric-label">Scanned Media</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box completed">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricOptOptimizedCount">0</div>
                                <div class="metric-label">Optimized / 720p</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box failed">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricOptNeedsOptCount">0</div>
                                <div class="metric-label">Oversized (>720p)</div>
                            </div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-icon-box waiting">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>
                            </div>
                            <div>
                                <div class="metric-value tabular-nums" id="metricOptQueueCount">0</div>
                                <div class="metric-label">Active Transcodes</div>
                            </div>
                        </div>
                    </div>

                    <!-- Scanner Status Bar (if scanning) -->
                    <div id="optimizerScannerBanner" class="studio-search-card" style="display:none; margin-bottom: 12px; border-color: rgba(245, 158, 11, 0.4);">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div class="spinner" style="width:14px;height:14px;margin:0;"></div>
                                <span style="font-size: 13px; font-weight: 600;" id="scannerStatusText">Scanning Library Media...</span>
                            </div>
                            <span style="font-size: 12px; color: var(--text-secondary);" id="scannerProgressPercent">0%</span>
                        </div>
                        <div style="height: 4px; width: 100%; background: var(--bg-surface-elevated); border-radius: 2px; overflow: hidden;">
                            <div id="scannerProgressBar" style="height: 100%; width: 0%; background: var(--accent-amber); transition: width 0.2s ease;"></div>
                        </div>
                    </div>

                    <!-- Unoptimized Media List -->
                    <div class="history-card">
                        <div class="history-toolbar" style="flex-wrap: wrap; gap: 10px;">
                            <div>
                                <h2 style="font-size: 15px;">Oversized Media Candidates (>720p H.264)</h2>
                                <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">
                                    Transcodes to clean 720p H.264 (CRF 22). Preserves backup until verified smaller.
                                </p>
                            </div>
                            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                                <button class="btn-header" onclick="triggerOptimizerScan()" style="display: inline-flex; align-items: center; gap: 5px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                    Scan Library
                                </button>
                                <button class="btn-primary-action" id="btnQueueAllUnopt" onclick="queueAllUnoptimized()" style="padding: 5px 14px; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; background: linear-gradient(135deg, #f59e0b, #d97706);">
                                    <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"/></svg>
                                    Optimize All Oversized
                                </button>
                            </div>
                        </div>

                        <div class="data-table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>File Name</th>
                                        <th>Resolution</th>
                                        <th>Codec</th>
                                        <th>Size</th>
                                        <th>Status</th>
                                        <th style="text-align:right;">Action</th>
                                    </tr>
                                </thead>
                                <tbody id="unoptimizedTableBody">
                                    <tr><td colspan="6" style="text-align:center; padding: 25px; color: var(--text-muted);">Loading library candidates...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- Transcoding Queue & History -->
                    <div class="history-card" style="margin-top: 16px;">
                        <div class="history-toolbar">
                            <div>
                                <h2 style="font-size: 15px;">Active Queue & Transcode History</h2>
                                <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">Durable FFmpeg background worker jobs.</p>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <button class="btn-header" style="color: var(--accent-amber);" onclick="clearOptimizerHistory()">Clear Finished</button>
                                <button class="btn-header" onclick="loadOptimizerData()" title="Refresh Queue" style="display: inline-flex; align-items: center; gap: 4px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                    Refresh
                                </button>
                            </div>
                        </div>
                        <div class="data-table-wrap">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>File</th>
                                        <th>Progress</th>
                                        <th>Original Size</th>
                                        <th>Transcoded Size</th>
                                        <th>Status</th>
                                        <th style="text-align:right;">Actions</th>
                                    </tr>
                                </thead>
                                <tbody id="optimizerQueueTableBody">
                                    <tr><td colspan="6" style="text-align:center; padding: 20px; color: var(--text-muted);">No active optimization jobs.</td></tr>
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
                    <!-- Compact Header Bar on small/large screens -->
                    <div class="jf-compact-header">
                        <div class="jf-compact-title">
                            <span class="chip jellyfin">Media Server</span>
                            <h1 style="font-size: 16px; margin: 2px 0 0; color: #fff; font-weight: 700;">Jellyfin Library</h1>
                        </div>
                        <div class="jf-compact-stats">
                            <div class="jf-stat-pill">
                                <span class="jf-stat-val tabular-nums" id="jfTotalCount">--</span>
                                <span class="jf-stat-lbl">Total Media</span>
                            </div>
                            <div class="jf-stat-pill">
                                <span class="jf-stat-val tabular-nums" id="jfMoviesCount">--</span>
                                <span class="jf-stat-lbl">Movies</span>
                            </div>
                            <div class="jf-stat-pill">
                                <span class="jf-stat-val tabular-nums" id="jfSeriesCount">--</span>
                                <span class="jf-stat-lbl">TV Shows</span>
                            </div>
                            <div class="jf-stat-pill sync">
                                <span class="status-dot online"></span>
                                <span class="jf-stat-lbl" style="color: var(--accent-emerald);">Synchronized</span>
                            </div>
                        </div>
                    </div>

                    <div class="studio-search-card" style="padding: 14px 16px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                            <h3 style="font-size: 13.5px; margin: 0;">Library Duplicate Checker & Search</h3>
                            <span style="font-size: 11px; color: var(--text-secondary);">Instant lookup for Movies & TV Shows</span>
                        </div>
                        <div style="display: flex; gap: 8px; margin-top: 10px;">
                            <input type="text" id="jfCheckInput" class="form-input" placeholder="Type any movie or show (e.g. Asur, Panchayat, Inception, Gullak)..." style="flex: 1; font-size: 12.5px;" oninput="handleJellyfinSearchInput(this.value)" onkeydown="if(event.key==='Enter') checkJellyfinItem()">
                            <button class="btn-primary-action" onclick="checkJellyfinItem()" style="padding: 6px 14px; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;">
                                <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>
                                Check
                            </button>
                        </div>
                        <div id="jfCheckResultBox" style="display:none; margin-top: 10px; padding: 12px; background: var(--bg-surface-elevated); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 12px;"></div>
                    </div>

                    <!-- JELLYFIN MEDIA COLLECTION WITH TABS -->
                    <div class="history-card" style="margin-top: 4px;">
                        <div class="history-toolbar" style="flex-wrap: wrap; gap: 10px;">
                            <div>
                                <h2 style="font-size: 15px;">Media Collection</h2>
                                <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">Indexed movies and TV shows on your server</p>
                            </div>
                            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                                <div class="jf-filter-tabs">
                                    <button type="button" class="jf-tab-btn active" data-filter="all" onclick="setJellyfinFilter('all')">
                                        <span>All</span>
                                        <span class="tab-count-badge" id="tabCountAll">0</span>
                                    </button>
                                    <button type="button" class="jf-tab-btn" data-filter="movies" onclick="setJellyfinFilter('movies')">
                                        <span>Movies</span>
                                        <span class="tab-count-badge" id="tabCountMovies">0</span>
                                    </button>
                                    <button type="button" class="jf-tab-btn" data-filter="series" onclick="setJellyfinFilter('series')">
                                        <span>TV Shows</span>
                                        <span class="tab-count-badge" id="tabCountSeries">0</span>
                                    </button>
                                </div>
                                <button class="btn-header" onclick="loadJellyfinLibrary(true)" title="Refresh Library" style="display: inline-flex; align-items: center; gap: 4px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                    Refresh
                                </button>
                            </div>
                        </div>
                        <div id="jfMoviesGrid" class="jf-movies-grid">
                            <div style="text-align: center; color: var(--text-muted); padding: 40px; width: 100%; grid-column: 1 / -1;">
                                Loading library...
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <!-- VIEW 5: ADMIN USER MANAGEMENT -->
            ${isAdmin ? `
            <section class="view-container ${activeView === 'admin' ? 'active' : ''}" id="view-admin">
                <div class="admin-wrap">
                    <!-- Admin Navigation Sub-Tabs -->
                    <div class="jf-filter-tabs" style="margin-bottom: 16px;">
                        <button type="button" class="jf-tab-btn active" id="adminTabUsers" onclick="switchAdminSubTab('users')">
                            <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/></svg>
                            <span>User Management</span>
                        </button>
                        <button type="button" class="jf-tab-btn" id="adminTabSources" onclick="switchAdminSubTab('sources')">
                            <svg class="tabler-icon" viewBox="0 0 24 24" style="width:14px;height:14px;"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M9 4v16"/><path d="M15 4v16"/><path d="M4 9h16"/><path d="M4 15h16"/></svg>
                            <span>Scraper Sources Pipeline</span>
                            <span class="tab-badge" id="adminSourcesCountBadge" style="background: rgba(56, 139, 253, 0.2); color: #58a6ff;">3</span>
                        </button>
                    </div>

                    <!-- SUB-SECTION 1: USER MANAGEMENT -->
                    <div id="adminSectionUsers">
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

                    <!-- SUB-SECTION 2: SCRAPER SOURCES PIPELINE -->
                    <div id="adminSectionSources" style="display: none;">
                        <div class="studio-search-card">
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                                <div>
                                    <h2 style="font-size: 15px; margin: 0;">Add Scraper Source</h2>
                                    <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">
                                        Add mirrors or search indexes (HDHub4u, Modlist directory, Vegamovies, or custom sites).
                                    </p>
                                </div>
                                <span class="chip best" style="font-size: 11px;">Scraper Pipeline</span>
                            </div>
                            <div class="admin-create-source-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; align-items: end;">
                                <div>
                                    <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px;">Source Name</label>
                                    <input type="text" id="adminNewSourceName" class="form-input" placeholder="e.g. Vegamovies Main">
                                </div>
                                <div>
                                    <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px;">Source Type</label>
                                    <select id="adminNewSourceType" class="form-input" style="background: var(--bg-input);">
                                        <option value="hdhub4u">HDHub4u Mirror</option>
                                        <option value="modlist">Modlist Directory (UHD/MoviesMod)</option>
                                        <option value="vegamovies">Vegamovies Mirror</option>
                                        <option value="custom">Custom Site</option>
                                    </select>
                                </div>
                                <div style="grid-column: span 2;">
                                    <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px;">Base URL</label>
                                    <input type="url" id="adminNewSourceUrl" class="form-input" placeholder="https://vegamoviess.foo">
                                </div>
                                <div>
                                    <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px;">Priority (1 = highest)</label>
                                    <input type="number" id="adminNewSourcePriority" class="form-input" value="1" min="1" max="100">
                                </div>
                                <div style="display: flex; gap: 8px;">
                                    <button type="button" class="btn-header" id="btnTestNewSource" onclick="testNewAdminSource()" style="flex: 1; padding: 7px 10px; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 4px;">
                                        <svg class="tabler-icon" viewBox="0 0 24 24" style="width:13px;height:13px;"><path d="M12 18l.01 0"/><path d="M9.172 15.172a4 4 0 0 1 5.656 0"/><path d="M6.343 12.343a8 8 0 0 1 11.314 0"/><path d="M3.515 9.515c4.686 -4.687 12.284 -4.687 17 0"/></svg>
                                        <span>Test</span>
                                    </button>
                                    <button type="button" class="btn-primary-action" onclick="addAdminSource()" style="flex: 1; padding: 7px 12px; font-size: 12px;">Add Source</button>
                                </div>
                            </div>
                            <div id="newSourceTestResult" style="display:none; margin-top: 10px; font-size: 12px; padding: 8px 12px; border-radius: var(--radius-sm);"></div>
                        </div>

                        <div class="history-card">
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                                <div>
                                    <h2 style="font-size: 15px; margin: 0;">Configured Scraper Sources</h2>
                                    <p style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">Active sources queried simultaneously when users search media.</p>
                                </div>
                                <button class="btn-header" onclick="loadAdminSources()" title="Refresh Sources" style="display: inline-flex; align-items: center; gap: 4px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24" style="width:13px;height:13px;"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                                    Refresh
                                </button>
                            </div>
                            <div class="data-table-wrap">
                                <table class="data-table">
                                    <thead>
                                        <tr>
                                            <th>Status</th>
                                            <th>Priority</th>
                                            <th>Source Name</th>
                                            <th>Type</th>
                                            <th>Base URL</th>
                                            <th>Ping / Latency</th>
                                            <th style="text-align:right;">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody id="adminSourcesTableBody">
                                        <tr><td colspan="7" style="text-align:center; padding: 20px;">Loading scraper sources...</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>

            </section>` : ""}
        </main>
    </div>

    <!-- Trailer Popup Modal -->
    <div id="trailerModal" class="trailer-modal-backdrop" onclick="handleTrailerBackdropClick(event)">
        <div class="trailer-modal-card">
            <div class="trailer-modal-header">
                <div class="trailer-modal-title" id="trailerModalTitle">Trailer</div>
                <button class="trailer-modal-close" onclick="closeTrailerModal()" title="Close (Esc)">
                    <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>
                </button>
            </div>
            <div class="trailer-player-box" id="trailerPlayerBox">
                <!-- Video iframe dynamically inserted -->
            </div>
        </div>
    </div>

    <!-- Format & Quality Options Drawer Modal (Root Level) -->
    <div class="picker-formats-modal hidden" id="pickerFormatsModal">
        <div class="picker-formats-backdrop" onclick="closePickerFormatsModal()"></div>
        <div class="picker-formats-content">
            <div class="picker-formats-header">
                <div class="picker-formats-header-info">
                    <h3 id="pickerFormatsTitle">Select Quality to Download</h3>
                    <div class="picker-formats-subtitle" id="pickerFormatsSubtitle">Direct CDN links</div>
                </div>
                <button class="picker-formats-close" onclick="closePickerFormatsModal()" title="Close (Esc)" aria-label="Close">
                    <svg class="tabler-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 6l-12 12" />
                        <path d="M6 6l12 12" />
                    </svg>
                </button>
            </div>
            <div class="picker-formats-body" id="pickerFormatsBody">
                <!-- Populated dynamically -->
            </div>
        </div>
    </div>

    <!-- Stream Link Inspector & Diagnostic Modal (Root Level) -->
    <div class="stream-inspector-modal hidden" id="streamInspectorModal">
        <div class="stream-inspector-backdrop" onclick="closeStreamInspector()"></div>
        <div class="stream-inspector-content">
            <div class="stream-inspector-header">
                <div class="stream-inspector-header-info">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-size:20px;">🔍</span>
                        <h3 id="streamInspectorTitle" style="font-size:16px; font-weight:700; color:#fff; margin:0;">Stream Link Inspector</h3>
                    </div>
                    <div class="stream-inspector-subtitle" id="streamInspectorSubtitle" style="font-size:12px; color:var(--text-muted); margin-top:3px;">
                        Live gateway hops, bypassed mediators, and final direct CDN streams
                    </div>
                </div>
                <button class="stream-inspector-close" onclick="closeStreamInspector()" title="Close (Esc)" aria-label="Close">
                    <svg class="tabler-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none">
                        <path d="M18 6l-12 12" /><path d="M6 6l12 12" />
                    </svg>
                </button>
            </div>
            <div class="stream-inspector-body" id="streamInspectorBody">
                <!-- Dynamically injected -->
            </div>
        </div>
    </div>

    <!-- Real-Time Scraper Stage-by-Stage Live Preview Modal -->
    <div class="scraper-live-monitor-modal hidden" id="scraperLiveMonitorModal">
        <div class="scraper-live-monitor-backdrop" onclick="closeScraperLiveMonitor()"></div>
        <div class="scraper-live-monitor-content">
            <div class="scraper-live-monitor-header">
                <div class="scraper-live-monitor-header-info">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="display:inline-block; animation:pulse 1.5s infinite; font-size:18px;">⚡</span>
                        <h3 id="scraperLiveMonitorTitle" style="font-size:16px; font-weight:700; color:#fff; margin:0;">Live Scraper Pipeline Tracer</h3>
                    </div>
                    <div class="scraper-live-monitor-subtitle" id="scraperLiveMonitorSubtitle" style="font-size:12px; color:var(--text-muted); margin-top:3px;">
                        Real-time 5-stage measurement across scraper search, bypass, and direct streams
                    </div>
                </div>
                <div style="display:flex; align-items:center; gap:10px;">
                    <span id="scraperLiveMonitorTotalTimer" class="stage-timer-badge">0 ms</span>
                    <button class="scraper-live-monitor-close" onclick="closeScraperLiveMonitor()" title="Close (Esc)" aria-label="Close">
                        <svg class="tabler-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none">
                            <path d="M18 6l-12 12" /><path d="M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            </div>
            <div class="scraper-live-monitor-body" id="scraperLiveMonitorBody">
                <!-- Live stage cards populated here -->
            </div>
        </div>
    </div>

    <script>
        window.__APP_USER__ = ${userJson};
        window.__INITIAL_VIEW__ = "${activeView}";
    </script>
    <script src="/js/app.js?v=${Date.now()}"></script>
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

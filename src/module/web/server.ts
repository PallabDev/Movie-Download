import express from "express";
import cookieParser from "cookie-parser";
import { db, schema } from "../../common/db/index.js";
import { eq, desc, like, sql, count } from "drizzle-orm";
import { register, login, extractUser, getAllUsers, deleteUser } from "../../common/auth/auth.js";
import { checkMovieExists, checkSeriesExists, getLibraryStats } from "../../common/jellyfin/client.js";
import { downloadQueue } from "../queue/queue.js";
import { getHarness } from "../../../command/harness.js";
import { broadcastNewDownload } from "./ws.js";
import { isBotConnected, isBotConnecting, setBotConnected, setBotConnecting, getAuthState, submitPhone, submitCode, submitPassword, startWebAuth } from "../bot/bot.js";
import { getEpisodeDetails, pickBestResult, groupByEpisode } from "../ai/brain.js";
import { handleChat } from "./chat.js";

const app = express();
app.use(express.json());
app.use(cookieParser());

// In-memory search sessions: searchId -> { botUsername, sentId, btnMsgId, buttons, title, type, year }
const searchSessions = new Map<string, any>();

// ─── AUTH MIDDLEWARE ───

function requireAuth(req: any, res: any, next: any) {
    const user = extractUser(req);
    if (!user) {
        console.log(`[AUTH] requireAuth FAILED - url: ${req.url}, method: ${req.method}`);
        return res.status(401).json({ error: "Not authenticated" });
    }
    req.user = user;
    next();
}

function requireAdmin(req: any, res: any, next: any) {
    const user = extractUser(req);
    if (!user) {
        console.log(`[AUTH] requireAdmin FAILED (no auth) - url: ${req.url}`);
        return res.status(401).json({ error: "Not authenticated" });
    }
    if (user.role !== "admin") {
        console.log(`[AUTH] requireAdmin FAILED (role=${user.role}) - url: ${req.url}`);
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
        console.log(`[AUTH] Login attempt, body type: ${typeof req.body}, body: ${JSON.stringify(req.body)?.substring(0, 200)}`);
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

app.get("/api/bot/status", requireAdmin, (_req, res) => {
    const auth = getAuthState();
    res.json({ connected: isBotConnected(), connecting: isBotConnecting(), auth });
});

app.post("/api/bot/reconnect", requireAdmin, async (_req, res) => {
    if (isBotConnecting()) return res.status(400).json({ error: "Already connecting" });
    if (isBotConnected()) return res.json({ success: true, message: "Already connected" });

    // Fire-and-forget — startWebAuth blocks until auth completes
    startWebAuth().catch(() => {});
    // Wait briefly for state to change
    await new Promise(r => setTimeout(r, 1500));
    const state = getAuthState();
    return res.json({ success: false, step: state.step });
});

app.post("/api/bot/auth/phone", requireAdmin, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone number required" });
    const result = submitPhone(phone);
    if (!result.ok) return res.status(400).json({ error: result.error });
    // Poll for state change (Telegram may take a moment to respond)
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

app.post("/api/bot/auth/code", requireAdmin, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Code required" });
    const result = submitCode(code);
    if (!result.ok) return res.status(400).json({ error: result.error });
    // Poll for state change (Telegram may ask for password or complete)
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

app.post("/api/bot/auth/password", requireAdmin, async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Password required" });
    const result = submitPassword(password);
    if (!result.ok) return res.status(400).json({ error: result.error });
    // Poll for completion
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

app.get("/api/bot/auth/status", requireAdmin, (_req, res) => {
    const state = getAuthState();
    return res.json(state);
});

// ─── SEARCH (Step 1: AI + Bot search, return results) ───

app.post("/api/search", requireAdmin, async (req: any, res) => {
    const { title, type, year } = req.body;
    if (!title || !type) return res.status(400).json({ error: "Title and type required" });
    if (type !== "movie" && type !== "series") return res.status(400).json({ error: "Type must be movie or series" });

    const harness = getHarness();
    const searchId = `srch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
        // Step 1: AI analysis
        console.log(`[SEARCH] Analyzing "${title}" (type: ${type})`);
        const aiResult = await harness.processRequest(
            `User wants: "${title}"${year ? ` from year ${year}` : ""}. ` +
            `Type: ${type}. Clean the name to Title Case. ` +
            `Reply ONLY JSON: {"title":"...","year":"...","query":"..."}`
        );

        let parsed: Record<string, any> | null = null;
        try { const m = aiResult.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch { }

        const cleanTitle = parsed?.title || title;
        const cleanYear = parsed?.year || year || "";
        const query = type === "movie"
            ? `${cleanTitle} ${cleanYear}`.trim()
            : cleanTitle;

        console.log(`[SEARCH] Query: "${query}"`);

        // Step 2: Check Jellyfin
        if (type === "movie") {
            const jf = await checkMovieExists(cleanTitle, cleanYear);
            if (jf.exists) {
                return res.json({ searchId, status: "skipped", message: `"${cleanTitle}" already in Jellyfin`, results: [] });
            }
        } else {
            const jf = await checkSeriesExists(cleanTitle);
            if (jf.exists) {
                return res.json({ searchId, status: "skipped", message: `"${cleanTitle}" already in Jellyfin`, results: [] });
            }
        }

        // Step 3: Search Telegram bot
        const bot = type === "movie" ? "ProSearchM11Bot" : "ProSearchY11Bot";
        const botClient = (await import("../../module/bot/bot.js")).default;

        console.log(`[SEARCH] Sending to @${bot}: ${query}`);
        const sent = await botClient.sendMessage(bot, { message: query });
        await new Promise(r => setTimeout(r, 4000));

        // Find button message
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

        if (!btnMsg) {
            return res.json({ searchId, status: "no_results", message: "Bot did not respond with results", results: [] });
        }

        // Extract buttons
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

        // Store session for later selection
        searchSessions.set(searchId, {
            bot,
            sentId: sent.id,
            btnMsgId: btnMsg.id,
            btnMsg,
            type,
            title: cleanTitle,
            year: cleanYear,
            createdAt: Date.now(),
        });

        // Clean old sessions (>30min)
        for (const [k, v] of searchSessions) {
            if (Date.now() - v.createdAt > 30 * 60 * 1000) searchSessions.delete(k);
        }

        // AI: pick best result
        let bestIdx = -1;
        let bestReason = "";
        if (results.length > 0) {
            const best = await pickBestResult(cleanTitle, type, results);
            bestIdx = best.index;
            bestReason = best.reason;
        }

        // For series: group results by episode
        let seriesEpisodes: any[] = [];
        let uniqueSeasons: number[] = [];
        if (type === "series" && results.length > 0) {
            seriesEpisodes = groupByEpisode(results);
            uniqueSeasons = [...new Set(seriesEpisodes.map(e => e.season))].sort((a, b) => a - b);
        }

        console.log(`[SEARCH] Found ${results.length} results, best: #${bestIdx + 1} (${bestReason}), episodes: ${seriesEpisodes.length}`);
        return res.json({
            searchId, status: "results", title: cleanTitle, year: cleanYear,
            results, bestIdx, bestReason, seriesEpisodes, uniqueSeasons,
        });

    } catch (err: any) {
        console.error(`[SEARCH] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── SELECT & DOWNLOAD (Step 2: User picks a result) ───

app.post("/api/select", requireAdmin, async (req: any, res) => {
    const { searchId, buttonText } = req.body;
    if (!searchId || !buttonText) return res.status(400).json({ error: "searchId and buttonText required" });

    const session = searchSessions.get(searchId);
    if (!session) return res.status(400).json({ error: "Search session expired or not found" });

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const harness = getHarness();

    try {
        // Insert download record
        const typeLabel = session.type === "movie" ? "movie" : "series";
        await db.insert(schema.downloads).values({
            requestId,
            title: session.title,
            year: session.year || null,
            type: typeLabel,
            status: "clicking",
            requestedBy: req.user.userId,
        });

        broadcastNewDownload({
            jobId: requestId,
            title: session.title,
            type: typeLabel,
            requestedBy: req.user.email,
        });

        // Click the button on the bot
        const botClient = (await import("../../module/bot/bot.js")).default;
        const btnMsg = session.btnMsg;

        console.log(`[SELECT] Clicking "${buttonText}" on @${session.bot}`);
        await btnMsg.click({ text: buttonText });

        // Extract file size
        const sizeMatch = buttonText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
        const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;

        await updateDB(requestId, { status: "downloading", fileSize });

        // Add download job to queue
        downloadQueue.addJob({
            requestId,
            bot: session.bot,
            btnMsgId: btnMsg.id,
            type: session.type,
            title: session.title,
            year: session.year,
            fileSize: fileSize || undefined,
        });

        // Clean up session
        searchSessions.delete(searchId);

        return res.json({
            success: true,
            requestId,
            message: `Download started for "${session.title}"`,
        });

    } catch (err: any) {
        console.error(`[SELECT] Error:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── SERIES BULK DOWNLOAD ───

app.post("/api/select-all-episodes", requireAdmin, async (req: any, res) => {
    const { searchId, season } = req.body;
    if (!searchId) return res.status(400).json({ error: "searchId required" });

    const session = searchSessions.get(searchId);
    if (!session) return res.status(400).json({ error: "Search session expired" });
    if (session.type !== "series") return res.status(400).json({ error: "Not a series" });

    const harness = getHarness();
    const seasonNum = season || 1;

    try {
        // Get all results from the stored session
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

        // Group by episode
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
                console.log(`[BULK] Queued: ${ep.label} (${ep.sizeMB.toFixed(0)} MB)`);

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

// ─── JELLYFIN API ───

app.get("/api/jellyfin/stats", requireAuth, async (_req, res) => {
    const stats = await getLibraryStats();
    res.json(stats);
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

// ─── CHAT AGENT ───

app.post("/api/chat", requireAdmin, async (req: any, res) => {
    try {
        const { message, history, sessionId } = req.body;
        if (!message) return res.status(400).json({ error: "Message required" });

        // Use provided sessionId or generate one per user
        const sid = sessionId || `chat_${req.user.userId}_${Date.now()}`;

        console.log(`[CHAT] User: ${message} (session: ${sid})`);
        const result = await handleChat(message, history || [], sid);
        console.log(`[CHAT] Reply: ${result.reply.substring(0, 100)}`);

        res.json({ ...result, sessionId: sid });
    } catch (err: any) {
        console.error(`[CHAT] Error:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── INNGEST SERVE ───

import { serve } from "inngest/express";
import { inngest } from "../inngest/client.js";
import { movieSearchWorkflow, seriesSearchWorkflow, downloadWorkflow } from "../inngest/functions.js";

const inngestApp = serve({
    client: inngest,
    functions: [movieSearchWorkflow, seriesSearchWorkflow, downloadWorkflow],
});
app.use("/api/inngest", inngestApp);
console.log("[INNGEST] Serve handler mounted at /api/inngest");

// ─── PAGES ───

app.get("/", (req, res) => {
    const user = extractUser(req);
    res.send(user ? getDashboardPage(user) : getLoginPage());
});

app.get("/login", (req, res) => {
    if (extractUser(req)) return res.redirect("/");
    res.send(getLoginPage());
});

app.get("/register", (req, res) => {
    if (extractUser(req)) return res.redirect("/");
    res.send(getRegisterPage());
});

app.get("/admin", requireAdmin, (req: any, res) => {
    res.send(getAdminPage(req.user));
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

// ─── UI HTML ───

function getLoginPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - Movie Downloader</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
        .auth-card{background:#12121a;border:1px solid #1e1e2e;border-radius:16px;padding:40px;width:100%;max-width:400px}
        .auth-card h1{text-align:center;margin-bottom:8px;color:#00d4ff;font-size:24px}
        .auth-card .subtitle{text-align:center;color:#666;margin-bottom:32px;font-size:14px}
        .form-group{margin-bottom:20px}
        .form-group label{display:block;margin-bottom:6px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px}
        input{width:100%;padding:12px 16px;background:#1a1a2e;border:1px solid #2a2a3e;border-radius:8px;color:#fff;font-size:15px;transition:border-color .2s}
        input:focus{outline:none;border-color:#00d4ff}
        button{width:100%;padding:14px;background:linear-gradient(135deg,#00d4ff,#0088cc);border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s}
        button:hover{opacity:.9}
        .error{background:#ff000022;border:1px solid #ff000044;color:#ff6666;padding:10px;border-radius:8px;margin-bottom:16px;font-size:13px;display:none}
        .links{text-align:center;margin-top:20px;font-size:13px;color:#666}
        .links a{color:#00d4ff;text-decoration:none}
    </style>
</head>
<body>
    <div class="auth-card">
        <h1>Movie Downloader</h1>
        <p class="subtitle">Sign in to your account</p>
        <div class="error" id="error"></div>
        <form onsubmit="handleLogin(event)">
            <div class="form-group"><label>Email</label><input type="email" id="email" required placeholder="you@example.com"></div>
            <div class="form-group"><label>Password</label><input type="password" id="password" required placeholder="Your password"></div>
            <button type="submit">Sign In</button>
        </form>
        <div class="links">Don't have an account? <a href="/register">Register</a></div>
    </div>
    <script>
        async function handleLogin(e){
            e.preventDefault();
            const errEl=document.getElementById('error');errEl.style.display='none';
            try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('password').value})});const d=await r.json();if(d.success)window.location.href='/';else{errEl.textContent=d.error||'Login failed';errEl.style.display='block'}}catch(err){errEl.textContent='Connection error';errEl.style.display='block'}
        }
    </script>
</body>
</html>`;
}

function getRegisterPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Register - Movie Downloader</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
        .auth-card{background:#12121a;border:1px solid #1e1e2e;border-radius:16px;padding:40px;width:100%;max-width:400px}
        .auth-card h1{text-align:center;margin-bottom:8px;color:#00d4ff;font-size:24px}
        .auth-card .subtitle{text-align:center;color:#666;margin-bottom:32px;font-size:14px}
        .form-group{margin-bottom:20px}
        .form-group label{display:block;margin-bottom:6px;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px}
        input{width:100%;padding:12px 16px;background:#1a1a2e;border:1px solid #2a2a3e;border-radius:8px;color:#fff;font-size:15px;transition:border-color .2s}
        input:focus{outline:none;border-color:#00d4ff}
        button{width:100%;padding:14px;background:linear-gradient(135deg,#00d4ff,#0088cc);border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s}
        button:hover{opacity:.9}
        .error{background:#ff000022;border:1px solid #ff000044;color:#ff6666;padding:10px;border-radius:8px;margin-bottom:16px;font-size:13px;display:none}
        .links{text-align:center;margin-top:20px;font-size:13px;color:#666}
        .links a{color:#00d4ff;text-decoration:none}
    </style>
</head>
<body>
    <div class="auth-card">
        <h1>Movie Downloader</h1>
        <p class="subtitle">Create your account</p>
        <div class="error" id="error"></div>
        <form onsubmit="handleRegister(event)">
            <div class="form-group"><label>Name</label><input type="text" id="name" required placeholder="Your name"></div>
            <div class="form-group"><label>Email</label><input type="email" id="email" required placeholder="you@example.com"></div>
            <div class="form-group"><label>Password</label><input type="password" id="password" required minlength="6" placeholder="Min 6 characters"></div>
            <button type="submit">Create Account</button>
        </form>
        <div class="links">Already have an account? <a href="/login">Sign in</a></div>
    </div>
    <script>
        async function handleRegister(e){
            e.preventDefault();
            const errEl=document.getElementById('error');errEl.style.display='none';
            try{const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('name').value,email:document.getElementById('email').value,password:document.getElementById('password').value})});const d=await r.json();if(d.success)window.location.href='/';else{errEl.textContent=d.error||'Registration failed';errEl.style.display='block'}}catch(err){errEl.textContent='Connection error';errEl.style.display='block'}
        }
    </script>
</body>
</html>`;
}

function getDashboardPage(user: any): string {
    const isAdmin = user.role === "admin";
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Movie Downloader</title>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',system-ui,sans-serif;background:#111118;color:#d4d4d8;height:100vh;display:flex;flex-direction:column}

        /* Topbar */
        .topbar{display:flex;justify-content:space-between;align-items:center;padding:8px 24px;background:#16161e;border-bottom:1px solid #27272a;flex-shrink:0}
        .topbar h1{font-size:14px;color:#a1a1aa;font-weight:500}
        .topbar h1 b{color:#60a5fa;font-weight:600}
        .topbar .user-info{display:flex;align-items:center;gap:12px;font-size:11px;color:#71717a}
        .topbar .role{background:#1e3a5f;color:#60a5fa;padding:2px 8px;border-radius:4px;font-size:9px;text-transform:uppercase;font-weight:600;letter-spacing:0.5px}
        .topbar a{color:#f87171;text-decoration:none;font-size:11px;transition:color .2s}
        .topbar a:hover{color:#ef4444}


        /* Main Layout */
        .main-wrap{flex:1;display:flex;justify-content:center;overflow:hidden}
        .chat-container{width:100%;max-width:1100px;display:flex;flex-direction:column;border-left:1px solid #27272a;border-right:1px solid #27272a;background:#18181f}

        /* Bot bar */
        .bot-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:#1a1a22;border-bottom:1px solid #27272a;flex-shrink:0}
        .bot-bar .bot-left{display:flex;align-items:center;gap:10px}
        .bot-bar .bot-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
        .bot-bar .bot-label{font-size:12px;color:#a1a1aa}
        .bot-bar .bot-dot.on{background:#4ade80;box-shadow:0 0 6px #4ade8066}
        .bot-bar .bot-dot.off{background:#f87171;box-shadow:0 0 6px #f8717166}
        .bot-bar .bot-dot.wait{background:#fbbf24;box-shadow:0 0 6px #fbbf2466}
        .top-actions{display:flex;gap:8px}
        .top-actions button{padding:5px 12px;border-radius:6px;border:1px solid #3f3f46;background:#27272a;color:#a1a1aa;font-size:11px;cursor:pointer;transition:all .2s}
        .top-actions button:hover{border-color:#60a5fa;color:#60a5fa}
        .top-actions button.new-chat{border-color:#60a5fa44;color:#60a5fa}

        /* Chat area */
        .chat-messages{flex:1;overflow-y:auto;padding:24px 20px;display:flex;flex-direction:column;gap:14px;scroll-behavior:smooth}
        .chat-messages::-webkit-scrollbar{width:6px}
        .chat-messages::-webkit-scrollbar-track{background:transparent}
        .chat-messages::-webkit-scrollbar-thumb{background:#3f3f46;border-radius:3px}
        .chat-messages::-webkit-scrollbar-thumb:hover{background:#52525b}

        .msg-bubble{max-width:80%;padding:12px 16px;border-radius:12px;font-size:13px;line-height:1.6;animation:fadeIn .15s ease-out;word-wrap:break-word}
        @keyframes fadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
        .msg-user{align-self:flex-end;background:#2563eb;color:#fff;border-bottom-right-radius:4px}
        .msg-ai{align-self:flex-start;background:#27272a;border:1px solid #3f3f46;color:#d4d4d8;border-bottom-left-radius:4px}
        .msg-ai.tool-call{border-color:#8b5cf644;background:#8b5cf60a}
        .msg-ai.tool-result{border-color:#4ade8044;background:#4ade800a}
        .tool-label{font-size:9px;color:#a78bfa;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px;font-weight:600}
        .result-label{font-size:9px;color:#4ade80;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px;font-weight:600}
        .msg-system{align-self:center;font-size:11px;color:#52525b;padding:4px 14px;background:#1e1e26;border-radius:20px;border:1px solid #27272a}
        .msg-error{align-self:center;font-size:12px;color:#f87171;background:#f8717112;padding:8px 16px;border-radius:8px;border:1px solid #f8717133}
        .msg-ai table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}
        .msg-ai th,.msg-ai td{border:1px solid #3f3f46;padding:6px 8px;text-align:left}
        .msg-ai th{background:#1e1e26;color:#e4e4e7}
        .msg-ai h1,.msg-ai h2,.msg-ai h3{margin:6px 0;font-size:14px;color:#e4e4e7}
        .msg-ai code{background:#1e1e26;padding:1px 4px;border-radius:3px;font-size:11px}
        .msg-ai pre{background:#1e1e26;padding:8px;border-radius:6px;overflow:auto;margin:6px 0}
        .msg-ai ul,.msg-ai ol{margin:6px 0 6px 18px}

        /* Quick actions */
        .quick-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:8px}
        .quick-btn{padding:8px 16px;background:#27272a;border:1px solid #3f3f46;border-radius:20px;color:#a1a1aa;font-size:12px;cursor:pointer;transition:all .2s}
        .quick-btn:hover{border-color:#60a5fa;color:#60a5fa;background:#27272a}

        /* Progress cards in chat - circular */
        .progress-card{align-self:flex-start;background:#27272a;border:1px solid #3f3f46;border-radius:12px;padding:14px 18px;max-width:70%;animation:fadeIn .15s ease-out;display:flex;align-items:center;gap:14px}
        .progress-card .pc-circle-wrap{position:relative;width:48px;height:48px;flex-shrink:0}
        .progress-card .pc-circle-wrap svg{transform:rotate(-90deg);width:48px;height:48px}
        .progress-card .pc-circle-bg{fill:none;stroke:#3f3f46;stroke-width:4}
        .progress-card .pc-circle-fill{fill:none;stroke:#3b82f6;stroke-width:4;stroke-linecap:round;stroke-dasharray:113.1;stroke-dashoffset:113.1;transition:stroke-dashoffset .4s ease, stroke .3s ease}
        .progress-card .pc-circle-fill.pc-downloading{stroke:#60a5fa;animation:pulseRing 1.5s infinite}
        .progress-card .pc-circle-fill.pc-completed{stroke:#4ade80}
        .progress-card .pc-circle-fill.pc-failed{stroke:#f87171}
        .progress-card .pc-percent{font-size:9px;fill:#e4e4e7;font-weight:600;transform:rotate(90deg);transform-origin:24px 24px}
        .progress-card .pc-details{flex:1;min-width:0}
        .progress-card .pc-title{font-size:13px;color:#e4e4e7;margin-bottom:4px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .progress-card .pc-status{font-size:11px;font-weight:600}
        .progress-card .pc-speed{font-size:10px;color:#71717a;margin-top:2px}
        .pc-status.pc-downloading{color:#60a5fa}
        .pc-status.pc-completed{color:#4ade80}
        .pc-status.pc-failed{color:#f87171}
        .pc-status.pc-queued{color:#fbbf24}
        @keyframes pulseRing{0%,100%{opacity:1}50%{opacity:.6}}

        /* Typing indicator */
        .typing-dots{display:flex;gap:4px;padding:4px 0}
        .typing-dots span{width:5px;height:5px;border-radius:50%;background:#60a5fa;animation:typing 1.4s infinite}
        .typing-dots span:nth-child(2){animation-delay:.2s}
        .typing-dots span:nth-child(3){animation-delay:.4s}
        @keyframes typing{0%,60%,100%{transform:translateY(0);opacity:.3}30%{transform:translateY(-3px);opacity:1}}

        /* Scroll to bottom button */
        .scroll-btn{position:absolute;bottom:100px;right:calc(50% - 530px);width:36px;height:36px;border-radius:50%;background:#27272a;border:1px solid #3f3f46;color:#a1a1aa;font-size:16px;cursor:pointer;display:none;align-items:center;justify-content:center;z-index:10;transition:all .2s;box-shadow:0 2px 8px rgba(0,0,0,.4)}
        .scroll-btn:hover{border-color:#60a5fa;color:#60a5fa}
        .scroll-btn.show{display:flex}
        @media(max-width:1140px){.scroll-btn{right:20px}}

        /* Chat input */
        .chat-input-wrap{flex-shrink:0;padding:14px 20px;background:#1a1a22;border-top:1px solid #27272a}
        .chat-input{display:flex;gap:10px;align-items:flex-end;max-width:1100px;margin:0 auto}
        .chat-input textarea{flex:1;padding:12px 16px;background:#27272a;border:1px solid #3f3f46;border-radius:10px;color:#e4e4e7;font-size:13px;resize:none;max-height:140px;min-height:44px;line-height:1.5;font-family:inherit;transition:border-color .2s}
        .chat-input textarea:focus{outline:none;border-color:#60a5fa}
        .chat-input textarea::placeholder{color:#52525b}
        .btn-send{width:44px;height:44px;border-radius:10px;border:none;background:#2563eb;color:#fff;font-size:16px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:background .2s}
        .btn-send:hover{background:#1d4ed8}
        .btn-send:disabled{opacity:.3;cursor:not-allowed}

        @media(max-width:600px){
            .topbar{padding:6px 12px}
            .chat-messages{padding:16px 12px}
            .chat-input-wrap{padding:10px 12px}
            .msg-bubble{max-width:92%}
            .progress-card{max-width:92%}
        }
    </style>
</head>
<body>
    <div class="topbar">
        <h1><b>Downloader</b> AI</h1>
        <div class="user-info">
            <span class="role">${user.role}</span>
            <span>${user.email}</span>
            ${isAdmin ? '<a href="/admin">Admin</a>' : ""}
            <a href="#" onclick="logout()">Logout</a>
        </div>
    </div>

    <div class="main-wrap" style="position:relative">
        <div class="chat-container">
            <div class="bot-bar">
                <div class="bot-left">
                    <span class="bot-dot off" id="botDot"></span>
                    <span class="bot-label" id="botStatus">Checking...</span>
                </div>
                <div class="top-actions">
                    <button class="new-chat" onclick="newChat()">+ New Chat</button>
                </div>
            </div>

            <div class="chat-messages" id="chatMessages">
                <div class="msg-system">Ask me to search, download, or check your library</div>
                <div class="quick-actions" id="quickActions">
                    <button class="quick-btn" onclick="quickAction('connect bot')">Connect Bot</button>
                    <button class="quick-btn" onclick="quickAction('search Bahubali 2 movie')">Search Bahubali 2</button>
                    <button class="quick-btn" onclick="quickAction('check if Breaking Bad is in Jellyfin')">Check Jellyfin</button>
                    <button class="quick-btn" onclick="quickAction('show my recent downloads')">Recent Downloads</button>
                </div>
            </div>

            <button class="scroll-btn" id="scrollBtn" onclick="scrollToBottom()">&#8595;</button>

            <div class="chat-input-wrap">
                <div class="chat-input">
                    <textarea id="chatInput" placeholder="Search movie, download series, check Jellyfin..." rows="1"></textarea>
                    <button class="btn-send" id="btnSend" onclick="sendMessage()">&#9654;</button>
                </div>
            </div>
        </div>
    </div>

    <script>
    let ws, chatHistory=[], sending=false, sessionId=null;
    const chatEl=document.getElementById('chatMessages');
    const inputEl=document.getElementById('chatInput');
    const sendBtn=document.getElementById('btnSend');
    const scrollBtnEl=document.getElementById('scrollBtn');

    function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

    function scrollToBottom(){chatEl.scrollTop=chatEl.scrollHeight}

    chatEl.addEventListener('scroll',()=>{
        const atBottom=chatEl.scrollHeight-chatEl.scrollTop-chatEl.clientHeight<80;
        scrollBtnEl.classList.toggle('show',!atBottom);
    });

    function addMsg(html,type){
        const d=document.createElement('div');
        d.className='msg-bubble msg-'+type;
        d.innerHTML=html;
        chatEl.appendChild(d);
        const atBottom=chatEl.scrollHeight-chatEl.scrollTop-chatEl.clientHeight<200;
        if(atBottom)scrollToBottom();
        return d;
    }
    function addSystem(text){
        const d=document.createElement('div');
        d.className='msg-system';
        d.textContent=text;
        chatEl.appendChild(d);
        scrollToBottom();
    }
    function addError(text){
        const d=document.createElement('div');
        d.className='msg-error';
        d.textContent=text;
        chatEl.appendChild(d);
        scrollToBottom();
    }
    function showTyping(){
        const d=document.createElement('div');
        d.className='msg-bubble msg-ai';
        d.id='typingBubble';
        d.innerHTML='<div class="typing-dots"><span></span><span></span><span></span></div>';
        chatEl.appendChild(d);
        scrollToBottom();
    }
    function removeTyping(){const el=document.getElementById('typingBubble');if(el)el.remove()}

    function addProgressCard(jobId,title){
        const d=document.createElement('div');
        d.className='progress-card';
        d.id='pc-'+jobId;
        d.innerHTML='<div class="pc-circle-wrap"><svg viewBox="0 0 48 48"><circle class="pc-circle-bg" cx="24" cy="24" r="18"/><circle class="pc-circle-fill pc-queued" cx="24" cy="24" r="18" style="stroke-dashoffset:113.1"/><text x="24" y="28" text-anchor="middle" class="pc-percent">0%</text></svg></div><div class="pc-details"><div class="pc-title">'+escHtml(title)+'</div><div class="pc-status pc-queued">Queued</div><div class="pc-speed"></div></div>';
        chatEl.appendChild(d);
        scrollToBottom();
        return d;
    }
    function updateProgressCard(jobId,data){
        const el=document.getElementById('pc-'+jobId);
        if(!el)return;
        const fill=el.querySelector('.pc-circle-fill');
        const pctEl=el.querySelector('.pc-percent');
        const status=el.querySelector('.pc-status');
        const speedEl=el.querySelector('.pc-speed');
        const circ=113.1;
        const offset=circ*(1-(data.percent||0)/100);
        if(fill){ fill.style.strokeDashoffset=offset; fill.className='pc-circle-fill pc-'+data.status.toLowerCase().replace(/[^a-z]/g,''); }
        if(pctEl) pctEl.textContent=(data.percent||0)+'%';
        if(status){ status.textContent=data.status; status.className='pc-status pc-'+data.status.toLowerCase().replace(/[^a-z]/g,''); }
        if(speedEl) speedEl.textContent=data.speed?(data.speed+' \u00b7 ETA '+data.eta):'';
        scrollToBottom();
    }
    function completeProgressCard(jobId,success,error){
        const el=document.getElementById('pc-'+jobId);
        if(!el)return;
        const fill=el.querySelector('.pc-circle-fill');
        const pctEl=el.querySelector('.pc-percent');
        const status=el.querySelector('.pc-status');
        if(fill){ fill.style.strokeDashoffset=success?'0':'113.1'; fill.className='pc-circle-fill pc-'+(success?'completed':'failed'); }
        if(pctEl) pctEl.textContent=success?'✓':'✕';
        if(status){ status.textContent=success?'Completed':'Failed'; status.className='pc-status pc-'+(success?'completed':'failed'); }
        if(!success&&error){ const sEl=el.querySelector('.pc-speed'); if(sEl) sEl.textContent=error; sEl.style.color='#f87171'; }
        scrollToBottom();
    }

    function newChat(){
        chatHistory=[];sessionId=null;
        chatEl.innerHTML='<div class="msg-system">New chat started</div>';
        inputEl.focus();
    }

    function quickAction(text){
        inputEl.value=text;
        inputEl.focus();
        sendMessage();
    }

    async function sendMessage(){
        const text=inputEl.value.trim();
        if(!text||sending)return;
        sending=true;sendBtn.disabled=true;
        inputEl.value='';inputEl.style.height='auto';
        addMsg(escHtml(text),'user');
        chatHistory.push({role:'user',content:text});
        showTyping();
        try{
            const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({message:text,history:chatHistory.slice(-20),sessionId})});
            const d=await r.json();
            removeTyping();
            if(d.sessionId)sessionId=d.sessionId;
            if(d.error){addError(d.error)}
            else{
                if(d.toolCalls&&d.toolCalls.length>0){
                    for(const tc of d.toolCalls){
                        const argsStr=Object.entries(tc.args||{}).map(([k,v])=>k+': '+v).join(', ');
                        addMsg('<div class="tool-label">Tool</div>'+escHtml(tc.tool)+'('+escHtml(argsStr)+')','ai tool-call');
                        addMsg('<div class="result-label">Result</div>'+escHtml(tc.result?.message||''),'ai tool-result');
                    }
                }
                try{ addMsg(marked.parse(d.reply),'ai'); } catch{ addMsg(escHtml(d.reply).replace(/\\n/g,'<br>'),'ai'); }
                chatHistory.push({role:'assistant',content:d.reply});
            }
        }catch(e){removeTyping();addError('Connection error: '+e.message)}
        sending=false;sendBtn.disabled=false;inputEl.focus();
    }

    inputEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
    inputEl.addEventListener('input',()=>{inputEl.style.height='auto';inputEl.style.height=Math.min(inputEl.scrollHeight,140)+'px'});

    // WebSocket - progress in chat
    function connectWS(){
        ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws');
        ws.onopen=()=>{ws.send(JSON.stringify({type:'auth',userId:${user.id},role:'${user.role}'}))};
        ws.onmessage=e=>{
            const m=JSON.parse(e.data);
            if(m.type==='new_download'){addProgressCard(m.jobId,m.title)}
            else if(m.type==='download_progress'){updateProgressCard(m.jobId,{status:'Downloading',percent:m.percent,speed:m.speed,eta:m.eta})}
            else if(m.type==='download_complete'){completeProgressCard(m.jobId,m.success,m.error)}
        };
        ws.onclose=()=>setTimeout(connectWS,3000);
    }

    // Bot status - just shows dot, no modal
    async function checkBotStatus(){
        try{
            const r=await fetch('/api/bot/status',{credentials:'include'});
            const d=await r.json();
            const dot=document.getElementById('botDot');
            const el=document.getElementById('botStatus');
            const btn=document.getElementById('btnReconnect');
            if(!el)return;
            if(d.connected){
                dot.className='bot-dot on';el.textContent='Bot Connected';el.style.color='#4ade80';
                btn.style.display='none';
            }else if(d.auth&&d.auth.step!=='idle'&&d.auth.step!=='done'&&d.auth.step!=='error'){
                dot.className='bot-dot wait';el.textContent='Auth: '+d.auth.step;el.style.color='#fbbf24';
                btn.style.display='none';
            }else if(d.connecting){
                dot.className='bot-dot wait';el.textContent='Connecting...';el.style.color='#fbbf24';btn.style.display='none';
            }else{
                dot.className='bot-dot off';el.textContent='Bot Disconnected - type "connect bot" to start';el.style.color='#f87171';
                btn.style.display='none';
            }
        }catch(e){}
    }
    async function logout(){await fetch('/api/auth/logout',{method:'POST',credentials:'include'});location.href='/login'}

    checkBotStatus();setInterval(checkBotStatus,15000);
    connectWS();
    </script>
</body>
</html>`;
}

function getAdminPage(user: any): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin - Movie Downloader</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0}
        .topbar{display:flex;justify-content:space-between;align-items:center;padding:16px 32px;background:#0d0d14;border-bottom:1px solid #1e1e2e}
        .topbar h1{font-size:18px;color:#00d4ff}
        .topbar a{color:#888;text-decoration:none;font-size:13px;margin-left:16px}
        .container{max-width:900px;margin:0 auto;padding:24px}
        .card{background:#12121a;border:1px solid #1e1e2e;border-radius:12px;padding:24px;margin-bottom:20px}
        .card h2{font-size:16px;margin-bottom:16px;color:#00d4ff}
        table{width:100%;border-collapse:collapse}
        th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #1e1e2e;font-size:13px}
        th{color:#666;text-transform:uppercase;font-size:11px}
        button{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:13px}
        .btn-primary{background:linear-gradient(135deg,#00d4ff,#0088cc);color:#fff}
        .btn-danger{background:#ff444422;color:#ff4444}
        .form-row{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
        .form-row input,.form-row select{padding:10px 14px;background:#1a1a2e;border:1px solid #2a2a3e;border-radius:8px;color:#fff;font-size:14px}
    </style>
</head>
<body>
    <div class="topbar">
        <h1>Admin Panel</h1>
        <div><a href="/">Dashboard</a><a href="#" onclick="logout()">Logout</a></div>
    </div>
    <div class="container">
        <div class="card">
            <h2>Add User</h2>
            <div class="form-row">
                <input type="text" id="newName" placeholder="Name">
                <input type="email" id="newEmail" placeholder="Email">
                <input type="password" id="newPass" placeholder="Password">
                <select id="newRole"><option value="user">User</option><option value="admin">Admin</option></select>
                <button class="btn-primary" onclick="addUser()">Add</button>
            </div>
            <div id="addResult" style="font-size:13px;margin-top:8px"></div>
        </div>
        <div class="card">
            <h2>Users</h2>
            <table>
                <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th></th></tr></thead>
                <tbody id="usersTable"><tr><td colspan="5">Loading...</td></tr></tbody>
            </table>
        </div>
    </div>
    <script>
        async function loadUsers(){const r=await fetch('/api/admin/users');const d=await r.json();document.getElementById('usersTable').innerHTML=d.users.map(u=>'<tr><td>'+u.name+'</td><td>'+u.email+'</td><td style="color:'+(u.role==='admin'?'#00d4ff':'#888')+'">'+u.role+'</td><td>'+new Date(u.createdAt).toLocaleDateString()+'</td><td><button class="btn-danger" onclick="deleteUser('+u.id+')">Delete</button></td></tr>').join('')}
        async function addUser(){const r=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('newName').value,email:document.getElementById('newEmail').value,password:document.getElementById('newPass').value,role:document.getElementById('newRole').value})});const d=await r.json();document.getElementById('addResult').innerHTML=d.success?'<span style="color:#00ff88">User created</span>':'<span style="color:#ff4444">'+d.error+'</span>';if(d.success)loadUsers()}
        async function deleteUser(id){if(!confirm('Delete this user?'))return;await fetch('/api/admin/users/'+id,{method:'DELETE'});loadUsers()}
        async function logout(){await fetch('/api/auth/logout',{method:'POST'});location.href='/login'}
        loadUsers();
    </script>
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

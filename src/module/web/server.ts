import express from "express";
import cookieParser from "cookie-parser";
import { db, schema } from "../../common/db/index.js";
import { eq, desc, like, sql, count } from "drizzle-orm";
import { register, login, extractUser, getAllUsers, deleteUser } from "../../common/auth/auth.js";
import { checkMovieExists, checkSeriesExists, getLibraryStats, getAllMovies } from "../../common/jellyfin/client.js";
import { addDownloadJob, downloadQueue } from "../queue/queue.js";
import { getExistingDownloads } from "../download/downloader.js";
import { getHarness } from "../../../command/harness.js";
import { broadcastNewDownload } from "./ws.js";

const app = express();
app.use(express.json());
app.use(cookieParser());

// Auth middleware
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
        if (!email || !password || !name) {
            return res.status(400).json({ error: "Email, password, and name required" });
        }

        // Check if any users exist - first user becomes admin
        const existingUsers = await db.select({ id: schema.users.id }).from(schema.users).limit(1);
        const role = existingUsers.length === 0 ? "admin" : "user";

        const user = await register(email, password, name, role as "user" | "admin");
        const token = (await login(email, password)).token;

        res.cookie("token", token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ success: true, user, token });
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: "Email and password required" });
        }
        const result = await login(email, password);
        res.cookie("token", result.token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ success: true, ...result });
    } catch (err: any) {
        res.status(401).json({ error: err.message });
    }
});

app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("token");
    res.json({ success: true });
});

app.get("/api/auth/me", requireAuth, async (req: any, res) => {
    const { getUserById } = await import("../../common/auth/auth.js");
    const user = await getUserById(req.user.userId);
    res.json({ user });
});

// Admin: manage users
app.get("/api/admin/users", requireAdmin, async (req, res) => {
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

// ─── MOVIE REQUEST (admin only) ───

app.post("/api/request-movie", requireAdmin, async (req: any, res) => {
    const harness = getHarness();
    const { title, year } = req.body;

    if (!title || typeof title !== "string" || title.trim().length === 0) {
        return res.status(400).json({ error: "Title is required" });
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Check Jellyfin first
    let jellyfinExists = false;
    try {
        const movieCheck = await checkMovieExists(title.trim(), year);
        jellyfinExists = movieCheck.exists;
        if (jellyfinExists) {
            console.log(`[JELLYFIN] "${title}" already exists in library`);
        }
    } catch { }

    // Insert into DB
    const [dl] = await db.insert(schema.downloads).values({
        requestId,
        title: title.trim(),
        year: year || null,
        type: "movie",
        status: jellyfinExists ? "skipped" : "pending",
        jellyfinExists,
        requestedBy: req.user.userId,
    }).returning({ id: schema.downloads.id });

    console.log(`[WEB] New request: "${title}" (jellyfin: ${jellyfinExists})`);

    if (!jellyfinExists) {
        addDownloadJob({
            requestId,
            input: title.trim(),
            year: year || undefined,
            status: "pending",
        });

        broadcastNewDownload({
            jobId: requestId,
            title: title.trim(),
            type: "movie",
            requestedBy: req.user.email,
        });
    }

    res.json({
        success: true,
        requestId,
        id: dl.id,
        jellyfinExists,
        message: jellyfinExists
            ? `"${title}" already exists in Jellyfin library`
            : `Download queued for "${title}"`,
    });
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
        pagination: {
            page,
            limit,
            total: Number(totalResult[0].count),
            pages: Math.ceil(Number(totalResult[0].count) / limit),
        },
    });
});

app.get("/api/downloads/:id", requireAuth, async (req, res) => {
    const [dl] = await db.select().from(schema.downloads).where(eq(schema.downloads.id, Number(req.params.id)));
    if (!dl) return res.status(404).json({ error: "Not found" });
    res.json({ download: dl });
});

// ─── JELLYFIN API ───

app.get("/api/jellyfin/stats", requireAuth, async (req, res) => {
    const stats = await getLibraryStats();
    res.json(stats);
});

app.get("/api/jellyfin/movies", requireAuth, async (req, res) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const allMovies = await getAllMovies();
    const offset = (page - 1) * limit;
    const movies = allMovies.slice(offset, offset + limit);

    res.json({
        movies,
        pagination: {
            page,
            limit,
            total: allMovies.length,
            pages: Math.ceil(allMovies.length / limit),
        },
    });
});

app.get("/api/jellyfin/check", requireAuth, async (req, res) => {
    const title = req.query.title as string;
    const year = req.query.year as string;
    const type = (req.query.type as string) || "movie";

    if (!title) return res.status(400).json({ error: "Title required" });

    if (type === "series") {
        const result = await checkSeriesExists(title);
        res.json(result);
    } else {
        const result = await checkMovieExists(title, year);
        res.json(result);
    }
});

// ─── QUEUE STATUS ───

app.get("/api/queue", requireAuth, async (req, res) => {
    res.json({ stats: downloadQueue.getStats() });
});

app.get("/api/logs", requireAuth, async (req, res) => {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const [total] = await db.select({ count: count() }).from(schema.activityLogs);
    const logs = await db.select().from(schema.activityLogs)
        .orderBy(desc(schema.activityLogs.createdAt))
        .limit(limit)
        .offset(offset);

    res.json({
        logs,
        pagination: {
            page,
            limit,
            total: Number(total.count),
            pages: Math.ceil(Number(total.count) / limit),
        },
    });
});

// ─── LEGACY REDIRECT ───

app.post("/request-movie", requireAdmin, async (req: any, res) => {
    // Forward to the API endpoint
    req.url = "/api/request-movie";
    app(req, res);
});

// ─── SERVE UI ───

app.get("/", (req, res) => {
    const user = extractUser(req);

    if (!user) {
        // Serve login page
        res.send(getLoginPage());
    } else {
        // Serve dashboard
        res.send(getDashboardPage(user));
    }
});

app.get("/login", (req, res) => {
    const user = extractUser(req);
    if (user) return res.redirect("/");
    res.send(getLoginPage());
});

app.get("/register", (req, res) => {
    const user = extractUser(req);
    if (user) return res.redirect("/");
    res.send(getRegisterPage());
});

app.get("/admin", requireAdmin, (req: any, res) => {
    res.send(getAdminPage(req.user));
});

// ─── UI HTML ───

function getLoginPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - Movie Downloader</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .auth-card { background: #12121a; border: 1px solid #1e1e2e; border-radius: 16px; padding: 40px; width: 400px; }
        .auth-card h1 { text-align: center; margin-bottom: 8px; color: #00d4ff; font-size: 24px; }
        .auth-card .subtitle { text-align: center; color: #666; margin-bottom: 32px; font-size: 14px; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 6px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
        input { width: 100%; padding: 12px 16px; background: #1a1a2e; border: 1px solid #2a2a3e; border-radius: 8px; color: #fff; font-size: 15px; transition: border-color 0.2s; }
        input:focus { outline: none; border-color: #00d4ff; }
        button { width: 100%; padding: 14px; background: linear-gradient(135deg, #00d4ff, #0088cc); border: none; border-radius: 8px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
        button:hover { opacity: 0.9; }
        .error { background: #ff000022; border: 1px solid #ff000044; color: #ff6666; padding: 10px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; display: none; }
        .links { text-align: center; margin-top: 20px; font-size: 13px; color: #666; }
        .links a { color: #00d4ff; text-decoration: none; }
    </style>
</head>
<body>
    <div class="auth-card">
        <h1>Movie Downloader</h1>
        <p class="subtitle">Sign in to your account</p>
        <div class="error" id="error"></div>
        <form onsubmit="handleLogin(event)">
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="email" required placeholder="you@example.com">
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" id="password" required placeholder="Your password">
            </div>
            <button type="submit">Sign In</button>
        </form>
        <div class="links">Don't have an account? <a href="/register">Register</a></div>
    </div>
    <script>
        async function handleLogin(e) {
            e.preventDefault();
            const errEl = document.getElementById('error');
            errEl.style.display = 'none';
            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email: document.getElementById('email').value,
                        password: document.getElementById('password').value,
                    }),
                });
                const data = await res.json();
                if (data.success) {
                    window.location.href = '/';
                } else {
                    errEl.textContent = data.error || 'Login failed';
                    errEl.style.display = 'block';
                }
            } catch (err) {
                errEl.textContent = 'Connection error';
                errEl.style.display = 'block';
            }
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
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .auth-card { background: #12121a; border: 1px solid #1e1e2e; border-radius: 16px; padding: 40px; width: 400px; }
        .auth-card h1 { text-align: center; margin-bottom: 8px; color: #00d4ff; font-size: 24px; }
        .auth-card .subtitle { text-align: center; color: #666; margin-bottom: 32px; font-size: 14px; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 6px; font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
        input { width: 100%; padding: 12px 16px; background: #1a1a2e; border: 1px solid #2a2a3e; border-radius: 8px; color: #fff; font-size: 15px; transition: border-color 0.2s; }
        input:focus { outline: none; border-color: #00d4ff; }
        button { width: 100%; padding: 14px; background: linear-gradient(135deg, #00d4ff, #0088cc); border: none; border-radius: 8px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
        button:hover { opacity: 0.9; }
        .error { background: #ff000022; border: 1px solid #ff000044; color: #ff6666; padding: 10px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; display: none; }
        .links { text-align: center; margin-top: 20px; font-size: 13px; color: #666; }
        .links a { color: #00d4ff; text-decoration: none; }
    </style>
</head>
<body>
    <div class="auth-card">
        <h1>Movie Downloader</h1>
        <p class="subtitle">Create your account</p>
        <div class="error" id="error"></div>
        <form onsubmit="handleRegister(event)">
            <div class="form-group">
                <label>Name</label>
                <input type="text" id="name" required placeholder="Your name">
            </div>
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="email" required placeholder="you@example.com">
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" id="password" required minlength="6" placeholder="Min 6 characters">
            </div>
            <button type="submit">Create Account</button>
        </form>
        <div class="links">Already have an account? <a href="/login">Sign in</a></div>
    </div>
    <script>
        async function handleRegister(e) {
            e.preventDefault();
            const errEl = document.getElementById('error');
            errEl.style.display = 'none';
            try {
                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: document.getElementById('name').value,
                        email: document.getElementById('email').value,
                        password: document.getElementById('password').value,
                    }),
                });
                const data = await res.json();
                if (data.success) {
                    window.location.href = '/';
                } else {
                    errEl.textContent = data.error || 'Registration failed';
                    errEl.style.display = 'block';
                }
            } catch (err) {
                errEl.textContent = 'Connection error';
                errEl.style.display = 'block';
            }
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
    <title>Dashboard - Movie Downloader</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a0f; color: #e0e0e0; }
        .topbar { display: flex; justify-content: space-between; align-items: center; padding: 16px 32px; background: #0d0d14; border-bottom: 1px solid #1e1e2e; }
        .topbar h1 { font-size: 18px; color: #00d4ff; }
        .topbar .user-info { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #888; }
        .topbar .role { background: ${isAdmin ? "#00d4ff22" : "#33333322"}; color: ${isAdmin ? "#00d4ff" : "#888"}; padding: 4px 10px; border-radius: 12px; font-size: 11px; text-transform: uppercase; }
        .topbar a { color: #ff6666; text-decoration: none; font-size: 13px; }
        .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
        .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
        .stat-card { background: #12121a; border: 1px solid #1e1e2e; border-radius: 12px; padding: 20px; text-align: center; }
        .stat-card .number { font-size: 28px; font-weight: 700; color: #00d4ff; }
        .stat-card .label { font-size: 11px; color: #666; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px; }
        .card { background: #12121a; border: 1px solid #1e1e2e; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
        .card h2 { font-size: 16px; margin-bottom: 16px; color: #00d4ff; display: flex; align-items: center; gap: 8px; }
        .card h2 .badge { background: #00d4ff22; color: #00d4ff; padding: 2px 8px; border-radius: 8px; font-size: 11px; }
        input, select { padding: 10px 14px; background: #1a1a2e; border: 1px solid #2a2a3e; border-radius: 8px; color: #fff; font-size: 14px; }
        input:focus, select:focus { outline: none; border-color: #00d4ff; }
        .request-form { display: flex; gap: 12px; align-items: flex-end; }
        .request-form .form-group { flex: 1; }
        .request-form .form-group label { display: block; margin-bottom: 4px; font-size: 11px; color: #888; text-transform: uppercase; }
        .request-form select { width: 120px; }
        button { padding: 10px 20px; background: linear-gradient(135deg, #00d4ff, #0088cc); border: none; border-radius: 8px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
        button:hover { opacity: 0.9; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-danger { background: linear-gradient(135deg, #ff4444, #cc0000); }
        .btn-sm { padding: 6px 12px; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 10px 12px; font-size: 11px; color: #666; text-transform: uppercase; border-bottom: 1px solid #1e1e2e; }
        td { padding: 10px 12px; border-bottom: 1px solid #1e1e2e; font-size: 13px; }
        .status { padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
        .status-pending { background: #ffaa0022; color: #ffaa00; }
        .status-downloading { background: #00d4ff22; color: #00d4ff; }
        .status-completed { background: #00ff8822; color: #00ff88; }
        .status-failed { background: #ff444422; color: #ff4444; }
        .status-skipped { background: #88888822; color: #888; }
        .status-searching, .status-clicking, .status-analyzing { background: #aa88ff22; color: #aa88ff; }
        .progress-bar { width: 100px; height: 6px; background: #1a1a2e; border-radius: 3px; overflow: hidden; }
        .progress-bar .fill { height: 100%; background: #00d4ff; transition: width 0.3s; }
        .pagination { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }
        .pagination button { background: #1a1a2e; border: 1px solid #2a2a3e; padding: 6px 12px; font-size: 12px; }
        .pagination button.active { background: #00d4ff; border-color: #00d4ff; }
        .ws-status { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
        .ws-connected { background: #00ff88; }
        .ws-disconnected { background: #ff4444; }
        .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .jellyfin-list { max-height: 300px; overflow-y: auto; }
        .jellyfin-list li { padding: 8px 12px; border-bottom: 1px solid #1e1e2e; font-size: 13px; list-style: none; display: flex; justify-content: space-between; }
        .jellyfin-list li span.year { color: #666; }
        @media (max-width: 768px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } .two-col { grid-template-columns: 1fr; } .request-form { flex-direction: column; } }
    </style>
</head>
<body>
    <div class="topbar">
        <h1>Movie Downloader <span class="ws-status ws-disconnected" id="wsStatus"></span></h1>
        <div class="user-info">
            <span class="role">${user.role}</span>
            <span>${user.email}</span>
            ${isAdmin ? '<a href="/admin">Admin</a>' : ""}
            <a href="#" onclick="logout()">Logout</a>
        </div>
    </div>
    <div class="container">
        <div class="stats-grid">
            <div class="stat-card"><div class="number" id="statTotal">-</div><div class="label">Total Downloads</div></div>
            <div class="stat-card"><div class="number" id="statActive">-</div><div class="label">Active</div></div>
            <div class="stat-card"><div class="number" id="statDone">-</div><div class="label">Completed</div></div>
            <div class="stat-card"><div class="number" id="statJellyfin">-</div><div class="label">In Jellyfin</div></div>
        </div>

        ${isAdmin ? `
        <div class="card">
            <h2>Request Download</h2>
            <div class="request-form">
                <div class="form-group">
                    <label>Movie or Series Name</label>
                    <input type="text" id="reqTitle" placeholder="e.g., Bahubali 2, Breaking Bad..." style="width:100%">
                </div>
                <div class="form-group">
                    <label>Year</label>
                    <select id="reqYear">
                        <option value="">Any</option>
                        ${Array.from({ length: 30 }, (_, i) => 2026 - i).map((y) => `<option value="${y}">${y}</option>`).join("")}
                    </select>
                </div>
                <button onclick="submitRequest()" id="reqBtn">Search & Download</button>
            </div>
            <div id="reqResult" style="margin-top:12px;font-size:13px;display:none"></div>
        </div>
        ` : ""}

        <div class="card">
            <h2>Downloads <span class="badge" id="downloadCount">0</span></h2>
            <div style="margin-bottom:12px">
                <input type="text" id="searchInput" placeholder="Search downloads..." oninput="loadDownloads(1)" style="width:300px">
            </div>
            <table>
                <thead><tr><th>Title</th><th>Type</th><th>Year</th><th>Status</th><th>Progress</th><th>Created</th></tr></thead>
                <tbody id="downloadsTable"><tr><td colspan="6" style="text-align:center;color:#666">Loading...</td></tr></tbody>
            </table>
            <div class="pagination" id="pagination"></div>
        </div>
    </div>

    <script>
        let currentPage = 1;
        let ws;
        const token = document.cookie.match(/token=([^;]+)/)?.[1] || "";

        function connectWS() {
            ws = new WebSocket(\`\${location.protocol === 'https:' ? 'wss' : 'ws'}://\${location.host}/ws\`);
            ws.onopen = () => {
                document.getElementById('wsStatus').className = 'ws-status ws-connected';
                ws.send(JSON.stringify({ type: 'auth', userId: ${user.id}, role: '${user.role}' }));
            };
            ws.onmessage = (e) => {
                const msg = JSON.parse(e.data);
                if (msg.type === 'download_progress') {
                    updateProgress(msg);
                } else if (msg.type === 'download_complete') {
                    loadDownloads(currentPage);
                    loadStats();
                } else if (msg.type === 'new_download') {
                    loadDownloads(currentPage);
                    loadStats();
                }
            };
            ws.onclose = () => {
                document.getElementById('wsStatus').className = 'ws-status ws-disconnected';
                setTimeout(connectWS, 3000);
            };
        }

        function updateProgress(msg) {
            const row = document.getElementById(\`row-\${msg.jobId}\`);
            if (row) {
                const statusCell = row.querySelector('.status');
                statusCell.innerHTML = \`<span class="status status-\${msg.status}">\${msg.status}</span>\`;
                const progCell = row.querySelector('.progress');
                progCell.innerHTML = \`<div class="progress-bar"><div class="fill" style="width:\${msg.percent}%"></div></div> \${msg.percent}%\`;
            }
        }

        async function submitRequest() {
            const btn = document.getElementById('reqBtn');
            const result = document.getElementById('reqResult');
            btn.disabled = true;
            btn.textContent = 'Processing...';
            result.style.display = 'none';

            try {
                const res = await fetch('/api/request-movie', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: document.getElementById('reqTitle').value,
                        year: document.getElementById('reqYear').value || undefined,
                    }),
                });
                const data = await res.json();
                result.style.display = 'block';
                if (data.jellyfinExists) {
                    result.innerHTML = \`<span style="color:#ffaa00">\${data.message}</span>\`;
                } else {
                    result.innerHTML = \`<span style="color:#00ff88">\${data.message}</span>\`;
                }
                loadDownloads(1);
                loadStats();
            } catch (err) {
                result.style.display = 'block';
                result.innerHTML = '<span style="color:#ff4444">Connection error</span>';
            }
            btn.disabled = false;
            btn.textContent = 'Search & Download';
        }

        async function loadDownloads(page) {
            currentPage = page;
            const search = document.getElementById('searchInput')?.value || '';
            try {
                const res = await fetch(\`/api/downloads?page=\${page}&limit=15&search=\${encodeURIComponent(search)}\`, {
                    headers: { 'Authorization': 'Bearer ' + token },
                });
                const data = await res.json();
                const tbody = document.getElementById('downloadsTable');

                if (data.downloads.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666">No downloads yet</td></tr>';
                } else {
                    tbody.innerHTML = data.downloads.map(d => \`
                        <tr id="row-\${d.requestId}">
                            <td><strong>\${d.title}</strong></td>
                            <td>\${d.type}</td>
                            <td>\${d.year || '-'}</td>
                            <td class="status"><span class="status status-\${d.status}">\${d.status}</span></td>
                            <td class="progress">\${d.status === 'downloading' ? '<div class="progress-bar"><div class="fill" style="width:' + (d.progress || 0) + '%"></div></div> ' + (d.progress || 0) + '%' : '-'}</td>
                            <td>\${new Date(d.createdAt).toLocaleDateString()}</td>
                        </tr>
                    \`).join('');
                }

                document.getElementById('downloadCount').textContent = data.pagination.total;

                // Pagination
                const pag = document.getElementById('pagination');
                if (data.pagination.pages > 1) {
                    let html = '';
                    for (let i = 1; i <= data.pagination.pages; i++) {
                        html += \`<button class="\${i === page ? 'active' : ''}" onclick="loadDownloads(\${i})">\${i}</button>\`;
                    }
                    pag.innerHTML = html;
                } else {
                    pag.innerHTML = '';
                }
            } catch { }
        }

        async function loadStats() {
            try {
                const [dlRes, jfRes] = await Promise.all([
                    fetch('/api/downloads?limit=1000', { headers: { 'Authorization': 'Bearer ' + token } }),
                    fetch('/api/jellyfin/stats', { headers: { 'Authorization': 'Bearer ' + token } }),
                ]);
                const dlData = await dlRes.json();
                const jfData = await jfRes.json();

                document.getElementById('statTotal').textContent = dlData.pagination.total;
                document.getElementById('statActive').textContent = dlData.downloads.filter(d => ['pending','analyzing','searching','clicking','downloading'].includes(d.status)).length;
                document.getElementById('statDone').textContent = dlData.downloads.filter(d => d.status === 'completed').length;
                document.getElementById('statJellyfin').textContent = jfData.movies || 0;
            } catch { }
        }

        async function logout() {
            await fetch('/api/auth/logout', { method: 'POST' });
            location.href = '/login';
        }

        connectWS();
        loadDownloads(1);
        loadStats();
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
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a0f; color: #e0e0e0; }
        .topbar { display: flex; justify-content: space-between; align-items: center; padding: 16px 32px; background: #0d0d14; border-bottom: 1px solid #1e1e2e; }
        .topbar h1 { font-size: 18px; color: #00d4ff; }
        .topbar a { color: #888; text-decoration: none; font-size: 13px; margin-left: 16px; }
        .container { max-width: 900px; margin: 0 auto; padding: 24px; }
        .card { background: #12121a; border: 1px solid #1e1e2e; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
        .card h2 { font-size: 16px; margin-bottom: 16px; color: #00d4ff; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #1e1e2e; font-size: 13px; }
        th { color: #666; text-transform: uppercase; font-size: 11px; }
        button { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
        .btn-primary { background: linear-gradient(135deg, #00d4ff, #0088cc); color: #fff; }
        .btn-danger { background: #ff444422; color: #ff4444; }
        .form-row { display: flex; gap: 12px; margin-bottom: 16px; }
        .form-row input, .form-row select { padding: 10px 14px; background: #1a1a2e; border: 1px solid #2a2a3e; border-radius: 8px; color: #fff; font-size: 14px; }
        .role-admin { color: #00d4ff; }
        .role-user { color: #888; }
    </style>
</head>
<body>
    <div class="topbar">
        <h1>Admin Panel</h1>
        <div>
            <a href="/">Dashboard</a>
            <a href="#" onclick="logout()">Logout</a>
        </div>
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
        async function loadUsers() {
            const res = await fetch('/api/admin/users');
            const data = await res.json();
            document.getElementById('usersTable').innerHTML = data.users.map(u => \`
                <tr>
                    <td>\${u.name}</td>
                    <td>\${u.email}</td>
                    <td class="role-\${u.role}">\${u.role}</td>
                    <td>\${new Date(u.createdAt).toLocaleDateString()}</td>
                    <td><button class="btn-danger" onclick="deleteUser(\${u.id})">Delete</button></td>
                </tr>
            \`).join('');
        }
        async function addUser() {
            const res = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: document.getElementById('newName').value,
                    email: document.getElementById('newEmail').value,
                    password: document.getElementById('newPass').value,
                    role: document.getElementById('newRole').value,
                }),
            });
            const data = await res.json();
            document.getElementById('addResult').innerHTML = data.success ? '<span style="color:#00ff88">User created</span>' : '<span style="color:#ff4444">' + data.error + '</span>';
            if (data.success) loadUsers();
        }
        async function deleteUser(id) {
            if (!confirm('Delete this user?')) return;
            await fetch('/api/admin/users/' + id, { method: 'DELETE' });
            loadUsers();
        }
        async function logout() {
            await fetch('/api/auth/logout', { method: 'POST' });
            location.href = '/login';
        }
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

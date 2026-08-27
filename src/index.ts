import client from "./module/bot/bot.js";
import { env } from "./common/utils/env.js";
import { initHarness } from "../command/harness.js";
import { createDownloadWorker } from "./module/queue/queue.js";
import { startServer } from "./module/web/server.js";
import { setupWebSocket } from "./module/web/ws.js";
import { db } from "./common/db/index.js";
import { sql } from "drizzle-orm";
import { Logger } from "teleproto";
import { register } from "./common/auth/auth.js";

Logger.setLevel("none");

// Init DB tables
console.log("[INIT] Setting up database...");
try {
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'user',
            created_at TIMESTAMP DEFAULT NOW() NOT NULL
        )
    `);
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS downloads (
            id SERIAL PRIMARY KEY,
            request_id VARCHAR(100) NOT NULL UNIQUE,
            title VARCHAR(500) NOT NULL,
            year VARCHAR(10),
            type VARCHAR(20) NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'pending',
            quality VARCHAR(20),
            file_size VARCHAR(50),
            download_path TEXT,
            season INTEGER,
            episode INTEGER,
            total_episodes INTEGER,
            jellyfin_exists BOOLEAN DEFAULT FALSE,
            error TEXT,
            progress INTEGER DEFAULT 0,
            speed VARCHAR(50),
            eta VARCHAR(50),
            requested_by INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        )
    `);
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS activity_logs (
            id SERIAL PRIMARY KEY,
            level VARCHAR(20) NOT NULL,
            message TEXT NOT NULL,
            source VARCHAR(50),
            metadata JSONB,
            created_at TIMESTAMP DEFAULT NOW() NOT NULL
        )
    `);
    console.log("[INIT] Database tables ready");
} catch (err) {
    console.error("[INIT] DB setup error:", err);
}

// Init Harness
console.log("[INIT] Starting AI Harness...");
const harness = initHarness({
    baseUrl: env.AI_BASE_URL,
    apiKey: env.AI_API_KEY,
    model: env.AI_MODEL,
});
harness.logActivity("=== System Started ===");

// Init Queue Worker
console.log("[INIT] Starting download queue worker...");
createDownloadWorker();

// Start Web Server + WebSocket
console.log("[INIT] Starting web server...");
const server = startServer(env.PORT);
setupWebSocket(server);

// Create default admin if no users exist
try {
    const existingUsers = await db.execute(sql`SELECT id FROM users LIMIT 1`);
    if (existingUsers.length === 0) {
        await register("admin@admin.com", "admin123", "Admin", "admin");
        console.log("[INIT] Default admin created: admin@admin.com / admin123");
    }
} catch (err) {
    console.error("[INIT] Admin creation error:", err);
}

// Connect Telegram
console.log("[INIT] Connecting Telegram client...");
const isDocker = process.env.DOCKER === "true" || !process.stdin.isTTY;

try {
    if (isDocker) {
        // Non-interactive: try to connect with existing session
        await client.connect();
        const me = await client.getMe();
        console.log(`[TELEGRAM] Signed in as ${me.username ?? me.firstName ?? me.id}`);
    } else {
        // Interactive: full auth flow
        await client.start({
            phoneNumber: async () => {
                const { createInterface } = await import("node:readline/promises");
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                const phone = await rl.question("Phone: ");
                rl.close();
                return phone;
            },
            phoneCode: async () => {
                const { createInterface } = await import("node:readline/promises");
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                const code = await rl.question("Code from Telegram: ");
                rl.close();
                return code;
            },
            password: async () => {
                const { createInterface } = await import("node:readline/promises");
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                const pw = await rl.question("2FA password (if set): ");
                rl.close();
                return pw;
            },
            onError: async (err: Error) => {
                harness.logError(`[TELEGRAM] Error: ${err.message}`);
                console.error("[TELEGRAM] Error:", err);
                return false;
            },
        });
        const me = await client.getMe();
        console.log(`[TELEGRAM] Signed in as ${me.username ?? me.firstName ?? me.id}`);
    }
} catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[TELEGRAM] Failed:", errMsg);
    console.log("[TELEGRAM] Continuing without Telegram...");
}

console.log("=========================================");
console.log(`  Dashboard: http://localhost:${env.PORT}`);
console.log(`  Admin: admin@admin.com / admin123`);
console.log("=========================================");

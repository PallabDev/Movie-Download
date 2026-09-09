import { env } from "./common/utils/env.js";
import { initHarness } from "../command/harness.js";
import { createDownloadWorker } from "./module/queue/queue.js";
import { startServer } from "./module/web/server.js";
import { setupWebSocket } from "./module/web/ws.js";
import { db } from "./common/db/index.js";
import { sql } from "drizzle-orm";
import { register } from "./common/auth/auth.js";
import { DL_API_BASE_URL } from "./module/download/api-client.js";

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
        );
        CREATE TABLE IF NOT EXISTS agent_memory (
            id SERIAL PRIMARY KEY,
            session_id VARCHAR(100) NOT NULL,
            role VARCHAR(20) NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requested_media (
            id SERIAL PRIMARY KEY,
            title VARCHAR(500) NOT NULL,
            type VARCHAR(20) NOT NULL DEFAULT 'movie',
            year VARCHAR(10),
            status VARCHAR(50) NOT NULL DEFAULT 'requested',
            season INTEGER,
            episode INTEGER,
            metadata JSONB,
            requested_by VARCHAR(255),
            created_at TIMESTAMP DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ott_releases (
            id SERIAL PRIMARY KEY,
            tmdb_id INTEGER NOT NULL UNIQUE,
            title VARCHAR(500) NOT NULL,
            original_title VARCHAR(500),
            original_language VARCHAR(10) NOT NULL,
            industry VARCHAR(50) NOT NULL,
            release_date VARCHAR(20),
            year VARCHAR(10),
            overview TEXT,
            poster_url TEXT,
            backdrop_url TEXT,
            rating REAL DEFAULT 0,
            vote_count INTEGER DEFAULT 0,
            popularity REAL DEFAULT 0,
            providers JSONB,
            jellyfin_exists BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW() NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        )
    `);
    await db.execute(sql`
        ALTER TABLE downloads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW() NOT NULL;
        ALTER TABLE requested_media ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW() NOT NULL;
        ALTER TABLE ott_releases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW() NOT NULL;
        ALTER TABLE ott_releases ADD COLUMN IF NOT EXISTS media_type VARCHAR(20) DEFAULT 'movie' NOT NULL;
        ALTER TABLE ott_releases ADD COLUMN IF NOT EXISTS ott_release_date VARCHAR(20);
        ALTER TABLE ott_releases ADD COLUMN IF NOT EXISTS trailer_key VARCHAR(100);
        DO $$ 
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ott_releases_tmdb_id_key') THEN
                ALTER TABLE ott_releases DROP CONSTRAINT ott_releases_tmdb_id_key;
            END IF;
        END $$;
        CREATE UNIQUE INDEX IF NOT EXISTS ott_releases_tmdb_type_idx ON ott_releases (tmdb_id, media_type);
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
console.log("[INIT] Starting high-speed HTTP direct download worker...");
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

console.log("=========================================");
console.log(`  CineGrab AI Studio running at port ${env.PORT}`);
console.log(`  Download Engine: ${DL_API_BASE_URL} (10Gbps CDN)`);
console.log(`  Dashboard: http://localhost:${env.PORT}`);
console.log(`  Admin: admin@admin.com / admin123`);
console.log("=========================================");

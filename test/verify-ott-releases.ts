import { syncIndianOTTReleasesToDB } from "../src/common/tmdb/client.js";
import { db, schema } from "../src/common/db/index.js";
import { sql, desc } from "drizzle-orm";

async function verify() {
    console.log("1. Ensuring database table exists...");
    await db.execute(sql`
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

    console.log("2. Running syncIndianOTTReleasesToDB({ daysBack: 45, pageLimit: 2 })...");
    const syncRes = await syncIndianOTTReleasesToDB({ daysBack: 45, pageLimit: 2 });
    console.log("Sync Result:", syncRes);

    console.log("3. Querying stored OTT releases from PostgreSQL...");
    const stored = await db.select().from(schema.ottReleases).orderBy(desc(schema.ottReleases.releaseDate)).limit(5);
    console.log(`Found ${stored.length} items in PostgreSQL:`);
    for (const item of stored) {
        console.log(`- [${item.industry}] ${item.title} (${item.releaseDate}) - TMDB: ${item.rating} - Providers: ${JSON.stringify(item.providers?.map((p: any) => p.name))}`);
    }

    console.log("4. Testing Daily Mode sync (daysBack: 2)...");
    const dailyRes = await syncIndianOTTReleasesToDB({ daysBack: 2, pageLimit: 1 });
    console.log("Daily Sync Result:", dailyRes);

    console.log("✅ Verification successful!");
    process.exit(0);
}

verify().catch((err) => {
    console.error("Verification failed:", err);
    process.exit(1);
});

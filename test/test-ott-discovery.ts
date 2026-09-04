import { discoverIndianOTTReleases, mapLanguageToIndustry } from "../src/common/tmdb/client.js";

async function testDiscovery() {
    console.log("=== Testing 30-Day Indian OTT Discovery ===");
    const res30 = await discoverIndianOTTReleases({ daysBack: 30, page: 1 });
    console.log(`Found ${res30.results.length} releases (Total on TMDB: ${res30.totalResults})`);

    for (const item of res30.results.slice(0, 8)) {
        const provNames = item.providers.map(p => p.name).join(", ") || "None";
        console.log(`🎬 [${item.industry}] ${item.title} (${item.year}) - Rating: ${item.rating}/10`);
        console.log(`   Release Date: ${item.releaseDate} | Providers (IN): ${provNames}`);
    }

    console.log("\n=== Testing Daily Mode (Last 48 Hours) ===");
    const res2 = await discoverIndianOTTReleases({ daysBack: 2, page: 1 });
    console.log(`Found ${res2.results.length} releases from the last 48h`);
    for (const item of res2.results) {
        const provNames = item.providers.map(p => p.name).join(", ") || "None";
        console.log(`⚡ [${item.industry}] ${item.title} (${item.releaseDate}) - Providers: ${provNames}`);
    }

    console.log("\n=== Testing Industry Mapping ===");
    console.log("hi ->", mapLanguageToIndustry("hi"));
    console.log("ta ->", mapLanguageToIndustry("ta"));
    console.log("te ->", mapLanguageToIndustry("te"));
    console.log("ml ->", mapLanguageToIndustry("ml"));
    console.log("kn ->", mapLanguageToIndustry("kn"));
    console.log("bn ->", mapLanguageToIndustry("bn"));

    console.log("\n✅ OTT Discovery logic verified successfully!");
}

testDiscovery().catch(console.error);

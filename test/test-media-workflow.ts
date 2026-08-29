import { lookupMedia, cleanMediaTitle, getSeriesSeasonsAndEpisodes, getSeasonEpisodesList } from "../src/common/tmdb/client.js";
import { executeTool } from "../src/module/web/tools.js";
import { parseToolCall, KNOWN_TOOLS } from "../src/module/web/tool-parser.js";

async function runTests() {
    console.log("=================================================");
    console.log("   AUTOMATED TEST SUITE: MEDIA & TOOLS PIPELINE  ");
    console.log("=================================================\n");

    let passed = 0;
    let failed = 0;

    function assert(condition: boolean, testName: string, detail?: string) {
        if (condition) {
            console.log(`✅ [PASS] ${testName}`);
            passed++;
        } else {
            console.error(`❌ [FAIL] ${testName}${detail ? ` - ${detail}` : ""}`);
            failed++;
        }
    }

    // ─── TEST SUITE 1: TOOL PARSER ───
    console.log("--- 1. Testing Tool Parser & Known Tools ---");
    assert(KNOWN_TOOLS.includes("search_series"), "KNOWN_TOOLS includes 'search_series'");
    assert(KNOWN_TOOLS.includes("download_series"), "KNOWN_TOOLS includes 'download_series'");
    assert(KNOWN_TOOLS.includes("search_movie"), "KNOWN_TOOLS includes 'search_movie'");
    assert(KNOWN_TOOLS.includes("download_movie"), "KNOWN_TOOLS includes 'download_movie'");

    const parsedSearchSeries = parseToolCall('{"tool": "search_series", "args": {"title": "Eken Babu"}}');
    assert(parsedSearchSeries?.tool === "search_series" && parsedSearchSeries.args.title === "Eken Babu", "Parse search_series tool call");

    const parsedDownloadSeries = parseToolCall('{"tool": "download_series", "args": {"title": "Eken Babu", "seasons": [5]}}');
    assert(parsedDownloadSeries?.tool === "download_series" && parsedDownloadSeries.args.seasons[0] === 5, "Parse download_series tool call with season array");

    // ─── TEST SUITE 2: MOVIE PIPELINE (Bajrangi Bhaijaan 2015) ───
    console.log("\n--- 2. Testing Movie Pipeline: Bajrangi Bhaijaan (2015) ---");
    const movieTitleCleaned = cleanMediaTitle("Bajrangi Bhaijaan 2015 download");
    assert(movieTitleCleaned.title === "Bajrangi Bhaijaan", `Clean title extracted: "${movieTitleCleaned.title}" (expected: "Bajrangi Bhaijaan")`);
    assert(movieTitleCleaned.year === "2015", `Year extracted: "${movieTitleCleaned.year}" (expected: "2015")`);

    console.log(`[TMDB] Querying TMDB for "${movieTitleCleaned.title}" (${movieTitleCleaned.year})...`);
    const movieMeta = await lookupMedia("Bajrangi Bhaijaan 2015");
    assert(movieMeta !== null && movieMeta.found, "TMDB found Bajrangi Bhaijaan");
    assert(movieMeta?.type === "movie", `Classified as Movie: type="${movieMeta?.type}"`);
    assert(movieMeta?.year === "2015", `Release year is 2015: year="${movieMeta?.year}"`);
    assert(!!movieMeta?.overview && movieMeta.overview.length > 20, `Overview populated (${movieMeta?.overview?.slice(0, 50)}...)`);

    // ─── TEST SUITE 3: SERIES PIPELINE (Eken Babu) ───
    console.log("\n--- 3. Testing Series Pipeline: Eken Babu ---");
    const seriesTitleCleaned = cleanMediaTitle("Eken Babu Downlaod season 5");
    assert(seriesTitleCleaned.title === "Eken Babu", `Typo-tolerant clean title: "${seriesTitleCleaned.title}" (expected: "Eken Babu")`);
    assert(seriesTitleCleaned.season === 5, `Season extracted: "${seriesTitleCleaned.season}" (expected: 5)`);

    console.log(`[TMDB] Querying TMDB for Series "${seriesTitleCleaned.title}"...`);
    const seriesMeta = await lookupMedia("Eken Babu");
    assert(seriesMeta !== null && seriesMeta.found, "TMDB found Eken Babu");
    assert(seriesMeta?.type === "series", `Classified as Series: type="${seriesMeta?.type}"`);
    assert(seriesMeta?.totalSeasons === 9, `Total seasons is 9: totalSeasons=${seriesMeta?.totalSeasons}`);
    assert(seriesMeta?.totalEpisodes === 60, `Total episodes is 60: totalEpisodes=${seriesMeta?.totalEpisodes}`);

    const seriesSeasonsInfo = await getSeriesSeasonsAndEpisodes("Eken Babu");
    assert(seriesSeasonsInfo.found, "getSeriesSeasonsAndEpisodes succeeded");
    assert(seriesSeasonsInfo.totalSeasons === 9, `Total seasons count verified: ${seriesSeasonsInfo.totalSeasons}`);
    const expectedEpisodes = [10, 6, 5, 6, 6, 6, 7, 7, 7];
    assert(
        JSON.stringify(seriesSeasonsInfo.episodesPerSeason) === JSON.stringify(expectedEpisodes),
        `Exact per-season episode breakdown matches [${expectedEpisodes.join(", ")}]: actual=[${seriesSeasonsInfo.episodesPerSeason.join(", ")}]`
    );

    // ─── TEST SUITE 4: TOOL EXECUTION - search_series (Step 1 TMDB Presentation) ───
    console.log("\n--- 4. Testing toolSearchSeries (Step 1 Presentation) ---");
    const searchSeriesRes = await executeTool("search_series", { title: "Eken Babu" }, "test_session_123");
    assert(searchSeriesRes.success, "search_series executed successfully");
    assert(searchSeriesRes.data?.step === "tmdb_presentation", "Returns step: 'tmdb_presentation' without querying Telegram");
    assert(searchSeriesRes.data?.totalSeasons === 9, "search_series returns 9 seasons in data payload");
    assert(searchSeriesRes.data?.totalEpisodes === 60, "search_series returns 60 episodes in data payload");
    assert(searchSeriesRes.data?.seasons.length === 9, "search_series returns all 9 season objects with per-season episode counts");

    // ─── TEST SUITE 5: EPISODE QUERY GENERATION (SXXEXX Strict Format) ───
    console.log("\n--- 5. Testing SXXEXX Episode Tag Query Generation ---");
    function generateEpisodeQueries(seriesTitle: string, targetSeasons: number[], epsPerSeason: number[]) {
        const queries: string[] = [];
        for (const s of targetSeasons) {
            const count = epsPerSeason[s - 1] || 10;
            for (let e = 1; e <= count; e++) {
                queries.push(`${seriesTitle} S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`);
            }
        }
        return queries;
    }

    const s1Queries = generateEpisodeQueries("Eken Babu", [1], expectedEpisodes);
    assert(s1Queries.length === 10, `Season 1 generated 10 queries (S01E01..S01E10)`);
    assert(s1Queries[0] === "Eken Babu S01E01", `First query is "Eken Babu S01E01"`);
    assert(s1Queries[9] === "Eken Babu S01E10", `Tenth query is "Eken Babu S01E10"`);

    const s5Queries = generateEpisodeQueries("Eken Babu", [5], expectedEpisodes);
    assert(s5Queries.length === 6, `Season 5 generated 6 queries (S05E01..S05E06)`);
    assert(s5Queries[0] === "Eken Babu S05E01", `First S5 query is "Eken Babu S05E01"`);
    assert(s5Queries[5] === "Eken Babu S05E06", `Last S5 query is "Eken Babu S05E06"`);

    const multiSeasonQueries = generateEpisodeQueries("Eken Babu", [6, 7, 8, 9], expectedEpisodes);
    const expectedMultiCount = 6 + 7 + 7 + 7; // 27 episodes
    assert(multiSeasonQueries.length === expectedMultiCount, `Seasons [6, 7, 8, 9] generated ${expectedMultiCount} queries`);
    assert(multiSeasonQueries[0] === "Eken Babu S06E01", `First query is "Eken Babu S06E01"`);
    assert(multiSeasonQueries[multiSeasonQueries.length - 1] === "Eken Babu S09E07", `Last query is "Eken Babu S09E07"`);

    // ─── SUMMARY ───
    console.log("\n=================================================");
    console.log(`   TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("=================================================");

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runTests().catch(err => {
    console.error("Test error:", err);
    process.exit(1);
});

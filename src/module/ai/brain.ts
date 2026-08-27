import { getHarness } from "../../../command/harness.js";

interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}

export async function webSearch(query: string): Promise<WebSearchResult[]> {
    const harness = getHarness();
    harness.logActivity(`[WEB] Searching: ${query}`);

    try {
        // Use DuckDuckGo lite for simple web search
        const encodedQuery = encodeURIComponent(query);
        const response = await fetch(
            `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`,
            {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                },
            }
        );

        const html = await response.text();
        const results: WebSearchResult[] = [];

        // Simple HTML parsing for search results
        const linkRegex = /<a[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([^<]+)<\/a>/gi;
        const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

        let match;
        while ((match = linkRegex.exec(html)) !== null) {
            results.push({
                url: match[1],
                title: match[2].trim(),
                snippet: "",
            });
        }

        let snippetIdx = 0;
        while ((match = snippetRegex.exec(html)) !== null && snippetIdx < results.length) {
            results[snippetIdx].snippet = match[1].replace(/<[^>]+>/g, "").trim();
            snippetIdx++;
        }

        harness.logActivity(`[WEB] Found ${results.length} results`);
        return results.slice(0, 5);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        harness.logError(`[WEB] Search failed: ${errMsg}`);
        return [];
    }
}

export async function isMovieOrSeries(
    title: string
): Promise<{ type: "movie" | "series"; confidence: number }> {
    const harness = getHarness();

    const results = await webSearch(`${title} movie or series`);

    const allText = results.map((r) => r.title + " " + r.snippet).join(" ").toLowerCase();

    const seriesKeywords = ["series", "tv show", "season", "episode", "netflix series", "web series"];
    const movieKeywords = ["movie", "film", "cinema", "theatrical"];

    let seriesScore = 0;
    let movieScore = 0;

    for (const kw of seriesKeywords) {
        if (allText.includes(kw)) seriesScore++;
    }
    for (const kw of movieKeywords) {
        if (allText.includes(kw)) movieScore++;
    }

    const type = seriesScore > movieScore ? "series" : "movie";
    const confidence =
        Math.max(seriesScore, movieScore) /
        Math.max(seriesScore + movieScore, 1);

    harness.logActivity(
        `[AI] "${title}" determined as ${type} (confidence: ${(confidence * 100).toFixed(0)}%)`
    );

    return { type, confidence };
}

export async function getSeriesInfo(
    title: string
): Promise<{ seasons: number; episodesPerSeason: number[] }> {
    const harness = getHarness();
    harness.logActivity(`[WEB] Getting series info for: ${title}`);

    const results = await webSearch(`${title} tv series number of seasons episodes`);

    const allText = results.map((r) => r.title + " " + r.snippet).join(" ");

    const seasonMatch = allText.match(/(\d+)\s*season/i);
    const seasons = seasonMatch ? parseInt(seasonMatch[1]) : 1;

    // Default estimate if we can't find exact info
    const episodesPerSeason = Array(seasons).fill(10);

    harness.logActivity(
        `[AI] Series "${title}": ${seasons} seasons, ~10 episodes each`
    );

    return { seasons, episodesPerSeason };
}

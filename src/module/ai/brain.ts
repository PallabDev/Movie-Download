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

export async function getEpisodeDetails(
    title: string,
    season: number
): Promise<{ episode: number; title: string }[]> {
    const harness = getHarness();
    const seasonStr = String(season).padStart(2, "0");
    harness.logActivity(`[WEB] Getting S${seasonStr} episodes for: ${title}`);

    try {
        const results = await webSearch(`${title} season ${season} episode list`);
        const allText = results.map((r) => r.title + " " + r.snippet).join(" ");

        // Try to extract episode numbers and titles
        const episodes: { episode: number; title: string }[] = [];
        const epRegex = /(?:e(?:p(?:isode)?)?[\s.]?)(\d+)[\s:.\-]+([^\n,;]+)/gi;
        let match;
        while ((match = epRegex.exec(allText)) !== null) {
            const ep = parseInt(match[1]);
            if (ep > 0 && ep <= 50 && !episodes.find(e => e.episode === ep)) {
                episodes.push({ episode: ep, title: match[2].trim().substring(0, 60) });
            }
        }

        // Sort by episode number
        episodes.sort((a, b) => a.episode - b.episode);

        if (episodes.length === 0) {
            // Fallback: assume 10 episodes
            for (let i = 1; i <= 10; i++) {
                episodes.push({ episode: i, title: `Episode ${i}` });
            }
        }

        harness.logActivity(`[AI] S${seasonStr}: Found ${episodes.length} episodes`);
        return episodes;
    } catch {
        // Fallback
        const eps = [];
        for (let i = 1; i <= 10; i++) {
            eps.push({ episode: i, title: `Episode ${i}` });
        }
        return eps;
    }
}

export async function pickBestResult(
    title: string,
    type: "movie" | "series",
    results: { text: string; sizeMB: number }[]
): Promise<{ index: number; reason: string }> {
    const harness = getHarness();
    if (results.length === 0) return { index: -1, reason: "No results" };
    if (results.length === 1) return { index: 0, reason: "Only result" };

    // Score each result
    let bestIdx = 0;
    let bestScore = -1;
    let bestReason = "";

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const lower = r.text.toLowerCase();
        let score = 0;
        let reasons: string[] = [];

        // 720p preferred
        if (lower.includes("720p")) { score += 10; reasons.push("720p"); }
        else if (lower.includes("1080p")) { score += 5; reasons.push("1080p"); }
        else if (lower.includes("480p")) { score += 2; }

        // Size check: movie 600MB-1.9GB, episode 50MB-1GB
        if (type === "movie") {
            if (r.sizeMB >= 600 && r.sizeMB <= 1900) { score += 8; reasons.push("good size"); }
            else if (r.sizeMB >= 400 && r.sizeMB <= 2500) { score += 4; }
        } else {
            if (r.sizeMB >= 50 && r.sizeMB <= 1000) { score += 8; reasons.push("good size"); }
        }

        // Prefer mp4/mkv
        if (lower.includes(".mp4") || lower.includes(".mkv")) { score += 3; reasons.push("good format"); }

        // Penalize subtitles-only
        if (lower.includes("srt") || lower.includes("sub") || lower.includes("subtitle")) { score -= 10; }

        // Penalize sample
        if (lower.includes("sample")) { score -= 5; }

        // Prefer results with the title in them
        const titleWords = title.toLowerCase().split(/\s+/);
        const matchCount = titleWords.filter(w => lower.includes(w)).length;
        score += matchCount * 2;
        if (matchCount === titleWords.length) reasons.push("title match");

        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
            bestReason = reasons.join(", ") || "highest score";
        }
    }

    harness.logActivity(
        `[AI] Best result for "${title}": #${bestIdx + 1} "${results[bestIdx].text.substring(0, 50)}" (${bestReason})`
    );

    return { index: bestIdx, reason: bestReason };
}

export function groupByEpisode(
    results: { text: string; sizeMB: number }[]
): { season: number; episode: number; text: string; sizeMB: number; label: string }[] {
    // Extract S01E01 style episode tags from results
    const epRegex = /\[?S(\d+)E(\d+)\]?/i;
    const grouped = new Map<string, { season: number; episode: number; text: string; sizeMB: number; label: string }>();

    for (const r of results) {
        const match = r.text.match(epRegex);
        if (!match) continue;

        const season = parseInt(match[1]);
        const episode = parseInt(match[2]);
        const key = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

        // Keep the one with better size (closer to 700MB ideal)
        const existing = grouped.get(key);
        if (!existing || Math.abs(r.sizeMB - 700) < Math.abs(existing.sizeMB - 700)) {
            grouped.set(key, { season, episode, text: r.text, sizeMB: r.sizeMB, label: key });
        }
    }

    return Array.from(grouped.values()).sort((a, b) =>
        a.season !== b.season ? a.season - b.season : a.episode - b.episode
    );
}

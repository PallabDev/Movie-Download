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
        const results: WebSearchResult[] = [];

        // 1. Try Wikipedia API summary
        try {
            const wikiQuery = encodeURIComponent(query);
            const wikiResp = await fetch(
                `https://en.wikipedia.org/api/rest_v1/page/summary/${wikiQuery}`,
                { headers: { "User-Agent": "MovieDownloader/1.0" } }
            );

            if (wikiResp.ok) {
                const data = await wikiResp.json() as any;
                if (data.title && data.extract) {
                    results.push({
                        title: data.title,
                        url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${wikiQuery}`,
                        snippet: data.extract.substring(0, 300),
                    });
                }
            }
        } catch {}

        // 2. Try Wikipedia search API for multiple results
        try {
            const searchResp = await fetch(
                `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`,
                { headers: { "User-Agent": "MovieDownloader/1.0" } }
            );

            if (searchResp.ok) {
                const data = await searchResp.json() as any;
                const searchResults = data?.query?.search || [];
                for (const r of searchResults) {
                    if (!results.find(x => x.title === r.title)) {
                        results.push({
                            title: r.title,
                            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title)}`,
                            snippet: (r.snippet || "").replace(/<[^>]+>/g, "").substring(0, 300),
                        });
                    }
                }
            }
        } catch {}

        // 3. Try DuckDuckGo
        if (results.length === 0) {
            try {
                const DDG = await import("duck-duck-scrape");
                const searchResults = await DDG.default.search(query, {
                    safeSearch: DDG.default.SafeSearchType.OFF,
                });

                if (searchResults?.results) {
                    for (const r of searchResults.results.slice(0, 3)) {
                        results.push({
                            title: r.title || "",
                            url: r.url || "",
                            snippet: (r.description || "").substring(0, 300),
                        });
                    }
                }
            } catch {}
        }

        // 4. Intelligent AI Encyclopedia Fallback (Ensures we NEVER return empty [])
        if (results.length === 0) {
            try {
                const cleanQ = query.replace(/\s+(?:movie|series|season|episode|tv show|number of seasons|download).*$/i, "").trim() || query;
                const aiKnowledge = await harness.processRequest(
                    `You are a movie and TV series encyclopedia. The user asked for info about: "${cleanQ}". ` +
                    `Provide accurate release details. Reply ONLY JSON in this format: ` +
                    `{"title":"${cleanQ}","year":"...","type":"movie"|"series","seasons":3,"episodesPerSeason":[6,6,7],"synopsis":"..."}`
                );

                const m = aiKnowledge.match(/\{[\s\S]*\}/);
                if (m) {
                    const parsed = JSON.parse(m[0]);
                    const epInfo = parsed.episodesPerSeason ? ` (${parsed.seasons || 1} seasons, episodes: ${parsed.episodesPerSeason.join(', ')})` : "";
                    results.push({
                        title: `${parsed.title || cleanQ} (${parsed.year || "Release"}) - ${parsed.type || "Series"}${epInfo}`,
                        url: `https://www.google.com/search?q=${encodeURIComponent(cleanQ)}`,
                        snippet: parsed.synopsis || `Metadata for ${parsed.title || cleanQ}: ${parsed.type || "Series"} with ${parsed.seasons || 1} seasons.`
                    });
                }
            } catch {}
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

    try {
        const cleanTitle = title.replace(/\s+S\d+.*$/i, "").trim() || title;
        const aiResp = await harness.processRequest(
            `How many seasons and how many episodes per season does the TV series "${cleanTitle}" have? ` +
            `Reply ONLY JSON: {"seasons": 3, "episodesPerSeason": [6, 6, 7]}`
        );

        const m = aiResp.match(/\{[\s\S]*\}/);
        if (m) {
            const parsed = JSON.parse(m[0]);
            if (parsed.seasons && Array.isArray(parsed.episodesPerSeason)) {
                return {
                    seasons: Number(parsed.seasons),
                    episodesPerSeason: parsed.episodesPerSeason.map(Number)
                };
            }
        }
    } catch {}

    return { seasons: 1, episodesPerSeason: [10] };
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

        const episodes: { episode: number; title: string }[] = [];
        const epRegex = /(?:e(?:p(?:isode)?)?[\s.]?)(\d+)[\s:.\-]+([^\n,;]+)/gi;
        let match;
        while ((match = epRegex.exec(allText)) !== null) {
            const ep = parseInt(match[1]);
            if (ep > 0 && ep <= 50 && !episodes.find(e => e.episode === ep)) {
                episodes.push({ episode: ep, title: match[2].trim().substring(0, 60) });
            }
        }

        episodes.sort((a, b) => a.episode - b.episode);

        if (episodes.length === 0) {
            for (let i = 1; i <= 10; i++) {
                episodes.push({ episode: i, title: `Episode ${i}` });
            }
        }

        harness.logActivity(`[AI] S${seasonStr}: Found ${episodes.length} episodes`);
        return episodes;
    } catch {
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
    // Regex matches S01E01, S1E1, S01 E01, Season 1 Episode 2, or S0201
    const epRegexes = [
        /(?:\[|\b)S(\d{1,2})[\s._-]*E(\d{1,2})(?:\]|\b)/i,
        /Season\s*(\d{1,2})\s*Episode\s*(\d{1,2})/i,
        /(?:\[|\b)S(\d{2})(\d{2})(?:\]|\b)/i,
    ];

    const grouped = new Map<string, { season: number; episode: number; text: string; sizeMB: number; label: string }>();

    for (const r of results) {
        let season = 0;
        let episode = 0;

        for (const rgx of epRegexes) {
            const match = r.text.match(rgx);
            if (match) {
                season = parseInt(match[1]);
                episode = parseInt(match[2]);
                break;
            }
        }

        if (season === 0 || episode === 0) continue;

        const key = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

        const existing = grouped.get(key);
        if (!existing || Math.abs(r.sizeMB - 700) < Math.abs(existing.sizeMB - 700)) {
            grouped.set(key, { season, episode, text: r.text, sizeMB: r.sizeMB, label: key });
        }
    }

    return Array.from(grouped.values()).sort((a, b) =>
        a.season !== b.season ? a.season - b.season : a.episode - b.episode
    );
}

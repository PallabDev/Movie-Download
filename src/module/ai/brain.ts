import { getHarness } from "../../../command/harness.js";
import {
    lookupMedia,
    getSeriesSeasonsAndEpisodes,
    getSeasonEpisodesList,
    searchMulti,
    searchMovie,
    searchTV,
    searchCollection,
    getCollectionDetails,
    getTMDBImageUrl
} from "../../common/tmdb/client.js";

function safeHarness() {
    try {
        return getHarness();
    } catch {
        return {
            logActivity: (msg: string) => console.log(msg),
            logError: (msg: string) => console.error(msg),
        } as any;
    }
}

interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}

export async function webSearch(query: string): Promise<WebSearchResult[]> {
    const harness = safeHarness();
    harness.logActivity(`[WEB] Searching: ${query}`);

    try {
        const results: WebSearchResult[] = [];

        // 1. Primary Source: TMDB API (Accurate releases, seasons, episodes, collections)
        try {
            const tmdb = await lookupMedia(query);
            if (tmdb && tmdb.found) {
                if (tmdb.type === "series") {
                    const epBreakdown = tmdb.seasons && tmdb.seasons.length > 0
                        ? tmdb.seasons.map(s => `${s.name}: ${s.episodeCount} eps`).join(" | ")
                        : `Episodes per season: ${tmdb.episodesPerSeason?.join(", ")}`;

                    results.push({
                        title: `${tmdb.title} (${tmdb.year || "Series"}) - TV Series [${tmdb.totalSeasons || tmdb.seasons?.length} Seasons, ${tmdb.totalEpisodes} Episodes]`,
                        url: `https://www.themoviedb.org/tv/${tmdb.id}`,
                        snippet: `${tmdb.overview || "Overview unavailable."} Genres: ${tmdb.genres.join(", ") || "Drama"}. Cast: ${tmdb.cast.join(", ")}. Status: ${tmdb.status || "Released"}. Seasons Breakdown: ${epBreakdown}.`,
                    });

                    // Add individual season records so search results provide deep per-season context
                    if (tmdb.seasons && tmdb.seasons.length > 0) {
                        for (const s of tmdb.seasons.slice(0, 5)) {
                            results.push({
                                title: `${tmdb.title} - ${s.name} (${s.episodeCount} Episodes${s.airDate ? `, Air date: ${s.airDate}` : ""})`,
                                url: `https://www.themoviedb.org/tv/${tmdb.id}/season/${s.seasonNumber}`,
                                snippet: s.overview || `${s.name} of ${tmdb.title} containing ${s.episodeCount} full episodes.`,
                            });
                        }
                    }
                } else {
                    // Movie / Franchise
                    let collectionInfo = "";
                    if (tmdb.collection && tmdb.collection.parts && tmdb.collection.parts.length > 0) {
                        const partsList = tmdb.collection.parts
                            .map((p, idx) => `#${idx + 1} "${p.title}" (${p.year || "Release"})`)
                            .join("; ");
                        collectionInfo = ` Franchise Parts (${tmdb.collection.partsCount} parts): ${partsList}.`;

                        // Add collection overview
                        results.push({
                            title: `${tmdb.collection.name} Franchise (${tmdb.collection.partsCount} Movies)`,
                            url: `https://www.themoviedb.org/collection/${tmdb.collection.id}`,
                            snippet: `Franchise includes ${tmdb.collection.partsCount} released parts: ${partsList}. Directed by: ${tmdb.directors.join(", ") || "Director"}. Cast: ${tmdb.cast.join(", ")}.`,
                        });
                    }

                    results.push({
                        title: `${tmdb.title} (${tmdb.year || "Movie"}) - Film [Runtime: ${tmdb.runtime || 120}m, Rating: ${tmdb.rating ? tmdb.rating.toFixed(1) : "7.5"}/10]`,
                        url: `https://www.themoviedb.org/movie/${tmdb.id}`,
                        snippet: `${tmdb.overview || "Synopsis."} Directed by: ${tmdb.directors.join(", ") || "Director"}. Stars: ${tmdb.cast.join(", ")}. Genres: ${tmdb.genres.join(", ")}.${collectionInfo}`,
                    });
                }
            }
        } catch (tmdbErr: any) {
            harness.logActivity(`[TMDB] Query error in webSearch: ${tmdbErr.message}`);
        }

        // 2. Wikipedia API summary fallback / supplement if results are empty
        if (results.length === 0) {
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
        }

        // 3. Wikipedia search API for multiple results
        if (results.length === 0) {
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
        }

        // 4. DuckDuckGo Search Fallback
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

        // 5. Intelligent AI Encyclopedia Fallback (Ensures we NEVER return empty [])
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
        return results.slice(0, 6);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        harness.logError(`[WEB] Search failed: ${errMsg}`);
        return [];
    }
}

export async function isMovieOrSeries(
    title: string
): Promise<{ type: "movie" | "series"; confidence: number }> {
    const harness = safeHarness();

    // 1. Check TMDB directly
    try {
        const tmdb = await lookupMedia(title);
        if (tmdb && tmdb.found) {
            harness.logActivity(`[AI] "${title}" determined as ${tmdb.type} via TMDB (confidence: 100%)`);
            return { type: tmdb.type, confidence: 1.0 };
        }
    } catch {}

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
): Promise<{ seasons: number; episodesPerSeason: number[]; seasonsDetails?: any[] }> {
    const harness = safeHarness();
    harness.logActivity(`[TMDB/WEB] Getting series info for: ${title}`);

    try {
        const tmdb = await getSeriesSeasonsAndEpisodes(title);
        if (tmdb && tmdb.found && tmdb.totalSeasons > 0) {
            harness.logActivity(`[TMDB] "${tmdb.title}": ${tmdb.totalSeasons} seasons, episodes: [${tmdb.episodesPerSeason.join(", ")}]`);
            return {
                seasons: tmdb.totalSeasons,
                episodesPerSeason: tmdb.episodesPerSeason,
                seasonsDetails: tmdb.seasons,
            };
        }
    } catch (e: any) {
        harness.logActivity(`[TMDB] getSeriesInfo fallback: ${e.message}`);
    }

    // Fallback to AI processRequest if TMDB did not have data
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
): Promise<{ episode: number; title: string; airDate?: string; overview?: string }[]> {
    const harness = safeHarness();
    const seasonStr = String(season).padStart(2, "0");
    harness.logActivity(`[TMDB/WEB] Getting S${seasonStr} episodes for: ${title}`);

    try {
        const tmdb = await getSeasonEpisodesList(title, season);
        if (tmdb && tmdb.found && tmdb.episodes.length > 0) {
            harness.logActivity(`[TMDB] S${seasonStr}: Found ${tmdb.episodes.length} verified episodes`);
            return tmdb.episodes.map(e => ({
                episode: e.episodeNumber,
                title: e.name,
                airDate: e.airDate,
                overview: e.overview,
            }));
        }
    } catch (e: any) {
        harness.logActivity(`[TMDB] getEpisodeDetails fallback: ${e.message}`);
    }

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

export function detectReleaseLanguage(text: string): {
    isHindi: boolean;
    isBengali: boolean;
    isEnglish: boolean;
    isDualOrMulti: boolean;
    isDisallowedLanguage: boolean;
    language: string;
} {
    const lower = text.toLowerCase();

    // 1. Explicit Hindi patterns
    const isExplicitHindi = /\b(hindi|hin|hindi-dubbed|dubbed\s*in\s*hindi|hindi\s*dub|hindi\s*clean|clean\s*hindi|org\s*hindi|hindi\s*org|dd5\.1\s*hindi|hindi\s*dd5\.1|hq\s*hindi|hindi\s*hq)\b/i.test(lower) ||
        /\[(?:hin|hindi)[-+_\s/][^\]]+\]/i.test(lower) ||
        /\[[^\]]+[-+_\s/](?:hin|hindi)\]/i.test(lower) ||
        /\b(hin-eng|eng-hin|hin-tam|tam-hin|hin-tel|tel-hin|hin-kan|kan-hin|hin-ben|ben-hin|hin-mal|mal-hin)\b/i.test(lower);

    // 2. Explicit Bengali / Bangla patterns
    const isExplicitBengali = /\b(bengali|bangla|ben|beng)\b/i.test(lower) ||
        /\[(?:ben|bengali|bangla)[-+_\s/][^\]]+\]/i.test(lower) ||
        /\[[^\]]+[-+_\s/](?:ben|bengali|bangla)\]/i.test(lower) ||
        /\b(ben-eng|eng-ben|hin-ben|ben-hin)\b/i.test(lower);

    // 3. Explicit English patterns
    const isExplicitEnglish = /\b(english|eng)\b/i.test(lower) ||
        /\[(?:eng|english)[-+_\s/][^\]]+\]/i.test(lower) ||
        /\[[^\]]+[-+_\s/](?:eng|english)\]/i.test(lower);

    // 4. Dual / Multi Audio patterns (In Indian Telegram release naming, DUAL/Multi almost always includes Hindi/Bengali/English)
    const isDualOrMulti = /\b(dual|dual-audio|dual\s*audio|multi|multi-audio|multi\s*audio|tri-audio|tri\s*audio|quad-audio)\b/i.test(lower) ||
        /\[(?:dual|multi)[^\]]*\]/i.test(lower);

    // 5. Other regional or foreign single languages (without Hindi/Bengali/English/Dual)
    const isMalayalam = /\b(malayalam|malay|mal)\b/i.test(lower);
    const isTelugu = /\b(telugu|tel)\b/i.test(lower);
    const isTamil = /\b(tamil|tam)\b/i.test(lower);
    const isKannada = /\b(kannada|kan)\b/i.test(lower);
    const isPunjabi = /\b(punjabi|panjabi)\b/i.test(lower);
    const isMarathi = /\b(marathi|mar)\b/i.test(lower);
    const isGujarati = /\b(gujarati|guj)\b/i.test(lower);
    const isOdia = /\b(odia|oriya)\b/i.test(lower);
    const isBhojpuri = /\b(bhojpuri|bhoj)\b/i.test(lower);
    const isKorean = /\b(korean|kor)\b/i.test(lower);
    const isJapanese = /\b(japanese|jap)\b/i.test(lower);
    const isChinese = /\b(chinese|chi)\b/i.test(lower);
    const isSpanish = /\b(spanish|spa)\b/i.test(lower);
    const isFrench = /\b(french|fre)\b/i.test(lower);
    const isRussian = /\b(russian|rus)\b/i.test(lower);
    const isGerman = /\b(german|ger)\b/i.test(lower);
    const isItalian = /\b(italian|ita)\b/i.test(lower);
    const isThai = /\b(thai)\b/i.test(lower);
    const isTurkish = /\b(turkish|turk)\b/i.test(lower);

    let otherLangName = "";
    if (isMalayalam) otherLangName = "Malayalam";
    else if (isTelugu) otherLangName = "Telugu";
    else if (isTamil) otherLangName = "Tamil";
    else if (isKannada) otherLangName = "Kannada";
    else if (isPunjabi) otherLangName = "Punjabi";
    else if (isMarathi) otherLangName = "Marathi";
    else if (isGujarati) otherLangName = "Gujarati";
    else if (isOdia) otherLangName = "Odia";
    else if (isBhojpuri) otherLangName = "Bhojpuri";
    else if (isKorean) otherLangName = "Korean";
    else if (isJapanese) otherLangName = "Japanese";
    else if (isChinese) otherLangName = "Chinese";
    else if (isSpanish) otherLangName = "Spanish";
    else if (isFrench) otherLangName = "French";
    else if (isRussian) otherLangName = "Russian";
    else if (isGerman) otherLangName = "German";
    else if (isItalian) otherLangName = "Italian";
    else if (isThai) otherLangName = "Thai";
    else if (isTurkish) otherLangName = "Turkish";

    const isDisallowedLanguage = Boolean(otherLangName) && !isExplicitHindi && !isExplicitBengali && !isExplicitEnglish && !isDualOrMulti;

    let language = "Original / English";
    if (isExplicitHindi) language = "Hindi";
    else if (isExplicitBengali) language = "Bengali";
    else if (isExplicitEnglish) language = "English";
    else if (isDualOrMulti) language = "Dual Audio";
    else if (otherLangName) language = otherLangName;

    return {
        isHindi: isExplicitHindi,
        isBengali: isExplicitBengali,
        isEnglish: isExplicitEnglish,
        isDualOrMulti,
        isDisallowedLanguage,
        language
    };
}

export function isAllowedDownloadLanguage(text: string): {
    allowed: boolean;
    detectedLanguage: string;
    reason?: string;
} {
    const langInfo = detectReleaseLanguage(text);

    // If it has Hindi, Bengali, English, or Dual/Multi Audio -> ALLOWED
    if (langInfo.isHindi || langInfo.isBengali || langInfo.isEnglish || langInfo.isDualOrMulti) {
        return { allowed: true, detectedLanguage: langInfo.language };
    }

    // If it has an explicit disallowed language (e.g. Malayalam, Telugu, Tamil, etc.)
    if (langInfo.isDisallowedLanguage) {
        return {
            allowed: false,
            detectedLanguage: langInfo.language,
            reason: `⚠️ You can't download this movie release. Only **Hindi**, **Bengali**, and **English** (or Dual/Multi Audio) languages are supported. The selected release is in **${langInfo.language}**.`
        };
    }

    // Standard English/original release
    return { allowed: true, detectedLanguage: "English / Original" };
}

export function checkResolutionHarnessRule(text: string): {
    isHighRes: boolean;
    resolution: string;
    warningMessage?: string;
} {
    const lower = text.toLowerCase();
    let res = "";
    if (lower.includes("2160p") || lower.includes("4k") || lower.includes("uhd")) {
        res = "4K UHD";
    } else if (lower.includes("1080p") || lower.includes("fhd")) {
        res = "1080p FHD";
    }

    if (res) {
        return {
            isHighRes: true,
            resolution: res,
            warningMessage: `⚠️ **Warning: High Resolution (${res}) Download Detected!**\n> ⚠️ *Downloading releases higher than 720p multiple times puts heavy load on the server and bandwidth. Doing this multiple times can result in your account being banned.*`
        };
    }

    return { isHighRes: false, resolution: "720p or standard" };
}

export async function pickBestResult(
    title: string,
    type: "movie" | "series",
    results: { text: string; sizeMB: number }[]
): Promise<{ index: number; reason: string }> {
    const harness = safeHarness();
    if (results.length === 0) return { index: -1, reason: "No results" };
    if (results.length === 1) return { index: 0, reason: "Only result" };

    let bestIdx = 0;
    let bestScore = -99999;
    let bestReason = "";

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const lower = r.text.toLowerCase();
        let score = 0;
        let reasons: string[] = [];

        // ── 1. Language Priority (TOP PRIORITY: HINDI / BENGALI / ENGLISH FIRST) ──
        const langInfo = detectReleaseLanguage(r.text);
        if (langInfo.isHindi) {
            score += 220;
            reasons.push("Hindi Audio");
        } else if (langInfo.isBengali) {
            score += 210;
            reasons.push("Bengali Audio");
        } else if (langInfo.isDualOrMulti) {
            score += 180;
            reasons.push("Dual Audio (Hindi/Ben/Eng)");
        } else if (langInfo.isDisallowedLanguage) {
            // Disallowed regional/foreign language (Malayalam, Telugu, Tamil, etc.) -> heavily penalize
            score -= 1000;
        } else {
            // Standard English/original release
            score += 15;
        }

        // ── 2. Resolution & Efficiency (720p IS TOP PRIORITY) ──
        if (lower.includes("720p")) {
            score += 65;
            reasons.push("720p HD (Optimal Quality)");
            if (lower.includes("265") || lower.includes("hevc")) {
                score += 20;
                reasons.push("H.265 efficient");
            }
        } else if (lower.includes("1080p")) {
            score += 25;
            reasons.push("1080p FHD");
            if (lower.includes("265") || lower.includes("hevc")) {
                score += 10;
                reasons.push("H.265");
            }
        } else if (lower.includes("480p")) {
            score += 15;
            reasons.push("480p SD");
        } else if (lower.includes("2160p") || lower.includes("4k")) {
            score += 5;
            reasons.push("4K UHD");
        }

        // ── 3. Size Check ──
        if (type === "movie") {
            if (r.sizeMB >= 700 && r.sizeMB <= 3500) {
                score += 15;
                reasons.push("optimal size");
            } else if (r.sizeMB > 3500 && r.sizeMB <= 6000) {
                score += 8;
            } else if (r.sizeMB >= 400 && r.sizeMB < 700) {
                score += 5;
            }
        } else {
            if (r.sizeMB >= 150 && r.sizeMB <= 1500) {
                score += 10;
                reasons.push("good size");
            }
        }

        // ── 4. Container / Codec ──
        if (lower.includes(".mkv") || lower.includes(".mp4")) {
            score += 5;
        }

        // ── 5. Quality Penalties ──
        if (lower.includes("sample")) score -= 100;
        if (lower.includes("srt") || lower.includes("sub") || lower.includes("subtitle")) score -= 100;
        if (lower.includes("camrip") || lower.includes("hdcam") || lower.includes("telesync") || lower.includes("predvd")) score -= 150;

        // ── 6. Title Match ──
        const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 1);
        const matchCount = titleWords.filter(w => lower.includes(w)).length;
        score += matchCount * 5;
        if (matchCount === titleWords.length) reasons.push("title match");

        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
            bestReason = reasons.join(", ") || "highest score";
        }
    }

    harness.logActivity(
        `[AI] Best result for "${title}": #${bestIdx + 1} "${results[bestIdx].text.substring(0, 50)}" (${bestReason}) [Score: ${bestScore}]`
    );

    return { index: bestIdx, reason: bestReason };
}

export function groupByEpisode(
    results: { text: string; sizeMB: number; season?: number; episode?: number }[]
): { season: number; episode: number; text: string; sizeMB: number; label: string }[] {
    // Regex matches S01E01, S1E1, S01 E01, Season 1 Episode 2, or S0201
    const epRegexes = [
        /(?:\[|\b)S(\d{1,2})[\s._-]*E(\d{1,2})(?:\]|\b)/i,
        /Season\s*(\d{1,2})\s*Episode\s*(\d{1,2})/i,
        /(?:\[|\b)S(\d{2})(\d{2})(?:\]|\b)/i,
    ];

    const grouped = new Map<string, { season: number; episode: number; text: string; sizeMB: number; label: string }>();

    for (const r of results) {
        let season = r.season || 0;
        let episode = r.episode || 0;

        if (season === 0 || episode === 0) {
            for (const rgx of epRegexes) {
                const match = r.text.match(rgx);
                if (match) {
                    season = parseInt(match[1], 10);
                    episode = parseInt(match[2], 10);
                    break;
                }
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

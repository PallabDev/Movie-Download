import OpenAI from "openai";
import { z } from "zod";
import { env } from "../../common/utils/env.js";
import { lookupMedia, searchMovie, searchTV, searchMulti } from "../../common/tmdb/client.js";

// Resilient Zod schema for structured media metadata
export const MediaMetadataSchema = z.object({
    title: z.string().min(1).describe("Clean canonical title of the movie or series, free of codec/quality tags and empty brackets"),
    type: z.enum(["movie", "series"]).describe("'movie' or 'series'"),
    year: z.preprocess(
        (val) => {
            if (val === null || val === undefined) return "";
            const s = String(val).trim();
            const m = s.match(/\b(19\d{2}|20\d{2})\b/);
            return m ? m[1] : "";
        },
        z.string().default("")
    ),
    season: z.preprocess(
        (val) => (val === null || val === undefined || val === "" ? null : Number(val)),
        z.number().int().positive().nullable().optional()
    ),
    episode: z.preprocess(
        (val) => (val === null || val === undefined || val === "" ? null : Number(val)),
        z.number().int().positive().nullable().optional()
    ),
    isBatch: z.preprocess(
        (val) => Boolean(val),
        z.boolean().default(false)
    ),
    tmdbId: z.preprocess(
        (val) => (val === null || val === undefined || val === "" ? null : Number(val)),
        z.number().int().positive().nullable().optional()
    )
});

export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

// In-memory cache for fast repeated lookups (TTL 30 minutes)
const metadataCache = new Map<string, { data: MediaMetadata; timestamp: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

let clientInstance: OpenAI | null = null;
function getClient(): OpenAI {
    if (!clientInstance) {
        clientInstance = new OpenAI({
            baseURL: env.AI_BASE_URL,
            apiKey: env.AI_API_KEY,
            timeout: 3500, // 3.5s strict timeout to prevent queuing delays
            maxRetries: 0
        });
    }
    return clientInstance;
}

async function safeHarnessLog(activity: string) {
    try {
        const { getHarness } = await import("../../../command/harness.js");
        getHarness()?.logActivity(activity);
    } catch {}
}

async function safeHarnessMovieInfo(entry: string) {
    try {
        const { getHarness } = await import("../../../command/harness.js");
        getHarness()?.appendMovieInfo(entry);
    } catch {}
}

/**
 * Instant regex and heuristic metadata extractor (0.001ms)
 */
export function extractHeuristicMetadata(rawTitle: string): MediaMetadata {
    const key = (rawTitle || "").trim();
    const isSeries = /season|\bS\d{1,2}\b|\bEP\s*\d{1,3}\b|episode/i.test(key);
    const seasonMatch = key.match(/season\s*(\d{1,2})|\bS(\d{1,2})\b/i);
    const epMatch = key.match(/(?:ep|episode)\s*(\d{1,3})|\bE(\d{1,3})\b/i);
    const yearMatch = key.match(/\b(19\d{2}|20\d{2})\b/);

    let clean = key;
    if (yearMatch && yearMatch.index !== undefined && yearMatch.index > 0) {
        clean = key.substring(0, yearMatch.index);
    } else {
        // Strip release tags and brackets, but preserve hyphens in titles like Spider-Man
        clean = key.split(/[\[\{\|\/]/)[0];
    }
    // Remove release format noise from clean title
    clean = clean.replace(/\b(?:4k|2160p|1080p|720p|480p|hdrip|ds4k|bluray|brrip|web[-_.\s]*dl|webrip|x264|x265|hevc|10bit|dual audio|hindi|english|org|dd5\.1|esubs?|full movie|complete)\b.*$/i, "");
    clean = clean.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    clean = clean.replace(/[\(\[\{\|\-–—:]+$/, "").trim();

    return {
        title: clean || key || "Unknown Media",
        type: isSeries ? "series" : "movie",
        year: yearMatch ? yearMatch[1] : "",
        season: seasonMatch ? parseInt(seasonMatch[1] || seasonMatch[2], 10) : (isSeries ? 1 : null),
        episode: epMatch ? parseInt(epMatch[1] || epMatch[2], 10) : null,
        isBatch: isSeries && !epMatch,
        tmdbId: null
    };
}

/**
 * Smart AI Media Naming Harness:
 * 1. AI extracts initial search query, candidate year, and media type.
 * 2. Feeds a search harness to TMDB/IMDb to locate the true canonical title and release year.
 * 3. AI or intelligent ranker selects the exact canonical match from TMDB/IMDb.
 * 4. Updates harness records and caches the result.
 */
export async function parseMediaWithAI(rawTitle: string): Promise<MediaMetadata> {
    const key = (rawTitle || "").trim();
    if (!key) {
        return {
            title: "Unknown Media",
            type: "movie",
            year: new Date().getFullYear().toString(),
            season: null,
            episode: null,
            isBatch: false,
            tmdbId: null
        };
    }

    const cached = metadataCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
    }

    const fallbackMeta = extractHeuristicMetadata(key);
    let extracted: MediaMetadata = { ...fallbackMeta };

    // Step 1: AI candidate extraction
    try {
        const client = getClient();
        const prompt = `Extract media title query, release year, media type ("movie"|"series"), season (int|null), episode (int|null), isBatch (bool) from raw release: "${key}". Output ONLY raw JSON: {"title": string, "type": "movie"|"series", "year": string, "season": number|null, "episode": number|null, "isBatch": boolean}`;

        const resp = await client.chat.completions.create({
            model: env.AI_MODEL,
            messages: [
                {
                    role: "system",
                    content: "You are an expert media title cleaner. Reply ONLY with valid JSON."
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.1,
            max_tokens: 250,
        });

        const content = resp.choices[0]?.message?.content?.trim() || "";
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = MediaMetadataSchema.parse(JSON.parse(jsonMatch[0]));
            if (parsed.title) {
                extracted = parsed;
            }
        }
    } catch (err: any) {
        console.warn(`[AI-CLEANER] Step 1 AI extraction fallback for "${key.slice(0, 40)}...": ${err?.message}`);
    }

    // Step 2 & 3: TMDB / IMDb Verification Harness
    let finalMeta: MediaMetadata = { ...extracted };
    const searchQuery = (extracted.title || fallbackMeta.title).trim();
    const searchYear = extracted.year || fallbackMeta.year;

    try {
        console.log(`[AI-HARNESS] Verifying canonical TMDB/IMDb metadata for: "${searchQuery}" (Year: ${searchYear || "any"})`);

        // 1. First attempt full smart lookupMedia
        const tmdb = await lookupMedia(searchQuery, searchYear);
        if (tmdb && tmdb.found && tmdb.title) {
            console.log(`[AI-HARNESS] TMDB resolved: "${tmdb.title}" (${tmdb.year || "unknown"}) [${tmdb.type}]`);
            finalMeta.title = tmdb.title;
            if (tmdb.year) finalMeta.year = tmdb.year;
            finalMeta.type = tmdb.type;
            if (tmdb.id) finalMeta.tmdbId = tmdb.id;
        } else {
            // 2. Direct search for candidates
            const searchResp = await (extracted.type === "series" ? searchTV(searchQuery, searchYear) : searchMovie(searchQuery, searchYear));
            const candidates = searchResp?.results || [];

            if (candidates.length > 0) {
                try {
                    const client = getClient();
                    const candidateList = candidates.slice(0, 5).map((c: any, i: number) => 
                        `${i + 1}. ID: ${c.id}, Title: "${c.title || c.name}", Year: "${(c.release_date || c.first_air_date || '').slice(0, 4)}", Type: "${c.media_type || (c.title ? 'movie' : 'tv')}", Overview: "${(c.overview || '').slice(0, 70)}"`
                    ).join("\n");

                    const matchPrompt = `Raw release: "${key}"
Candidates from TMDB/IMDb:
${candidateList}

Select the exact matching canonical movie or TV series.
Output ONLY JSON matching: {"tmdbId": number, "title": string, "year": string, "type": "movie"|"series"}`;

                    const matchResp = await client.chat.completions.create({
                        model: env.AI_MODEL,
                        messages: [
                            { role: "system", content: "You are a movie metadata verification agent. Return ONLY valid JSON." },
                            { role: "user", content: matchPrompt }
                        ],
                        temperature: 0.1,
                        max_tokens: 200,
                    });

                    const matchContent = matchResp.choices[0]?.message?.content?.trim() || "";
                    const mMatch = matchContent.match(/\{[\s\S]*\}/);
                    if (mMatch) {
                        const matched = JSON.parse(mMatch[0]);
                        if (matched.title) {
                            finalMeta.title = matched.title;
                            if (matched.year) finalMeta.year = String(matched.year).trim();
                            if (matched.type) finalMeta.type = matched.type;
                            if (matched.tmdbId) finalMeta.tmdbId = Number(matched.tmdbId);
                        }
                    }
                } catch {
                    // Fallback to top candidate if AI matcher times out
                    const top = candidates[0];
                    if (top) {
                        finalMeta.title = top.title || top.name || finalMeta.title;
                        const y = (top.release_date || top.first_air_date || "").slice(0, 4);
                        if (y) finalMeta.year = y;
                        if (top.id) finalMeta.tmdbId = top.id;
                    }
                }
            }
        }
    } catch (tmdbErr: any) {
        console.warn(`[AI-HARNESS] TMDB search error: ${tmdbErr?.message}. Retaining extracted metadata.`);
    }

    // Preserve series season and episode if detected
    if (extracted.season && !finalMeta.season) finalMeta.season = extracted.season;
    if (extracted.episode && !finalMeta.episode) finalMeta.episode = extracted.episode;
    if (extracted.isBatch) finalMeta.isBatch = extracted.isBatch;

    // Log to Harness activity and movie information
    safeHarnessLog(`[AI-HARNESS] Cleaned "${key.slice(0, 50)}" -> "${finalMeta.title} (${finalMeta.year || "N/A"})" [${finalMeta.type}]`).catch(() => {});
    if (finalMeta.title && finalMeta.title !== "Unknown Media") {
        safeHarnessMovieInfo(`- **${finalMeta.title} (${finalMeta.year || "N/A"})** [${finalMeta.type.toUpperCase()}] - Source: \`${key.slice(0, 60)}\``).catch(() => {});
    }

    metadataCache.set(key, { data: finalMeta, timestamp: Date.now() });
    return finalMeta;
}

/**
 * Format clean display title for queue job and history:
 * Movie -> "{Title} ({Year})"
 * Series -> "{Title} - S{Season}E{Episode}" or "{Title} - Season {Season} (Full Season Batch)"
 */
export function formatMediaJobTitle(meta: MediaMetadata): string {
    if (meta.type === "movie") {
        return meta.year ? `${meta.title} (${meta.year})` : meta.title;
    }

    const s = meta.season || 1;
    const seasonStr = String(s).padStart(2, "0");

    if (meta.episode !== null && meta.episode !== undefined) {
        const epStr = String(meta.episode).padStart(2, "0");
        return `${meta.title} - S${seasonStr}E${epStr}`;
    }

    return `${meta.title} - Season ${seasonStr} (Full Season Batch)`;
}

/**
 * Format clean filename for downloaded files and batch archives:
 * Movie -> "{Title} ({Year}).mkv"
 * Series -> "{Title} - S{Season}E{Episode}.mkv" or "{Title} - Season {Season} (Full Season).zip"
 */
export function formatMediaFileName(meta: MediaMetadata): string {
    const cleanTitle = meta.title.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim();
    if (meta.type === "movie") {
        return meta.year ? `${cleanTitle} (${meta.year}).mkv` : `${cleanTitle}.mkv`;
    }

    const s = meta.season || 1;
    const seasonStr = String(s).padStart(2, "0");

    if (meta.episode !== null && meta.episode !== undefined) {
        const epStr = String(meta.episode).padStart(2, "0");
        return `${cleanTitle} - S${seasonStr}E${epStr}.mkv`;
    }

    return `${cleanTitle} - Season ${seasonStr} (Full Season).zip`;
}

/**
 * Format clean folder name for media library (Jellyfin / Plex):
 * Movie -> "{Title} ({Year})"
 * Series -> "{Title} ({Year})"
 */
export function formatMediaFolderName(meta: MediaMetadata): string {
    const cleanTitle = meta.title.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim();
    if (meta.type === "movie") {
        return meta.year ? `${cleanTitle} (${meta.year})` : cleanTitle;
    }
    return meta.year ? `${cleanTitle} (${meta.year})` : cleanTitle;
}

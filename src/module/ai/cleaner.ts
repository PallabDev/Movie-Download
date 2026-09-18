import OpenAI from "openai";
import { z } from "zod";
import { env } from "../../common/utils/env.js";

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
        isBatch: isSeries && !epMatch
    };
}

/**
 * Send raw media title/filename directly to AI to extract clean title, release year,
 * media type, season, and episode details. If AI takes > 3.5s, instantly falls back to heuristics.
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
        };
    }

    const cached = metadataCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
    }

    const fallbackMeta = extractHeuristicMetadata(key);

    const client = getClient();
    const prompt = `Extract media title, release year, type ("movie"|"series"), season (int|null), episode (int|null), isBatch (bool) from: "${key}". Output ONLY raw JSON matching: {"title": string, "type": "movie"|"series", "year": string, "season": number|null, "episode": number|null, "isBatch": boolean}`;

    try {
        console.log(`[AI-CLEANER] Extracting metadata for: "${key.slice(0, 80)}..."`);
        const resp = await client.chat.completions.create({
            model: env.AI_MODEL,
            messages: [
                {
                    role: "system",
                    content: "You are an expert media metadata identification engine. You reply ONLY with valid JSON."
                },
                { role: "user", content: prompt }
            ],
            temperature: 0.1,
            max_tokens: 300,
        });

        const content = resp.choices[0]?.message?.content?.trim() || "";
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = MediaMetadataSchema.parse(JSON.parse(jsonMatch[0]));
            console.log(`[AI-CLEANER] Successfully parsed:`, parsed);
            metadataCache.set(key, { data: parsed, timestamp: Date.now() });
            return parsed;
        }
    } catch (err: any) {
        console.warn(`[AI-CLEANER] Fast AI timeout or skip for "${key.slice(0, 40)}...": ${err?.message}. Using instant heuristic.`);
    }

    metadataCache.set(key, { data: fallbackMeta, timestamp: Date.now() });
    return fallbackMeta;
}

/**
 * Format clean display title for queue job and history
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
 * Format clean filename for downloaded files and batch archives
 */
export function formatMediaFileName(meta: MediaMetadata): string {
    if (meta.type === "movie") {
        return meta.year ? `${meta.title} (${meta.year}).mkv` : `${meta.title}.mkv`;
    }

    const s = meta.season || 1;
    const seasonStr = String(s).padStart(2, "0");

    if (meta.episode !== null && meta.episode !== undefined) {
        const epStr = String(meta.episode).padStart(2, "0");
        return `${meta.title} - S${seasonStr}E${epStr}.mkv`;
    }

    return `${meta.title} - Season ${seasonStr} (Full Season).zip`;
}

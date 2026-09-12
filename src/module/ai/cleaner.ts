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
        });
    }
    return clientInstance;
}

/**
 * Send raw media title/filename directly to AI to extract clean title, release year,
 * media type, season, and episode details without manual regex breaking points.
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

    const client = getClient();
    const prompt = `You are a media metadata extraction engine.
Given the messy release name, torrent title, post title, or filename below:
"${key}"

Analyze the text and identify:
1. "title": Clean canonical title of the movie or TV show. Remove all codec, audio tags, website names, and empty brackets "( )".
2. "type": "movie" or "series".
3. "year": Exact 4-digit original release year. Look up the true release year in your knowledge base or extract from the title.
4. "season": Integer season number if TV series, or null if movie.
5. "episode": Integer episode number if single episode, or null if full season batch or movie.
6. "isBatch": True if it represents a full season pack / all episodes / batch.

You must respond ONLY with a raw JSON object matching this schema:
{
  "title": "Clean Title",
  "type": "movie" | "series",
  "year": "YYYY",
  "season": 1 | null,
  "episode": 1 | null,
  "isBatch": false
}`;

    try {
        console.log(`[AI-CLEANER] Extracting metadata for: "${key}"`);
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
            max_tokens: 2000,
        });

        const content = resp.choices[0]?.message?.content?.trim() || "";
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error(`AI did not return a valid JSON object: ${content.slice(0, 100)}`);
        }

        const parsed = MediaMetadataSchema.parse(JSON.parse(jsonMatch[0]));
        console.log(`[AI-CLEANER] Successfully parsed:`, parsed);

        metadataCache.set(key, { data: parsed, timestamp: Date.now() });
        return parsed;
    } catch (err: any) {
        console.warn(`[AI-CLEANER] First attempt failed for "${key}": ${err?.message}. Retrying with AI...`);
        try {
            // Second attempt with simplified prompt
            const retryResp = await client.chat.completions.create({
                model: env.AI_MODEL,
                messages: [
                    {
                        role: "system",
                        content: "You extract media metadata. Output ONLY raw JSON matching: {\"title\": string, \"type\": \"movie\"|\"series\", \"year\": string, \"season\": number|null, \"episode\": number|null, \"isBatch\": boolean}"
                    },
                    { role: "user", content: `Extract media title, release year, type, season, episode from: "${key}"` }
                ],
                temperature: 0.1,
                max_tokens: 2000,
            });

            const content = retryResp.choices[0]?.message?.content?.trim() || "";
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error(`AI retry did not return valid JSON: ${content}`);
            }

            const parsed = MediaMetadataSchema.parse(JSON.parse(jsonMatch[0]));
            metadataCache.set(key, { data: parsed, timestamp: Date.now() });
            return parsed;
        } catch (retryErr: any) {
            console.error(`[AI-CLEANER] AI extraction completely failed for "${key}":`, retryErr?.message);
            // Safe fallback so download requests never fail or crash
            const isSeries = /season|\bS\d|\bEP\b|episode/i.test(key);
            const seasonMatch = key.match(/season\s*(\d{1,2})|\bS(\d{1,2})\b/i);
            const epMatch = key.match(/(?:ep|episode)\s*(\d{1,3})|\bE(\d{1,3})\b/i);
            const cleanTitle = key.split(/[\(\[\{]/)[0].trim() || key;
            const yearMatch = key.match(/\b(19\d{2}|20\d{2})\b/);
            return {
                title: cleanTitle,
                type: isSeries ? "series" : "movie",
                year: yearMatch ? yearMatch[1] : "",
                season: seasonMatch ? parseInt(seasonMatch[1] || seasonMatch[2], 10) : (isSeries ? 1 : null),
                episode: epMatch ? parseInt(epMatch[1] || epMatch[2], 10) : null,
                isBatch: isSeries && !epMatch
            };
        }
    }
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

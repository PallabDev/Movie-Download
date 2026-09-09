import { cleanMediaTitle } from "../tmdb/client.js";

const JELLYFIN_URL = process.env.JELLYFIN_URL || "";
const JELLYFIN_TOKEN = process.env.JELLYFIN_TOKEN || "";

export interface JellyfinItem {
    Id: string;
    Name: string;
    Year?: number;
    ProductionYear?: number;
    Type: string;
    SeriesName?: string;
    SeasonNumber?: number;
    EpisodeNumber?: number;
    ChildCount?: number;
    RecursiveItemCount?: number;
    Overview?: string;
    CommunityRating?: number;
    PremiereDate?: string;
}

interface JellyfinSearchResult {
    Items: JellyfinItem[];
    TotalRecordCount: number;
}

async function jellyfinFetch(path: string, params?: Record<string, string>): Promise<any> {
    if (!JELLYFIN_URL || !JELLYFIN_TOKEN) {
        console.log("[JELLYFIN] Not configured, skipping");
        return null;
    }

    const url = new URL(`${JELLYFIN_URL}${path}`);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, v);
        }
    }

    try {
        const res = await fetch(url.toString(), {
            headers: { "X-Emby-Token": JELLYFIN_TOKEN },
        });

        if (!res.ok) {
            console.error(`[JELLYFIN] Request failed: ${res.status}`);
            return null;
        }

        return await res.json();
    } catch (err) {
        console.error("[JELLYFIN] Connection error:", err);
        return null;
    }
}

export async function searchMovies(query: string): Promise<JellyfinItem[]> {
    const data: JellyfinSearchResult | null = await jellyfinFetch("/Items", {
        IncludeItemTypes: "Movie",
        Recursive: "true",
        SearchTerm: query,
        Fields: "Overview,CommunityRating,PremiereDate,ProductionYear",
        Limit: "15",
    });
    return data?.Items || [];
}

export async function searchSeries(query: string): Promise<JellyfinItem[]> {
    const data: JellyfinSearchResult | null = await jellyfinFetch("/Items", {
        IncludeItemTypes: "Series",
        Recursive: "true",
        SearchTerm: query,
        Fields: "Overview,ChildCount,RecursiveItemCount,CommunityRating,PremiereDate,ProductionYear",
        Limit: "20",
    });
    return data?.Items || [];
}

function normalizeTitleForMatch(str: string): string {
    return str.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

function isFuzzyTitleMatch(candidateName: string, targetName: string): boolean {
    const cand = normalizeTitleForMatch(candidateName);
    const target = normalizeTitleForMatch(targetName);
    if (!cand || !target) return false;
    if (cand === target) return true;

    // Check if one contains the other as a whole word boundary
    const candWords = cand.split(" ");
    const targetWords = target.split(" ");

    // If target has at least 2 words and is completely in candidate
    if (targetWords.length >= 2 && cand.includes(target)) return true;
    if (candWords.length >= 2 && target.includes(cand)) return true;

    // If single word, require exact match or length >= 4
    if (candWords.length === 1 && targetWords.length === 1) {
        return cand === target;
    }

    // Check high word overlap
    const matchingWords = targetWords.filter(w => w.length > 2 && candWords.includes(w));
    if (matchingWords.length >= Math.min(targetWords.length, 2)) {
        return true;
    }

    return false;
}

export async function checkMovieExists(
    title: string,
    year?: string
): Promise<{ exists: boolean; item?: JellyfinItem }> {
    const cleanInfo = cleanMediaTitle(title);
    const searchTarget = cleanInfo.title || title;
    const targetYear = year || cleanInfo.year;

    const results = await searchMovies(searchTarget);
    if (results.length === 0) {
        return { exists: false };
    }

    for (const item of results) {
        if (isFuzzyTitleMatch(item.Name, searchTarget)) {
            const itemYear = String(item.ProductionYear || item.Year || "");
            if (targetYear && itemYear && itemYear === targetYear) {
                return { exists: true, item };
            }
            if (!targetYear || !itemYear) {
                return { exists: true, item };
            }
        }
    }

    return { exists: false };
}

export async function checkSeriesExists(
    title: string
): Promise<{ exists: boolean; item?: JellyfinItem }> {
    const cleanInfo = cleanMediaTitle(title);
    const searchTarget = cleanInfo.title || title;

    const results = await searchSeries(searchTarget);
    if (results.length === 0) {
        return { exists: false };
    }

    for (const item of results) {
        if (isFuzzyTitleMatch(item.Name, searchTarget)) {
            return { exists: true, item };
        }
    }

    return { exists: false };
}

/**
 * Unified duplicate check across both Movies and Series in Jellyfin
 */
export async function checkMediaExists(
    rawTitle: string,
    preferredType?: "movie" | "series",
    year?: string
): Promise<{ exists: boolean; item?: JellyfinItem; type?: "movie" | "series" }> {
    const clean = cleanMediaTitle(rawTitle);
    const query = clean.title || rawTitle;
    const targetYear = year || clean.year;

    // Detect if title contains obvious series markers
    const hasSeriesMarkers = /\b(season|s\d{1,2}|episode|ep\d{1,2}|batch|all episodes)\b/i.test(rawTitle);
    const isSeriesLikely = preferredType === "series" || hasSeriesMarkers;

    if (isSeriesLikely) {
        const sRes = await checkSeriesExists(query);
        if (sRes.exists) {
            return { exists: true, item: sRes.item, type: "series" };
        }
        // Fallback to movie check just in case
        const mRes = await checkMovieExists(query, targetYear);
        if (mRes.exists) {
            return { exists: true, item: mRes.item, type: "movie" };
        }
    } else {
        const mRes = await checkMovieExists(query, targetYear);
        if (mRes.exists) {
            return { exists: true, item: mRes.item, type: "movie" };
        }
        // Fallback to series check
        const sRes = await checkSeriesExists(query);
        if (sRes.exists) {
            return { exists: true, item: sRes.item, type: "series" };
        }
    }

    return { exists: false };
}

export async function getLibraryStats(): Promise<{ movies: number; series: number; total: number }> {
    const [movies, series] = await Promise.all([
        jellyfinFetch("/Items", {
            IncludeItemTypes: "Movie",
            Recursive: "true",
            Limit: "0",
        }),
        jellyfinFetch("/Items", {
            IncludeItemTypes: "Series",
            Recursive: "true",
            Limit: "0",
        })
    ]);

    const moviesCount = movies?.TotalRecordCount || 0;
    const seriesCount = series?.TotalRecordCount || 0;

    return {
        movies: moviesCount,
        series: seriesCount,
        total: moviesCount + seriesCount,
    };
}

export async function getAllMovies(): Promise<JellyfinItem[]> {
    const data: JellyfinSearchResult | null = await jellyfinFetch("/Items", {
        IncludeItemTypes: "Movie",
        Recursive: "true",
        Fields: "Overview,CommunityRating,PremiereDate,ProductionYear",
        Limit: "10000",
        SortBy: "Name",
    });
    return data?.Items || [];
}

export async function getAllSeries(): Promise<JellyfinItem[]> {
    const data: JellyfinSearchResult | null = await jellyfinFetch("/Items", {
        IncludeItemTypes: "Series",
        Recursive: "true",
        Fields: "Overview,ChildCount,RecursiveItemCount,CommunityRating,PremiereDate,ProductionYear",
        Limit: "10000",
        SortBy: "Name",
    });
    return data?.Items || [];
}

import { cleanMediaTitle } from "../tmdb/client.js";
import { env } from "../utils/env.js";

const JELLYFIN_URL = env.JELLYFIN_URL || process.env.JELLYFIN_URL || "";
const JELLYFIN_TOKEN = env.JELLYFIN_TOKEN || process.env.JELLYFIN_TOKEN || "";

export interface JellyfinItem {
    Id: string;
    Name: string;
    Year?: number;
    ProductionYear?: number;
    Type: string;
    SeriesName?: string;
    IndexNumber?: number;
    ParentIndexNumber?: number;
    SeasonNumber?: number;
    EpisodeNumber?: number;
    LocationType?: string;
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

export async function getSeriesSeasons(seriesId: string): Promise<JellyfinItem[]> {
    const data: JellyfinSearchResult | null = await jellyfinFetch(`/Shows/${seriesId}/Seasons`);
    return data?.Items || [];
}

export async function getSeriesEpisodes(seriesId: string, seasonNumber?: number): Promise<JellyfinItem[]> {
    const params: Record<string, string> = {
        Fields: "Overview,IndexNumber,ParentIndexNumber,LocationType",
    };
    if (seasonNumber !== undefined) {
        params.season = String(seasonNumber);
    }
    const data: JellyfinSearchResult | null = await jellyfinFetch(`/Shows/${seriesId}/Episodes`, params);
    return data?.Items || [];
}

export async function checkSeriesExists(
    title: string,
    season?: number,
    episode?: number
): Promise<{
    exists: boolean;
    item?: JellyfinItem;
    season?: number;
    episode?: number;
    seriesExists?: boolean;
}> {
    const cleanInfo = cleanMediaTitle(title);
    const searchTarget = cleanInfo.title || title;
    const targetSeason = season !== undefined ? season : cleanInfo.season;
    const targetEpisode = episode !== undefined ? episode : cleanInfo.episode;

    const results = await searchSeries(searchTarget);
    if (results.length === 0) {
        return { exists: false, seriesExists: false };
    }

    let matchedSeries: JellyfinItem | undefined;
    for (const item of results) {
        if (isFuzzyTitleMatch(item.Name, searchTarget)) {
            matchedSeries = item;
            break;
        }
    }

    if (!matchedSeries) {
        return { exists: false, seriesExists: false };
    }

    // If neither season nor episode was requested, user is checking series overall
    if (targetSeason === undefined && targetEpisode === undefined) {
        return { exists: true, item: matchedSeries, seriesExists: true };
    }

    // Specific season or episode requested. Verify against real files in Jellyfin!
    try {
        if (targetSeason !== undefined) {
            const eps = await getSeriesEpisodes(matchedSeries.Id, targetSeason);
            // Filter real files (exclude virtual metadata-only entries)
            const realEps = eps.filter(e => e.LocationType !== "Virtual");

            if (targetEpisode !== undefined) {
                const epItem = realEps.find(e => e.IndexNumber === targetEpisode);
                if (epItem) {
                    return { exists: true, item: epItem, season: targetSeason, episode: targetEpisode, seriesExists: true };
                }
                return { exists: false, item: matchedSeries, season: targetSeason, episode: targetEpisode, seriesExists: true };
            } else {
                // Batch pack check: exists if there are real media files for this season
                if (realEps.length > 0) {
                    return { exists: true, item: matchedSeries, season: targetSeason, seriesExists: true };
                }
                return { exists: false, item: matchedSeries, season: targetSeason, seriesExists: true };
            }
        } else if (targetEpisode !== undefined) {
            const allEps = await getSeriesEpisodes(matchedSeries.Id);
            const realEps = allEps.filter(e => e.LocationType !== "Virtual");
            const epItem = realEps.find(e => e.IndexNumber === targetEpisode);
            if (epItem) {
                return { exists: true, item: epItem, episode: targetEpisode, seriesExists: true };
            }
            return { exists: false, item: matchedSeries, episode: targetEpisode, seriesExists: true };
        }
    } catch (err) {
        console.warn(`[JELLYFIN] Error checking episodes for series ${matchedSeries.Name}:`, err);
    }

    return { exists: false, item: matchedSeries, seriesExists: true };
}

/**
 * Unified duplicate check across both Movies and Series in Jellyfin
 */
export async function checkMediaExists(
    rawTitle: string,
    preferredType?: "movie" | "series",
    year?: string,
    season?: number,
    episode?: number
): Promise<{
    exists: boolean;
    item?: JellyfinItem;
    type?: "movie" | "series";
    season?: number;
    episode?: number;
    seriesExists?: boolean;
}> {
    const clean = cleanMediaTitle(rawTitle);
    const query = clean.title || rawTitle;
    const targetYear = year || clean.year;
    const targetSeason = season !== undefined ? season : clean.season;
    const targetEpisode = episode !== undefined ? episode : clean.episode;

    // Detect if title contains obvious series markers
    const hasSeriesMarkers = /\b(season|s\d{1,2}|episode|ep\d{1,2}|batch|all episodes)\b/i.test(rawTitle);
    const isSeriesLikely = preferredType === "series" || hasSeriesMarkers || targetSeason !== undefined || targetEpisode !== undefined;

    if (isSeriesLikely) {
        const sRes = await checkSeriesExists(query, targetSeason, targetEpisode);
        if (sRes.exists) {
            return { exists: true, item: sRes.item, type: "series", season: sRes.season, episode: sRes.episode, seriesExists: sRes.seriesExists };
        }
        // If preferredType was explicitly series or targetSeason/episode is specified, don't fall back to movie
        if (preferredType === "series" || targetSeason !== undefined || targetEpisode !== undefined) {
            return { exists: false, item: sRes.item, type: "series", season: targetSeason, episode: targetEpisode, seriesExists: sRes.seriesExists };
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
        const sRes = await checkSeriesExists(query, targetSeason, targetEpisode);
        if (sRes.exists) {
            return { exists: true, item: sRes.item, type: "series", season: sRes.season, episode: sRes.episode, seriesExists: sRes.seriesExists };
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

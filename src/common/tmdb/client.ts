import { env } from "../utils/env.js";

const TMDB_BASE_URL = "https://api.tmdb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

const READ_ACCESS_TOKEN = (env.TMDB_API_READ_ACCESS_TOKEN || "").trim();
const API_KEY = (env.TMDB_API_KEY || "").trim();

export interface TMDBGenre {
    id: number;
    name: string;
}

export interface TMDBCastMember {
    id: number;
    name: string;
    character: string;
    order: number;
}

export interface TMDBCrewMember {
    id: number;
    name: string;
    job: string;
    department: string;
}

export interface TMDBSeasonSummary {
    id: number;
    season_number: number;
    name: string;
    episode_count: number;
    air_date?: string;
    overview?: string;
    poster_path?: string;
}

export interface TMDBEpisode {
    id: number;
    episode_number: number;
    name: string;
    overview?: string;
    air_date?: string;
    runtime?: number;
    still_path?: string;
    vote_average?: number;
}

export interface TMDBCollectionPart {
    id: number;
    title: string;
    original_title?: string;
    overview?: string;
    release_date?: string;
    poster_path?: string;
    backdrop_path?: string;
    vote_average?: number;
}

export interface TMDBCollection {
    id: number;
    name: string;
    overview?: string;
    poster_path?: string;
    backdrop_path?: string;
    parts: TMDBCollectionPart[];
}

export interface TMDBMediaLookupResult {
    found: boolean;
    type: "movie" | "series";
    id: number;
    title: string;
    originalTitle: string;
    year: string;
    releaseDate: string;
    overview: string;
    posterUrl: string | null;
    backdropUrl: string | null;
    rating: number;
    voteCount: number;
    genres: string[];
    directors: string[];
    cast: string[];
    status?: string;
    // TV Series specific
    totalSeasons?: number;
    totalEpisodes?: number;
    seasons?: Array<{
        seasonNumber: number;
        name: string;
        episodeCount: number;
        airDate?: string;
        overview?: string;
    }>;
    episodesPerSeason?: number[];
    // Movie specific
    runtime?: number;
    collection?: {
        id: number;
        name: string;
        partsCount: number;
        parts: Array<{
            id: number;
            title: string;
            releaseDate: string;
            year: string;
            overview?: string;
        }>;
    } | null;
}

/**
 * Robust fetch wrapper with retries and timeout for TMDB API
 */
export async function tmdbFetch(endpoint: string, params: Record<string, string | number | boolean> = {}): Promise<any> {
    const url = new URL(`${TMDB_BASE_URL}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`);

    // Add query params
    url.searchParams.set("language", "en-US");
    if (API_KEY) {
        url.searchParams.set("api_key", API_KEY);
    }
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") {
            url.searchParams.set(k, String(v));
        }
    }

    const headers: Record<string, string> = {
        "Accept": "application/json",
        "User-Agent": "CineGrab/2.0 (Telegram Movie Downloader)",
    };

    if (READ_ACCESS_TOKEN) {
        headers["Authorization"] = `Bearer ${READ_ACCESS_TOKEN}`;
    }

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            const res = await fetch(url.toString(), {
                method: "GET",
                headers,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (res.status === 404) {
                return null;
            }

            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                console.warn(`[TMDB] HTTP ${res.status} for ${endpoint}: ${errText.substring(0, 100)}`);
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 600 * attempt));
                    continue;
                }
                return null;
            }

            return await res.json();
        } catch (err: any) {
            const isAbort = err.name === "AbortError";
            console.warn(`[TMDB] Attempt ${attempt} failed for ${endpoint}: ${isAbort ? "Timeout (8s)" : err.message}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 600 * attempt));
            } else {
                return null;
            }
        }
    }

    return null;
}

export function getTMDBImageUrl(path: string | null | undefined, size: "w500" | "original" | "w300" = "w500"): string | null {
    if (!path) return null;
    return `${TMDB_IMAGE_BASE}/${size}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Search multi (movies, TV shows, and persons)
 */
export async function searchMulti(query: string, page = 1): Promise<{ results: any[]; total_results: number; total_pages: number }> {
    const data = await tmdbFetch("/search/multi", {
        query: query.trim(),
        include_adult: false,
        page,
    });
    return data || { results: [], total_results: 0, total_pages: 0 };
}

/**
 * Search movies
 */
export async function searchMovie(query: string, year?: string | number, page = 1): Promise<{ results: any[]; total_results: number }> {
    const params: Record<string, any> = {
        query: query.trim(),
        include_adult: false,
        page,
    };
    if (year) {
        params.primary_release_year = String(year);
    }
    const data = await tmdbFetch("/search/movie", params);
    return data || { results: [], total_results: 0 };
}

/**
 * Search TV series
 */
export async function searchTV(query: string, year?: string | number, page = 1): Promise<{ results: any[]; total_results: number }> {
    const params: Record<string, any> = {
        query: query.trim(),
        include_adult: false,
        page,
    };
    if (year) {
        params.first_air_date_year = String(year);
    }
    const data = await tmdbFetch("/search/tv", params);
    return data || { results: [], total_results: 0 };
}

/**
 * Search collections (movie franchises)
 */
export async function searchCollection(query: string): Promise<{ results: any[]; total_results: number }> {
    const data = await tmdbFetch("/search/collection", {
        query: query.trim(),
        include_adult: false,
    });
    return data || { results: [], total_results: 0 };
}

/**
 * Get detailed movie information with cast & crew
 */
export async function getMovieDetails(id: number): Promise<any> {
    return await tmdbFetch(`/movie/${id}`, {
        append_to_response: "credits,videos,images",
    });
}

/**
 * Get detailed TV series information with seasons & cast
 */
export async function getTVDetails(id: number): Promise<any> {
    return await tmdbFetch(`/tv/${id}`, {
        append_to_response: "credits,videos,images",
    });
}

/**
 * Get detailed season episode list
 */
export async function getSeasonDetails(tvId: number, seasonNumber: number): Promise<{
    season_number: number;
    name: string;
    overview: string;
    air_date?: string;
    episodes: TMDBEpisode[];
} | null> {
    return await tmdbFetch(`/tv/${tvId}/season/${seasonNumber}`);
}

/**
 * Get collection / franchise details
 */
export async function getCollectionDetails(collectionId: number): Promise<TMDBCollection | null> {
    return await tmdbFetch(`/collection/${collectionId}`);
}

/**
 * Clean user search text to extract the core title
 */
export function cleanMediaTitle(query: string): { title: string; year?: string; season?: number; episode?: number } {
    let q = query.trim();

    // Extract season/episode if mentioned
    let season: number | undefined;
    let episode: number | undefined;

    const sMatch = q.match(/S(\d{1,2})/i) || q.match(/Season\s*(\d{1,2})/i);
    if (sMatch) season = parseInt(sMatch[1], 10);

    const eMatch = q.match(/E(\d{1,2})/i) || q.match(/Episode\s*(\d{1,2})/i);
    if (eMatch) episode = parseInt(eMatch[1], 10);

    // Extract year
    let year: string | undefined;
    const yearMatch = q.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
        year = yearMatch[1];
    }

    // Clean common search noise and typos (e.g. downlaod, dwonlaod, saerch)
    q = q
        .replace(/\b(?:how many|how much|part is released|parts|part|till date|from internet|search|saerch|serach|download|downlaod|dwonlaod|dowload|dwnld|donwload|downlod|dwload|downlaoding|downloading|find|watch|all seasons|all episodes|full movie|hd|720p|1080p|4k|web series|series|tv show|show|movie|film|option\s*\d+)\b/gi, " ")
        .replace(/(?:\[|\b)S\d{1,2}[\s._-]*E\d{1,2}(?:\]|\b)/gi, " ")
        .replace(/\bSeason\s*\d{1,2}\b/gi, " ")
        .replace(/\bS\d{1,2}\b/gi, " ")
        .replace(/\b(19\d{2}|20\d{2})\b/g, " ")
        .replace(/[:\-–—]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return {
        title: q || query.trim(),
        year,
        season,
        episode,
    };
}

/**
 * Comprehensive Smart Media Lookup:
 * Searches TMDB, identifies if it is a movie or series, gets exact release year,
 * per-season counts, franchise/collection parts, synopsis, cast, and poster.
 */
export async function lookupMedia(rawQuery: string): Promise<TMDBMediaLookupResult | null> {
    const { title: cleanTitle, year: extractedYear } = cleanMediaTitle(rawQuery);
    const searchTarget = cleanTitle || rawQuery.trim();

    console.log(`[TMDB] Looking up media for: "${rawQuery}" -> Cleaned: "${searchTarget}" (Year: ${extractedYear || "none"})`);

    // 1. Check if it's a known movie franchise/collection (e.g., "Baahubali", "Harry Potter")
    const collectionSearch = await searchCollection(searchTarget);
    let matchedCollection: TMDBCollection | null = null;
    if (collectionSearch.results && collectionSearch.results.length > 0) {
        const topColl = collectionSearch.results[0];
        const collDetails = await getCollectionDetails(topColl.id);
        if (collDetails && collDetails.parts && collDetails.parts.length > 0) {
            matchedCollection = collDetails;
        }
    }

    // 2. Perform multi-search
    const multi = await searchMulti(searchTarget);
    const candidates = (multi.results || []).filter((r: any) => r.media_type === "movie" || r.media_type === "tv");

    // If multi search had no direct results, try direct TV search and movie search
    if (candidates.length === 0) {
        const [tvRes, movieRes] = await Promise.all([
            searchTV(searchTarget, extractedYear),
            searchMovie(searchTarget, extractedYear),
        ]);

        if (tvRes.results?.length) {
            candidates.push(...tvRes.results.map((r: any) => ({ ...r, media_type: "tv" })));
        }
        if (movieRes.results?.length) {
            candidates.push(...movieRes.results.map((r: any) => ({ ...r, media_type: "movie" })));
        }
    }

    if (candidates.length === 0 && matchedCollection) {
        // We found a collection even if single movie didn't hit
        const parts = matchedCollection.parts.map(p => ({
            id: p.id,
            title: p.title,
            releaseDate: p.release_date || "",
            year: p.release_date ? p.release_date.slice(0, 4) : "",
            overview: p.overview,
        })).sort((a, b) => (a.releaseDate > b.releaseDate ? 1 : -1));

        return {
            found: true,
            type: "movie",
            id: matchedCollection.id,
            title: matchedCollection.name,
            originalTitle: matchedCollection.name,
            year: parts[0]?.year || "",
            releaseDate: parts[0]?.releaseDate || "",
            overview: matchedCollection.overview || `Movie franchise with ${parts.length} released parts.`,
            posterUrl: getTMDBImageUrl(matchedCollection.poster_path),
            backdropUrl: getTMDBImageUrl(matchedCollection.backdrop_path, "original"),
            rating: 8.0,
            voteCount: 100,
            genres: ["Action", "Adventure", "Drama"],
            directors: [],
            cast: [],
            collection: {
                id: matchedCollection.id,
                name: matchedCollection.name,
                partsCount: parts.length,
                parts,
            },
        };
    }

    if (candidates.length === 0) {
        return null;
    }

    // Pick best matching candidate (prioritize year if provided)
    let bestCandidate = candidates[0];
    if (extractedYear) {
        const yearMatch = candidates.find((c: any) => {
            const date = c.release_date || c.first_air_date || "";
            return date.startsWith(extractedYear);
        });
        if (yearMatch) bestCandidate = yearMatch;
    }

    // Process TV series
    if (bestCandidate.media_type === "tv") {
        const tv = await getTVDetails(bestCandidate.id);
        if (!tv) return null;

        const mainSeasons = (tv.seasons || []).filter((s: TMDBSeasonSummary) => s.season_number > 0);
        const seasons = mainSeasons.map((s: TMDBSeasonSummary) => ({
            seasonNumber: s.season_number,
            name: s.name,
            episodeCount: s.episode_count,
            airDate: s.air_date,
            overview: s.overview,
        }));

        const episodesPerSeason = seasons.map((s: any) => s.episodeCount);

        const cast = (tv.credits?.cast || []).slice(0, 5).map((c: TMDBCastMember) => c.name);
        const creators = (tv.created_by || []).map((c: any) => c.name);

        return {
            found: true,
            type: "series",
            id: tv.id,
            title: tv.name,
            originalTitle: tv.original_name || tv.name,
            year: tv.first_air_date ? tv.first_air_date.slice(0, 4) : "",
            releaseDate: tv.first_air_date || "",
            overview: tv.overview || "",
            posterUrl: getTMDBImageUrl(tv.poster_path),
            backdropUrl: getTMDBImageUrl(tv.backdrop_path, "original"),
            rating: tv.vote_average || 0,
            voteCount: tv.vote_count || 0,
            genres: (tv.genres || []).map((g: TMDBGenre) => g.name),
            directors: creators,
            cast,
            status: tv.status,
            totalSeasons: tv.number_of_seasons || seasons.length,
            totalEpisodes: tv.number_of_episodes || episodesPerSeason.reduce((a: number, b: number) => a + b, 0),
            seasons,
            episodesPerSeason,
        };
    }

    // Process Movie
    const movie = await getMovieDetails(bestCandidate.id);
    if (!movie) return null;

    const cast = (movie.credits?.cast || []).slice(0, 5).map((c: TMDBCastMember) => c.name);
    const directors = (movie.credits?.crew || [])
        .filter((c: TMDBCrewMember) => c.job === "Director")
        .map((c: TMDBCrewMember) => c.name);

    let collectionObj: any = null;
    if (movie.belongs_to_collection || matchedCollection) {
        const collId = movie.belongs_to_collection?.id || matchedCollection?.id;
        if (collId) {
            const collDetails = matchedCollection && matchedCollection.id === collId
                ? matchedCollection
                : await getCollectionDetails(collId);

            if (collDetails && collDetails.parts) {
                const parts = collDetails.parts.map(p => ({
                    id: p.id,
                    title: p.title,
                    releaseDate: p.release_date || "",
                    year: p.release_date ? p.release_date.slice(0, 4) : "",
                    overview: p.overview,
                })).sort((a, b) => (a.releaseDate > b.releaseDate ? 1 : -1));

                collectionObj = {
                    id: collDetails.id,
                    name: collDetails.name,
                    partsCount: parts.length,
                    parts,
                };
            }
        }
    }

    return {
        found: true,
        type: "movie",
        id: movie.id,
        title: movie.title,
        originalTitle: movie.original_title || movie.title,
        year: movie.release_date ? movie.release_date.slice(0, 4) : "",
        releaseDate: movie.release_date || "",
        overview: movie.overview || "",
        posterUrl: getTMDBImageUrl(movie.poster_path),
        backdropUrl: getTMDBImageUrl(movie.backdrop_path, "original"),
        rating: movie.vote_average || 0,
        voteCount: movie.vote_count || 0,
        genres: (movie.genres || []).map((g: TMDBGenre) => g.name),
        directors,
        cast,
        runtime: movie.runtime || 0,
        collection: collectionObj,
    };
}

/**
 * Specifically get TV series season & episode details
 */
export async function getSeriesSeasonsAndEpisodes(title: string): Promise<{
    found: boolean;
    title: string;
    totalSeasons: number;
    totalEpisodes: number;
    seasons: Array<{ seasonNumber: number; name: string; episodeCount: number; airDate?: string }>;
    episodesPerSeason: number[];
}> {
    const lookup = await lookupMedia(title);
    if (lookup && lookup.type === "series" && lookup.seasons) {
        return {
            found: true,
            title: lookup.title,
            totalSeasons: lookup.totalSeasons || lookup.seasons.length,
            totalEpisodes: lookup.totalEpisodes || 0,
            seasons: lookup.seasons,
            episodesPerSeason: lookup.episodesPerSeason || lookup.seasons.map(s => s.episodeCount),
        };
    }

    // Try direct search
    const tvSearch = await searchTV(title);
    if (tvSearch.results && tvSearch.results.length > 0) {
        const tv = await getTVDetails(tvSearch.results[0].id);
        if (tv) {
            const mainSeasons = (tv.seasons || []).filter((s: TMDBSeasonSummary) => s.season_number > 0);
            const seasons = mainSeasons.map((s: TMDBSeasonSummary) => ({
                seasonNumber: s.season_number,
                name: s.name,
                episodeCount: s.episode_count,
                airDate: s.air_date,
            }));
            return {
                found: true,
                title: tv.name,
                totalSeasons: tv.number_of_seasons || seasons.length,
                totalEpisodes: tv.number_of_episodes || 0,
                seasons,
                episodesPerSeason: seasons.map((s: any) => s.episodeCount),
            };
        }
    }

    return {
        found: false,
        title,
        totalSeasons: 1,
        totalEpisodes: 10,
        seasons: [{ seasonNumber: 1, name: "Season 1", episodeCount: 10 }],
        episodesPerSeason: [10],
    };
}

/**
 * Get episode list for a specific season
 */
export async function getSeasonEpisodesList(title: string, seasonNumber: number): Promise<{
    found: boolean;
    title: string;
    seasonNumber: number;
    episodes: Array<{ episodeNumber: number; name: string; airDate?: string; overview?: string; runtime?: number }>;
}> {
    const lookup = await lookupMedia(title);
    if (!lookup) {
        return {
            found: false,
            title,
            seasonNumber,
            episodes: Array.from({ length: 10 }, (_, i) => ({ episodeNumber: i + 1, name: `Episode ${i + 1}` })),
        };
    }

    const seasonData = await getSeasonDetails(lookup.id, seasonNumber);
    if (seasonData && seasonData.episodes && seasonData.episodes.length > 0) {
        return {
            found: true,
            title: lookup.title,
            seasonNumber,
            episodes: seasonData.episodes.map(e => ({
                episodeNumber: e.episode_number,
                name: e.name || `Episode ${e.episode_number}`,
                airDate: e.air_date,
                overview: e.overview,
                runtime: e.runtime,
            })),
        };
    }

    const count = lookup.episodesPerSeason?.[seasonNumber - 1] || 10;
    return {
        found: true,
        title: lookup.title,
        seasonNumber,
        episodes: Array.from({ length: count }, (_, i) => ({ episodeNumber: i + 1, name: `Episode ${i + 1}` })),
    };
}

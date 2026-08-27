const JELLYFIN_URL = process.env.JELLYFIN_URL || "";
const JELLYFIN_TOKEN = process.env.JELLYFIN_TOKEN || "";

interface JellyfinItem {
    Id: string;
    Name: string;
    Year?: number;
    Type: string;
    SeriesName?: string;
    SeasonNumber?: number;
    EpisodeNumber?: number;
    Overview?: string;
    CommunityRating?: number;
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
        Limit: "10",
    });
    return data?.Items || [];
}

export async function searchSeries(query: string): Promise<JellyfinItem[]> {
    const data: JellyfinSearchResult | null = await jellyfinFetch("/Items", {
        IncludeItemTypes: "Series",
        Recursive: "true",
        SearchTerm: query,
        Limit: "10",
    });
    return data?.Items || [];
}

export async function checkMovieExists(
    title: string,
    year?: string
): Promise<{ exists: boolean; item?: JellyfinItem }> {
    const results = await searchMovies(title);

    if (results.length === 0) {
        return { exists: false };
    }

    // Try to match by title and year
    const normalizedTitle = title.toLowerCase().trim();
    for (const item of results) {
        const itemTitle = item.Name.toLowerCase().trim();
        if (itemTitle === normalizedTitle || itemTitle.includes(normalizedTitle) || normalizedTitle.includes(itemTitle)) {
            if (year && item.Year && item.Year.toString() === year) {
                return { exists: true, item };
            }
            if (!year) {
                return { exists: true, item };
            }
        }
    }

    return { exists: false };
}

export async function checkSeriesExists(
    title: string
): Promise<{ exists: boolean; item?: JellyfinItem }> {
    const results = await searchSeries(title);

    if (results.length === 0) {
        return { exists: false };
    }

    const normalizedTitle = title.toLowerCase().trim();
    for (const item of results) {
        const itemTitle = item.Name.toLowerCase().trim();
        if (itemTitle === normalizedTitle || itemTitle.includes(normalizedTitle) || normalizedTitle.includes(itemTitle)) {
            return { exists: true, item };
        }
    }

    return { exists: false };
}

export async function getLibraryStats(): Promise<{ movies: number; series: number }> {
    const movies = await jellyfinFetch("/Items", {
        IncludeItemTypes: "Movie",
        Recursive: "true",
        Limit: "0",
    });

    const series = await jellyfinFetch("/Items", {
        IncludeItemTypes: "Series",
        Recursive: "true",
        Limit: "0",
    });

    return {
        movies: movies?.TotalRecordCount || 0,
        series: series?.TotalRecordCount || 0,
    };
}

export async function getAllMovies(): Promise<JellyfinItem[]> {
    const data: JellyfinSearchResult | null = await jellyfinFetch("/Items", {
        IncludeItemTypes: "Movie",
        Recursive: "true",
        Limit: "10000",
        SortBy: "Name",
    });
    return data?.Items || [];
}

export async function getAllSeries(): Promise<JellyfinItem[]> {
    const data: JellyfinSearchResult | null = await jellyfinFetch("/Items", {
        IncludeItemTypes: "Series",
        Recursive: "true",
        Limit: "10000",
        SortBy: "Name",
    });
    return data?.Items || [];
}

import { getHarness } from "../../../command/harness.js";
import { TelegramClient } from "teleproto";

interface SearchResult {
    type: "movie" | "series";
    title: string;
    year?: string;
    seasons?: number;
    episodesPerSeason?: number[];
    quality?: string;
    size?: string;
}

export async function searchMovie(
    client: TelegramClient,
    botUsername: string,
    query: string
): Promise<string> {
    const harness = getHarness();
    harness.logActivity(`[TELEGRAM] Searching movie: ${query} via ${botUsername}`);

    try {
        const message = await client.sendMessage(botUsername, {
            message: query,
        });
        harness.logActivity(`[TELEGRAM] Sent search request, message id: ${message.id}`);

        // Wait for bot response
        await new Promise((resolve) => setTimeout(resolve, 3000));

        return `Search sent to ${botUsername} for: ${query}`;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        harness.logError(`[TELEGRAM] Search failed: ${errMsg}`);
        throw error;
    }
}

export async function searchSeries(
    client: TelegramClient,
    botUsername: string,
    title: string,
    season: number,
    episode: number
): Promise<string> {
    const harness = getHarness();
    const query = `${title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    harness.logActivity(`[TELEGRAM] Searching series: ${query} via ${botUsername}`);

    try {
        const message = await client.sendMessage(botUsername, {
            message: query,
        });
        harness.logActivity(`[TELEGRAM] Sent series search, message id: ${message.id}`);

        await new Promise((resolve) => setTimeout(resolve, 3000));

        return `Search sent to ${botUsername} for: ${query}`;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        harness.logError(`[TELEGRAM] Series search failed: ${errMsg}`);
        throw error;
    }
}

export async function downloadFile(
    client: TelegramClient,
    botUsername: string,
    query: string
): Promise<string> {
    const harness = getHarness();
    harness.logActivity(`[TELEGRAM] Requesting download: ${query}`);

    try {
        const message = await client.sendMessage(botUsername, {
            message: query,
        });
        harness.logActivity(`[TELEGRAM] Download request sent, message id: ${message.id}`);

        // Wait for file
        await new Promise((resolve) => setTimeout(resolve, 5000));

        return `Download request sent to ${botUsername}`;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        harness.logError(`[TELEGRAM] Download failed: ${errMsg}`);
        throw error;
    }
}

export function parseSearchResult(response: string): SearchResult | null {
    const lower = response.toLowerCase();

    const isMovie = lower.includes("movie") || lower.includes("film");
    const isSeries = lower.includes("series") || lower.includes("season") || lower.includes("episode");

    const titleMatch = response.match(/(?:title|name)[:\s]+(.+)/i);
    const yearMatch = response.match(/\b(19|20)\d{2}\b/);
    const seasonMatch = response.match(/season\s+(\d+)/i);
    const episodeMatch = response.match(/episode\s+(\d+)/i);
    const qualityMatch = response.match(/(720p|1080p|480p|2160p)/i);
    const sizeMatch = response.match(/(\d+\.?\d*\s*(?:GB|MB))/i);

    if (!titleMatch && !yearMatch) return null;

    return {
        type: isSeries ? "series" : "movie",
        title: titleMatch?.[1]?.trim() || "",
        year: yearMatch?.[0],
        seasons: seasonMatch ? parseInt(seasonMatch[1]) : undefined,
        episodesPerSeason: undefined,
        quality: qualityMatch?.[1],
        size: sizeMatch?.[1],
    };
}

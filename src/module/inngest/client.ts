import { Inngest } from "inngest";

export const inngest = new Inngest({
    id: "movie-downloader",
    name: "Movie Downloader",
    isDev: true,
});

// Event type schemas
export type MovieSearchEvent = {
    name: "movie.search";
    data: { title: string; year?: string; sessionId: string };
};

export type MovieSearchCompletedEvent = {
    name: "movie.search.completed";
    data: { title: string; year?: string; resultCount: number; sessionKey: string; sessionId: string };
};

export type SeriesSearchEvent = {
    name: "series.search";
    data: { title: string; sessionId: string };
};

export type SeriesSearchCompletedEvent = {
    name: "series.search.completed";
    data: { title: string; resultCount: number; episodeCount: number; seasonCount: number; sessionKey: string; sessionId: string };
};

export type DownloadStartEvent = {
    name: "download.start";
    data: { requestId: string; title: string; type: string; buttonText: string; bot: string; btnMsgId: number; year?: string };
};

export type DownloadStartedEvent = {
    name: "download.started";
    data: { requestId: string; title: string; type: string; fileSize?: string };
};

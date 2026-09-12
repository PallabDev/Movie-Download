import { existsSync, mkdirSync, statSync, readdirSync, createWriteStream } from "node:fs";
import { resolve, join, extname, basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getHarness } from "../../../command/harness.js";
import { normalizeDirectStreamUrl, type DownloadServer } from "./api-client.js";

const DOWNLOAD_ROOT = resolve(process.cwd(), "download");

export function ensureDir(dir: string) {
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function toTitleCase(str: string): string {
    return str
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace(/\b(of|the|a|an|and|or|but|in|on|at|to|for|is|it)\b/gi, (w) =>
            w.toLowerCase()
        )
        .replace(/\b\w/g, (c, i) => (i === 0 ? c.toUpperCase() : c));
}

function sanitizeFilename(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function getMoviePath(title: string, year?: string, originalFileName?: string): string {
    let detectedYear = (year && year !== "unknown" && /^\d{4}$/.test(String(year).trim())) ? String(year).trim() : "";
    let rawTitle = (title || "Movie").trim();

    // 1. Check title for year in parentheses: (1999) or (2016)
    const parenMatch = rawTitle.match(/\((19\d{2}|20\d{2})\)/);
    if (parenMatch) {
        if (!detectedYear) detectedYear = parenMatch[1];
        rawTitle = rawTitle.substring(0, parenMatch.index).trim();
    } else {
        // 2. Check title for standalone year boundary: 1999 or 2016
        const wordMatch = rawTitle.match(/\b(19\d{2}|20\d{2})\b/);
        if (wordMatch) {
            if (!detectedYear) detectedYear = wordMatch[1];
            rawTitle = rawTitle.substring(0, wordMatch.index).trim();
        }
    }

    // 3. If year still not detected, check originalFileName
    if (!detectedYear && originalFileName) {
        const fileYearMatch = originalFileName.match(/(?:\(|\b)(19\d{2}|20\d{2})(?:\)|\b)/);
        if (fileYearMatch) {
            detectedYear = fileYearMatch[1];
        }
    }

    // 4. Clean leftover release format noise from movie title
    rawTitle = rawTitle
        .replace(/\b(?:4k|2160p|1080p|720p|480p|hdrip|web[-_.\s]*dl|webrip|bluray|brrip|dvdrip|x264|x265|hevc|10bit|dual audio|hindi|english|org|dd5\.1|esubs?|full movie)\b.*$/i, "")
        .replace(/[–—|-].*$/, "")
        .replace(/\[.*?\]/g, "")
        .trim();

    const cleanTitle = sanitizeFilename(toTitleCase(rawTitle)) || "Movie";
    const ext = originalFileName && extname(originalFileName) ? extname(originalFileName) : ".mkv";

    const folderName = detectedYear ? `${cleanTitle} (${detectedYear})` : cleanTitle;
    const fileName = detectedYear ? `${cleanTitle} (${detectedYear})${ext}` : `${cleanTitle}${ext}`;

    const folder = join(DOWNLOAD_ROOT, "movies", folderName);
    ensureDir(folder);
    return join(folder, fileName);
}

export function cleanSeriesTitleAndSeason(raw: string, fallbackSeason?: number): { title: string; season: number } {
    let s = (raw || "Series").trim();

    let season = fallbackSeason && fallbackSeason > 0 ? fallbackSeason : 1;
    const seasonMatch = s.match(/[\(\[\{]?\b(?:season|s)\s*[-._]?\s*(\d{1,2})\b[\)\]\}]?/i);
    if (seasonMatch) {
        season = parseInt(seasonMatch[1], 10);
    }

    // Cut off everything from season marker onwards
    if (seasonMatch && seasonMatch.index !== undefined) {
        s = s.substring(0, seasonMatch.index).trim();
    } else {
        // Cut off year if present: (2024) or 2024
        const yearMatch = s.match(/(?:\(|\b)(19\d{2}|20\d{2})(?:\)|\b)/);
        if (yearMatch && yearMatch.index !== undefined) {
            s = s.substring(0, yearMatch.index).trim();
        }
    }

    // Clean release tags, resolutions, brackets, and extra junk
    s = s
        .replace(/\b(?:4k|2160p|1080p|720p|480p|hdrip|ds4k|web[-_.\s]*dl|webrip|bluray|brrip|dvdrip|x264|x265|hevc|10bit|dual audio|hindi|english|org|dd5\.1|esubs?|complete|full\s*season(?:\s*batch)?|all\s*episodes|primevideo|netflix|nf|hotstar|disney|zee5|sonyliv|series|hdhub4u.*)\b.*$/i, "")
        .replace(/[–—|-].*$/, "")
        .replace(/\[.*?\]/g, "")
        .replace(/\(.*?\)/g, "")
        .trim();

    const cleanTitle = sanitizeFilename(toTitleCase(s)) || "Series";
    return { title: cleanTitle, season };
}

export function getSeriesPath(
    title: string,
    season: number,
    episode: number,
    originalFileName?: string
): string {
    const { title: cleanTitle, season: cleanSeason } = cleanSeriesTitleAndSeason(title, season);
    const ext = originalFileName && extname(originalFileName) ? extname(originalFileName) : ".mkv";
    const seasonDir = `Season ${String(cleanSeason).padStart(2, "0")}`;
    const episodeFile = `${cleanTitle} - S${String(cleanSeason).padStart(2, "0")}E${String(episode).padStart(2, "0")}${ext}`;
    const folder = join(DOWNLOAD_ROOT, "shows", cleanTitle, seasonDir);
    ensureDir(folder);
    return join(folder, episodeFile);
}

export function getBatchPackPath(
    title: string,
    season?: number,
    originalFileName?: string
): string {
    const { title: cleanTitle, season: cleanSeason } = cleanSeriesTitleAndSeason(title, season);
    const ext = originalFileName && extname(originalFileName) ? extname(originalFileName) : ".zip";
    const folder = join(DOWNLOAD_ROOT, "shows", cleanTitle);
    ensureDir(folder);
    return join(folder, `${cleanTitle} - Season ${String(cleanSeason).padStart(2, "0")} (Full Season)${ext}`);
}

export function getExistingDownloads(): { movies: string[]; shows: string[] } {
    const moviesDir = join(DOWNLOAD_ROOT, "movies");
    const showsDir = join(DOWNLOAD_ROOT, "shows");

    const movies = existsSync(moviesDir)
        ? readdirSync(moviesDir).filter((f) => statSync(join(moviesDir, f)).isDirectory())
        : [];

    const shows = existsSync(showsDir)
        ? readdirSync(showsDir).filter((f) => statSync(join(showsDir, f)).isDirectory())
        : [];

    return { movies, shows };
}

export function formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatSpeed(bytesPerSec: number): string {
    if (!bytesPerSec || bytesPerSec <= 0) return "0 MB/s";
    return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return "0s";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${h}h ${remM}m`;
}

export interface DownloadProgress {
    percent: number;
    speed: string;
    eta: string;
    downloadedBytes: number;
    totalBytes: number;
    downloadedStr: string;
    totalStr: string;
}

/**
 * Downloads a file via direct HTTP chunk stream with Range resume and multi-server fallback
 */
export async function downloadHttpStream(
    servers: DownloadServer[],
    targetPath: string,
    onProgress?: (progress: DownloadProgress) => void,
    abortSignal?: AbortSignal
): Promise<{ success: boolean; finalPath: string; totalBytes: number; error?: string }> {
    ensureDir(dirname(targetPath));

    if (!servers || servers.length === 0) {
        return { success: false, finalPath: targetPath, totalBytes: 0, error: "No available download servers provided" };
    }

    let lastError = "Download failed";

    for (let srvIdx = 0; srvIdx < servers.length; srvIdx++) {
        const srv = servers[srvIdx];
        const rawUrl = srv.download_url;
        if (!rawUrl || !rawUrl.startsWith("http")) continue;

        const directUrl = normalizeDirectStreamUrl(rawUrl);
        console.log(`[DOWNLOAD-STREAM] Attempting server [${srvIdx + 1}/${servers.length}]: ${srv.server_name} (${srv.server_type}) -> ${directUrl.substring(0, 70)}...`);

        try {
            if (abortSignal?.aborted) {
                return { success: false, finalPath: targetPath, totalBytes: 0, error: "Download aborted by user" };
            }

            // Check existing file on disk for resumption
            let existingBytes = 0;
            if (existsSync(targetPath)) {
                existingBytes = statSync(targetPath).size;
            }

            const headers: Record<string, string> = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "*/*",
            };

            if (directUrl.includes("workers.dev") || directUrl.includes("hubcloud")) {
                headers["Referer"] = "https://gamerxyt.com/";
            }

            if (existingBytes > 0) {
                headers["Range"] = `bytes=${existingBytes}-`;
            }

            const res = await fetch(directUrl, {
                headers,
                signal: abortSignal,
                redirect: "follow"
            });

            // If 416 Range Not Satisfiable, file might already be fully downloaded
            if (res.status === 416 && existingBytes > 0) {
                console.log(`[DOWNLOAD-STREAM] Range 416 received: File already fully downloaded (${formatBytes(existingBytes)})`);
                return { success: true, finalPath: targetPath, totalBytes: existingBytes };
            }

            if (!res.ok && res.status !== 206 && res.status !== 200) {
                throw new Error(`HTTP status ${res.status}: ${res.statusText}`);
            }

            // Check content type - if HTML, it's a captcha or landing page, not the direct stream
            const contentType = (res.headers.get("content-type") || "").toLowerCase();
            if (contentType.includes("text/html") && !res.headers.get("content-disposition")) {
                throw new Error(`Server returned HTML web page instead of media stream`);
            }

            // Calculate total size
            let totalBytes = 0;
            const contentRange = res.headers.get("content-range");
            const contentLength = res.headers.get("content-length");

            if (contentRange) {
                const totalMatch = contentRange.match(/\/(\d+)/);
                if (totalMatch) totalBytes = parseInt(totalMatch[1], 10);
            } else if (contentLength) {
                totalBytes = existingBytes + parseInt(contentLength, 10);
            }

            // If file on disk already matches totalBytes and totalBytes > 0
            if (totalBytes > 0 && existingBytes >= totalBytes) {
                console.log(`[DOWNLOAD-STREAM] Existing file already matches full size: ${formatBytes(totalBytes)}`);
                return { success: true, finalPath: targetPath, totalBytes };
            }

            const writeFlag = (res.status === 206 && existingBytes > 0) ? "a" : "w";
            let downloadedBytes = writeFlag === "a" ? existingBytes : 0;

            const writeStream = createWriteStream(targetPath, { flags: writeFlag });

            let lastSpeedCalcTime = Date.now();
            let bytesSinceLastCalc = 0;
            let currentSpeed = 0;
            let lastBroadcastTime = 0;

            if (!res.body) {
                throw new Error("Response body is empty");
            }

            // Convert Web ReadableStream to Node.js Readable stream
            const nodeReadable = Readable.fromWeb(res.body as any);

            nodeReadable.on("data", (chunk: Buffer) => {
                downloadedBytes += chunk.length;
                bytesSinceLastCalc += chunk.length;

                const now = Date.now();
                const delta = now - lastSpeedCalcTime;

                if (delta >= 1000) {
                    currentSpeed = (bytesSinceLastCalc / delta) * 1000;
                    bytesSinceLastCalc = 0;
                    lastSpeedCalcTime = now;
                }

                if (now - lastBroadcastTime >= 500 && onProgress) {
                    lastBroadcastTime = now;
                    const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
                    const remainingBytes = Math.max(0, totalBytes - downloadedBytes);
                    const etaSeconds = currentSpeed > 0 ? remainingBytes / currentSpeed : 0;

                    onProgress({
                        percent,
                        speed: formatSpeed(currentSpeed),
                        eta: formatEta(etaSeconds),
                        downloadedBytes,
                        totalBytes,
                        downloadedStr: formatBytes(downloadedBytes),
                        totalStr: formatBytes(totalBytes)
                    });
                }
            });

            try {
                await pipeline(nodeReadable, writeStream, { signal: abortSignal });
            } catch (streamErr: any) {
                if (abortSignal?.aborted || streamErr?.name === "AbortError") {
                    try { writeStream.destroy(); } catch {}
                    try { nodeReadable.destroy(); } catch {}
                    return { success: false, finalPath: targetPath, totalBytes: 0, error: "Download aborted by user" };
                }
                throw streamErr;
            }

            // Final progress update
            if (onProgress) {
                onProgress({
                    percent: 100,
                    speed: "0 MB/s",
                    eta: "0s",
                    downloadedBytes: totalBytes || downloadedBytes,
                    totalBytes: totalBytes || downloadedBytes,
                    downloadedStr: formatBytes(totalBytes || downloadedBytes),
                    totalStr: formatBytes(totalBytes || downloadedBytes)
                });
            }

            console.log(`[DOWNLOAD-STREAM] Download completed successfully: ${targetPath} (${formatBytes(downloadedBytes)})`);
            return { success: true, finalPath: targetPath, totalBytes: downloadedBytes };

        } catch (err: any) {
            if (abortSignal?.aborted || err?.name === "AbortError") {
                return { success: false, finalPath: targetPath, totalBytes: 0, error: "Download aborted by user" };
            }
            lastError = err?.message || String(err);
            console.warn(`[DOWNLOAD-STREAM] Server [${srvIdx + 1}] failed (${srv.server_name}): ${lastError}. Attempting next server...`);
        }
    }

    return { success: false, finalPath: targetPath, totalBytes: 0, error: `All ${servers.length} download servers failed. Last error: ${lastError}` };
}

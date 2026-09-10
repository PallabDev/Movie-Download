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

export function getMoviePath(title: string, year: string, originalFileName?: string): string {
    const cleanTitle = sanitizeFilename(toTitleCase(title.replace(/\s*\(\d{4}\).*$/, "")));
    const cleanYear = year && year !== "unknown" ? year : "2024";
    const ext = originalFileName && extname(originalFileName) ? extname(originalFileName) : ".mkv";
    const folder = join(DOWNLOAD_ROOT, "movies", `${cleanTitle} (${cleanYear})`);
    ensureDir(folder);
    return join(folder, `${cleanTitle} (${cleanYear})${ext}`);
}

export function getSeriesPath(
    title: string,
    season: number,
    episode: number,
    originalFileName?: string
): string {
    const cleanTitle = sanitizeFilename(toTitleCase(title));
    const ext = originalFileName && extname(originalFileName) ? extname(originalFileName) : ".mkv";
    const seasonDir = `Season ${String(season).padStart(2, "0")}`;
    const episodeFile = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}-${cleanTitle}${ext}`;
    const folder = join(DOWNLOAD_ROOT, "shows", cleanTitle, seasonDir);
    ensureDir(folder);
    return join(folder, episodeFile);
}

export function getBatchPackPath(
    title: string,
    originalFileName?: string
): string {
    const cleanTitle = sanitizeFilename(toTitleCase(title));
    const ext = originalFileName && extname(originalFileName) ? extname(originalFileName) : ".zip";
    const folder = join(DOWNLOAD_ROOT, "shows", cleanTitle);
    ensureDir(folder);
    return join(folder, `${cleanTitle} (Full Season)${ext}`);
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

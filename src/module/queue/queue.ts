import { db, schema } from "../../common/db/index.js";
import { eq, or } from "drizzle-orm";
import {
    getMoviePath,
    getSeriesPath,
    getBatchPackPath,
    downloadHttpStream,
    formatBytes,
    type DownloadProgress
} from "../download/downloader.js";
import {
    getDownloadLinks,
    selectBest720pQuality,
    sortServersByPriority,
    type DownloadServer
} from "../download/api-client.js";
import { broadcastDownloadProgress, broadcastDownloadComplete } from "../web/ws.js";

export interface DownloadJobData {
    requestId: string;
    type: "movie" | "series";
    title: string;
    year?: string;
    season?: number;
    episode?: number;
    fileSize?: string;
    qualityKey?: string;
    targetUrl?: string;
    downloadUrl?: string;
    servers?: DownloadServer[];
    isBatchPack?: boolean;
    fileName?: string;
    fileSizeBytes?: number;
    // Legacy compatibility fields
    bot?: string;
    btnMsgId?: number;
    buttonText?: string;
    optionIndex?: number;
    page?: number;
    buttonRow?: number;
    buttonCol?: number;
    savedMsgId?: number;
}

export interface Job {
    id: string;
    data: DownloadJobData;
    status: "waiting" | "active" | "paused" | "completed" | "failed" | "cancelled";
    createdAt: Date;
}

const activeJobSignals = new Map<string, { paused: boolean; cancelled: boolean; abortController?: AbortController }>();

class MemoryQueue {
    private jobs: Map<string, Job> = new Map();
    private processor: ((job: Job) => Promise<void>) | null = null;
    private processing = false;

    setProcessor(fn: (job: Job) => Promise<void>) { this.processor = fn; }

    addJob(data: DownloadJobData): Job {
        // 1. If job with same requestId already exists, reuse or update
        const existing = Array.from(this.jobs.values()).find(j => j.data.requestId === data.requestId);
        if (existing) {
            existing.status = "waiting";
            activeJobSignals.set(data.requestId, { paused: false, cancelled: false, abortController: new AbortController() });
            console.log(`[QUEUE] Reusing existing job for "${data.title}" (requestId: ${data.requestId})`);
            setTimeout(() => this.runNext(), 0);
            return existing;
        }

        // 2. Prevent duplicate jobs for the same title and type if already active or waiting in queue
        const duplicate = Array.from(this.jobs.values()).find(j =>
            (j.status === "active" || j.status === "waiting") &&
            j.data.title.toLowerCase().trim() === data.title.toLowerCase().trim() &&
            j.data.type === data.type &&
            j.data.season === data.season &&
            j.data.episode === data.episode
        );
        if (duplicate) {
            console.log(`[QUEUE DEDUP] Ignored duplicate job for "${data.title}" - already ${duplicate.status} (Job ID: ${duplicate.id})`);
            return duplicate;
        }

        const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const job: Job = {
            id,
            data,
            status: "waiting",
            createdAt: new Date(),
        };
        this.jobs.set(id, job);
        activeJobSignals.set(data.requestId, { paused: false, cancelled: false, abortController: new AbortController() });
        console.log(`[QUEUE] Job added: "${data.title}" (${data.type}) [Queue size: ${this.jobs.size}]`);
        setTimeout(() => this.runNext(), 0);
        return job;
    }

    pauseJob(requestId: string): boolean {
        const job = Array.from(this.jobs.values()).find(j => j.data.requestId === requestId);
        const signal = activeJobSignals.get(requestId) || { paused: false, cancelled: false };
        signal.paused = true;
        if (signal.abortController) {
            try { signal.abortController.abort(); } catch {}
        }
        activeJobSignals.set(requestId, signal);
        if (job) job.status = "paused";
        updateDB(requestId, { status: "paused" }).catch(() => {});
        console.log(`[QUEUE] Job paused: "${job?.data.title || requestId}"`);
        return true;
    }

    resumeJob(requestId: string): boolean {
        const job = Array.from(this.jobs.values()).find(j => j.data.requestId === requestId);
        if (!job) return false;
        job.status = "waiting";
        const signal = { paused: false, cancelled: false, abortController: new AbortController() };
        activeJobSignals.set(requestId, signal);
        updateDB(requestId, { status: "queued" }).catch(() => {});
        console.log(`[QUEUE] Job resumed: "${job.data.title}"`);
        setTimeout(() => this.runNext(), 0);
        return true;
    }

    retryJob(requestId: string): boolean {
        const job = Array.from(this.jobs.values()).find(j => j.data.requestId === requestId);
        if (job) {
            job.status = "waiting";
            activeJobSignals.set(requestId, { paused: false, cancelled: false, abortController: new AbortController() });
            updateDB(requestId, { status: "queued", error: null }).catch(() => {});
            console.log(`[QUEUE] Job retrying: "${job.data.title}"`);
            setTimeout(() => this.runNext(), 0);
            return true;
        }
        return false;
    }

    cancelJob(requestId: string): boolean {
        const job = Array.from(this.jobs.values()).find(j => j.data.requestId === requestId);
        const signal = activeJobSignals.get(requestId) || { paused: false, cancelled: false };
        signal.cancelled = true;
        if (signal.abortController) {
            try { signal.abortController.abort(); } catch {}
        }
        activeJobSignals.set(requestId, signal);
        if (job) {
            job.status = "cancelled";
            this.jobs.delete(job.id);
        }
        updateDB(requestId, { status: "cancelled" }).catch(() => {});
        console.log(`[QUEUE] Job cancelled: "${job?.data.title || requestId}"`);
        return true;
    }

    clearFailed(): number {
        let count = 0;
        for (const [k, v] of this.jobs) {
            if (v.status === "failed" || v.status === "cancelled") {
                this.jobs.delete(k);
                count++;
            }
        }
        return count;
    }

    getJob(requestId: string): Job | undefined {
        return Array.from(this.jobs.values()).find(j => j.data.requestId === requestId);
    }

    private async runNext() {
        if (this.processing || !this.processor) return;
        const waiting = Array.from(this.jobs.values()).find((j) => j.status === "waiting");
        if (!waiting) return;
        this.processing = true;
        waiting.status = "active";
        try {
            await this.processor(waiting);
            if (waiting.status === "active") {
                waiting.status = "completed";
            }
        } catch (err) {
            const currentStatus = waiting.status as string;
            if (currentStatus !== "paused" && currentStatus !== "cancelled") {
                waiting.status = "failed";
                console.error(`[QUEUE] Job ${waiting.id} failed:`, err);
            }
        } finally {
            this.processing = false;
            setTimeout(() => this.runNext(), 100);
        }
    }

    getStats() {
        const all = Array.from(this.jobs.values());
        return {
            waiting: all.filter((j) => j.status === "waiting").length,
            active: all.filter((j) => j.status === "active").length,
            paused: all.filter((j) => j.status === "paused").length,
            completed: all.filter((j) => j.status === "completed").length,
            failed: all.filter((j) => j.status === "failed").length,
        };
    }
}

export const downloadQueue = new MemoryQueue();

async function updateDB(requestId: string, updates: Record<string, any>) {
    try {
        await db.update(schema.downloads).set({ ...updates, updatedAt: new Date() }).where(eq(schema.downloads.requestId, requestId));
    } catch (err) {
        console.error("[DB] Update error:", err);
    }
}

/**
 * Backward compatibility stub
 */
export async function secureBotFileToSavedMessages(..._args: any[]): Promise<any> {
    return null;
}

export function createDownloadWorker() {
    console.log("[QUEUE] High-speed HTTP direct download worker initialized");

    // Restore pending downloads from DB on startup
    setTimeout(async () => {
        try {
            const pending = await db.select().from(schema.downloads).where(
                or(eq(schema.downloads.status, "downloading"), eq(schema.downloads.status, "queued"))
            );
            for (const row of pending) {
                console.log(`[QUEUE STARTUP] Restoring pending download for "${row.title}" (ID: ${row.requestId})...`);
                downloadQueue.addJob({
                    requestId: row.requestId,
                    type: (row.type as any) || "movie",
                    title: row.title,
                    year: row.year || undefined,
                    fileSize: row.fileSize || undefined,
                    season: row.season || undefined,
                    episode: row.episode || undefined,
                    fileName: row.title + ".mkv",
                });
            }
        } catch (e: any) {
            console.log(`[QUEUE STARTUP] Pending job restore notice: ${e?.message || e}`);
        }
    }, 2500);

    downloadQueue.setProcessor(async (job) => {
        const data = job.data;

        try {
            console.log(`[WORKER] Starting download job: "${data.title}" (Type: ${data.type})`);
            await updateDB(data.requestId, { status: "downloading", error: null });

            let servers: DownloadServer[] = data.servers || [];

            // If servers not yet resolved but targetUrl exists, resolve direct download links
            if (servers.length === 0 && data.targetUrl) {
                console.log(`[WORKER] Resolving download links from target URL: ${data.targetUrl}`);
                const details = await getDownloadLinks(data.targetUrl);
                const quality = selectBest720pQuality(details);
                if (quality) {
                    if (quality.isEpisodeList && quality.episodes && quality.episodes.length > 0) {
                        const ep = data.episode ? quality.episodes.find(e => e.episodeNum === data.episode) : quality.episodes[0];
                        servers = ep ? ep.servers : quality.episodes[0].servers;
                    } else {
                        servers = quality.servers;
                    }
                }
            }

            // If a single direct downloadUrl was given, format it as a server entry
            if (servers.length === 0 && data.downloadUrl) {
                servers = [{
                    server_name: "Direct CDN Server",
                    server_type: "💾 Direct Fast CDN",
                    download_url: data.downloadUrl,
                    file_size: data.fileSize
                }];
            }

            if (servers.length === 0) {
                throw new Error(`No downloadable servers available for "${data.title}"`);
            }

            // Determine target download file path
            let targetPath: string;
            if (data.type === "series") {
                if (data.isBatchPack) {
                    targetPath = getBatchPackPath(data.title, data.fileName);
                } else {
                    targetPath = getSeriesPath(data.title, data.season || 1, data.episode || 1, data.fileName);
                }
            } else {
                targetPath = getMoviePath(data.title, data.year || "2024", data.fileName);
            }

            console.log(`[WORKER] Downloading to destination: ${targetPath}`);

            const signalInfo = activeJobSignals.get(data.requestId) || { paused: false, cancelled: false };
            const abortController = signalInfo.abortController || new AbortController();
            signalInfo.abortController = abortController;
            activeJobSignals.set(data.requestId, signalInfo);

            let lastDbUpdateTime = 0;

            const dlResult = await downloadHttpStream(
                servers,
                targetPath,
                (prog: DownloadProgress) => {
                    const now = Date.now();
                    // Update database every 3 seconds to avoid DB write thrashing
                    if (now - lastDbUpdateTime >= 3000) {
                        lastDbUpdateTime = now;
                        updateDB(data.requestId, {
                            progress: prog.percent,
                            speed: prog.speed,
                            eta: prog.eta,
                            fileSize: prog.totalStr,
                            downloadPath: targetPath,
                        }).catch(() => {});
                    }

                    // Broadcast real-time WebSocket progress
                    broadcastDownloadProgress(data.requestId, {
                        title: data.title,
                        percent: prog.percent,
                        speed: prog.speed,
                        eta: prog.eta,
                        downloaded: prog.downloadedStr,
                        total: prog.totalStr,
                        status: "downloading"
                    });
                },
                abortController.signal
            );

            if (!dlResult.success) {
                if (signalInfo.paused || signalInfo.cancelled) {
                    console.log(`[WORKER] Job ${signalInfo.paused ? "paused" : "cancelled"}: "${data.title}"`);
                    return;
                }
                throw new Error(dlResult.error || "Streaming download failed");
            }

            // Mark completed in database
            await updateDB(data.requestId, {
                status: "completed",
                progress: 100,
                speed: "0 MB/s",
                eta: "0s",
                downloadPath: targetPath,
                fileSize: formatBytes(dlResult.totalBytes),
                error: null
            });

            broadcastDownloadComplete(data.requestId, {
                title: data.title,
                type: data.type,
                path: targetPath,
                success: true
            });

            console.log(`[WORKER] Successfully completed download for "${data.title}" -> ${targetPath}`);

        } catch (err: any) {
            const errorMsg = err?.message || String(err);
            console.error(`[WORKER] Job error for "${data.title}":`, errorMsg);

            await updateDB(data.requestId, {
                status: "failed",
                error: errorMsg
            });

            broadcastDownloadComplete(data.requestId, {
                title: data.title,
                type: data.type,
                path: "",
                success: false,
                error: errorMsg
            });
        }
    });
}

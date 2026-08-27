import { getHarness } from "../../../command/harness.js";
import client from "../../module/bot/bot.js";
import { env } from "../../common/utils/env.js";
import { db, schema } from "../../common/db/index.js";
import { eq } from "drizzle-orm";
import { getMoviePath, getSeriesPath } from "../../module/download/downloader.js";
import { checkMovieExists, checkSeriesExists } from "../../common/jellyfin/client.js";
import { broadcastDownloadProgress, broadcastDownloadComplete } from "../web/ws.js";
import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

export interface DownloadJobData {
    requestId: string;
    input: string;
    year?: string;
    type?: "movie" | "series";
    title?: string;
    season?: number;
    episode?: number;
    totalEpisodes?: number;
    filename?: string;
    downloadPath?: string;
    status: "pending" | "analyzing" | "searching" | "clicking" | "downloading" | "completed" | "failed" | "skipped";
}

interface Job {
    id: string;
    data: DownloadJobData;
    status: "waiting" | "active" | "completed" | "failed";
    createdAt: Date;
}

type ProcessorFn = (job: Job) => Promise<void>;

class MemoryQueue {
    private jobs: Map<string, Job> = new Map();
    private processor: ProcessorFn | null = null;
    private processing = false;

    setProcessor(fn: ProcessorFn) { this.processor = fn; }

    async add(name: string, data: DownloadJobData): Promise<Job> {
        const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job: Job = { id, data, status: "waiting", createdAt: new Date() };
        this.jobs.set(id, job);
        console.log(`[QUEUE] Job ${id} added: "${data.input}"`);
        setTimeout(() => this.runNext(), 0);
        return job;
    }

    private async runNext() {
        if (this.processing || !this.processor) return;
        const waiting = Array.from(this.jobs.values()).find((j) => j.status === "waiting");
        if (!waiting) return;
        this.processing = true;
        waiting.status = "active";
        try {
            await this.processor(waiting);
            waiting.status = "completed";
            console.log(`[QUEUE] Job ${waiting.id} completed`);
        } catch (err) {
            waiting.status = "failed";
            console.error(`[QUEUE] Job ${waiting.id} failed:`, err);
            getHarness().logError(`[QUEUE] Job ${waiting.id}: ${err}`);
        } finally {
            this.processing = false;
            setTimeout(() => this.runNext(), 100);
        }
    }

    getJob(id: string) { return this.jobs.get(id); }
    getStats() {
        const all = Array.from(this.jobs.values());
        return {
            waiting: all.filter((j) => j.status === "waiting").length,
            active: all.filter((j) => j.status === "active").length,
            completed: all.filter((j) => j.status === "completed").length,
            failed: all.filter((j) => j.status === "failed").length,
        };
    }
}

export const downloadQueue = new MemoryQueue();

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function extractSizeMB(text: string): number {
    const match = text.match(/\[([\d.]+)\s*(GB|MB|KB)\]/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit === "GB") return val * 1024;
    if (unit === "MB") return val;
    return val / 1024;
}

function findBestButton(buttons: string[][], type: "movie" | "series"): string | null {
    const candidates: { text: string; sizeMB: number; is720p: boolean }[] = [];
    for (const row of buttons) {
        for (const btn of row) {
            const lower = btn.toLowerCase();
            const sizeMB = extractSizeMB(btn);
            const is720p = lower.includes("720p");
            const isSubtitle = lower.includes("srt") || lower.includes("sub");
            if (isSubtitle) continue;
            if (sizeMB < 10 && !lower.includes("mp4") && !lower.includes("mkv")) continue;
            candidates.push({ text: btn, sizeMB, is720p });
        }
    }
    if (candidates.length === 0) return null;

    let filtered = candidates.filter((c) => c.is720p);
    if (type === "movie") filtered = filtered.filter((c) => c.sizeMB >= 500 && c.sizeMB <= 2048);
    else filtered = filtered.filter((c) => c.sizeMB >= 30 && c.sizeMB <= 1024);

    if (filtered.length === 0) filtered = candidates.filter((c) => c.is720p);
    if (filtered.length === 0) filtered = candidates.sort((a, b) => a.sizeMB - b.sizeMB).slice(0, 3);

    const idealMB = type === "movie" ? 1000 : 200;
    filtered.sort((a, b) => Math.abs(a.sizeMB - idealMB) - Math.abs(b.sizeMB - idealMB));
    console.log(`[PICK] Best: "${filtered[0].text}" (${filtered[0].sizeMB.toFixed(0)} MB)`);
    return filtered[0].text;
}

async function updateDB(requestId: string, updates: Record<string, any>) {
    try {
        await db.update(schema.downloads).set({ ...updates, updatedAt: new Date() }).where(eq(schema.downloads.requestId, requestId));
    } catch (err) {
        console.error("[DB] Update error:", err);
    }
}

async function sendToBot(botUsername: string, message: string) {
    console.log(`[TG] Sending to ${botUsername}: ${message}`);
    const sent = await client.sendMessage(botUsername, { message });
    await sleep(4000);

    try {
        const messages = await client.getMessages(botUsername, { limit: 10 });
        return { sentId: sent.id, messages };
    } catch {
        return { sentId: sent.id, messages: [] };
    }
}

async function findButtonMessage(botUsername: string, sentId: number) {
    // Try immediately
    let messages = await client.getMessages(botUsername, { limit: 10 });
    for (const msg of messages) {
        if (msg.id === sentId) continue;
        const buttons = await msg.getButtons();
        if (buttons && buttons.length > 0) return msg;
    }

    // Retry once
    await sleep(3000);
    messages = await client.getMessages(botUsername, { limit: 10 });
    for (const msg of messages) {
        if (msg.id === sentId) continue;
        const buttons = await msg.getButtons();
        if (buttons && buttons.length > 0) return msg;
    }

    return null;
}

async function downloadFileWithResume(
    msg: any,
    downloadPath: string,
    totalSize: number,
    requestId: string,
    title: string
): Promise<boolean> {
    const MAX_RETRIES = 5;
    let downloadedBytes = 0;

    if (existsSync(downloadPath)) {
        downloadedBytes = statSync(downloadPath).size;
        console.log(`[DL] Resuming from ${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB`);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`[DL] Attempt ${attempt}/${MAX_RETRIES}`);
            const startTime = Date.now();
            let lastBroadcast = 0;
            const stream = await open(downloadPath, downloadedBytes > 0 ? "r+" : "w");
            const fileHandle = stream;

            try {
                for await (const chunk of client.iterDownload(msg, {
                    offset: downloadedBytes,
                    requestSize: 1024 * 1024,
                })) {
                    await fileHandle.write(chunk, 0, chunk.length, downloadedBytes);
                    downloadedBytes += chunk.length;

                    const now = Date.now();
                    if (now - lastBroadcast >= 1000) {
                        lastBroadcast = now;
                        const pct = totalSize > 0 ? Math.min((downloadedBytes / totalSize) * 100, 100) : 0;
                        const elapsed = (now - startTime) / 1000;
                        const speed = elapsed > 0 ? downloadedBytes / elapsed : 0;
                        const speedMB = (speed / (1024 * 1024)).toFixed(1);
                        const remaining = speed > 0 ? (totalSize - downloadedBytes) / speed : 0;
                        const etaMin = Math.floor(remaining / 60);
                        const etaSec = Math.floor(remaining % 60);

                        const barLen = 30;
                        const filled = Math.round((pct / 100) * barLen);
                        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
                        const dlMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
                        const totMB = (totalSize / (1024 * 1024)).toFixed(0);

                        process.stdout.write(
                            `\r[DL] ${bar} ${pct.toFixed(1)}% | ${dlMB}/${totMB} MB | ${speedMB} MB/s | ETA ${etaMin}m ${etaSec}s   `
                        );

                        // Update DB & broadcast
                        await updateDB(requestId, {
                            progress: Math.round(pct),
                            speed: `${speedMB} MB/s`,
                            eta: `${etaMin}m ${etaSec}s`,
                        });

                        broadcastDownloadProgress(requestId, {
                            status: "downloading",
                            title,
                            percent: Math.round(pct),
                            speed: `${speedMB} MB/s`,
                            eta: `${etaMin}m ${etaSec}s`,
                            downloaded: `${dlMB} MB`,
                            total: `${totMB} MB`,
                        });
                    }
                }
            } finally {
                await fileHandle.close();
            }

            process.stdout.write("\n");
            console.log(`[DL] Complete: ${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB`);
            return true;

        } catch (dlErr) {
            process.stdout.write("\n");
            console.error(`[DL] Error (attempt ${attempt}):`, dlErr instanceof Error ? dlErr.message : dlErr);
            if (attempt < MAX_RETRIES) {
                const waitSec = attempt * 5;
                console.log(`[DL] Retrying in ${waitSec}s from ${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB...`);
                await sleep(waitSec * 1000);
            }
        }
    }
    return false;
}

export function createDownloadWorker() {
    console.log("[QUEUE] Worker initialized");

    downloadQueue.setProcessor(async (job) => {
        const harness = getHarness();
        let data = job.data;

        try {
            // STEP 1: AI analysis
            if (data.status === "pending") {
                console.log(`[WORKER] Step 1: Analyzing "${data.input}"`);
                await updateDB(data.requestId, { status: "analyzing" });

                const aiResult = await harness.processRequest(
                    `User wants: "${data.input}"${data.year ? ` from year ${data.year}` : ""}. ` +
                    `Determine if this is a movie or series. Clean the name to Title Case with year. ` +
                    `For series, how many seasons. Reply ONLY JSON: ` +
                    `{"action":"search_movie","title":"...","year":"..."} or ` +
                    `{"action":"search_series","title":"...","seasons":N}`
                );

                let parsed: Record<string, unknown> | null = null;
                try { const m = aiResult.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch { }

                if (parsed && parsed.action) {
                    data = {
                        ...data,
                        status: "searching",
                        type: parsed.action === "search_series" ? "series" : "movie",
                        title: (parsed.title as string) || data.input,
                        year: (parsed.year as string) || data.year || "",
                        season: 1,
                        totalEpisodes: (parsed.seasons as number) || 1,
                    };
                    job.data = data;
                    console.log(`[WORKER] ${data.type}: "${data.title}" (${data.year})`);
                    await updateDB(data.requestId, { type: data.type, title: data.title, year: data.year });
                }
            }

            // STEP 1.5: Check Jellyfin
            if (data.type === "movie" && data.title) {
                const jf = await checkMovieExists(data.title, data.year);
                if (jf.exists) {
                    console.log(`[JELLYFIN] "${data.title}" already in library, skipping`);
                    await updateDB(data.requestId, { status: "skipped", jellyfinExists: true });
                    broadcastDownloadComplete(data.requestId, {
                        title: data.title, type: "movie", path: "", success: true, error: "Already in Jellyfin"
                    });
                    return;
                }
            } else if (data.type === "series" && data.title) {
                const jf = await checkSeriesExists(data.title);
                if (jf.exists) {
                    console.log(`[JELLYFIN] "${data.title}" already in library, skipping`);
                    await updateDB(data.requestId, { status: "skipped", jellyfinExists: true });
                    broadcastDownloadComplete(data.requestId, {
                        title: data.title, type: "series", path: "", success: true, error: "Already in Jellyfin"
                    });
                    return;
                }
            }

            // STEP 2: Search bot
            if (data.status === "searching" && data.type) {
                const bot = data.type === "movie" ? env.MOVIE_BOT : env.SERIES_BOT;
                const query = data.type === "movie"
                    ? `${data.title} ${data.year}`.trim()
                    : `${data.title} S${String(data.season || 1).padStart(2, "0")}`;

                console.log(`[WORKER] Step 2: Searching "${query}" via ${bot}`);
                await updateDB(data.requestId, { status: "searching" });

                const { sentId } = await sendToBot(bot, query);
                const btnMsg = await findButtonMessage(bot, sentId);

                if (!btnMsg) {
                    throw new Error("Bot did not respond with inline buttons");
                }

                // STEP 3: Pick and click
                const buttons = (await btnMsg.getButtons())!;
                const buttonTexts = buttons.map((row: any) => row.map((b: any) => b.text || ""));
                console.log(`[WORKER] Found ${buttonTexts.length} rows of buttons`);

                const bestText = findBestButton(buttonTexts, data.type);
                if (!bestText) throw new Error("No suitable 720p file found");

                console.log(`[WORKER] Step 3: Clicking "${bestText}"`);
                await updateDB(data.requestId, { status: "clicking" });

                const sizeMatch = bestText.match(/\[([\d.]+)\s*(GB|MB)\]/i);
                const fileSize = sizeMatch ? sizeMatch[1] + " " + sizeMatch[2].toUpperCase() : null;

                await btnMsg.click({ text: bestText });

                // STEP 4: Wait for file
                console.log(`[WORKER] Step 4: Waiting for file...`);
                await updateDB(data.requestId, { status: "downloading", fileSize });

                let fileReceived = false;
                for (let attempt = 0; attempt < 20; attempt++) {
                    await sleep(3000);
                    const recent = await client.getMessages(bot, { limit: 5 });

                    for (const msg of recent) {
                        if (msg.id <= btnMsg.id) continue;

                        if (msg.document || msg.photo) {
                            let fileName = "download.mp4";
                            let totalSize = 0;

                            if (msg.document) {
                                totalSize = Number(msg.document.size) || 0;
                                const fnameAttr = msg.document.attributes?.find(
                                    (a: any) => a.className === "DocumentAttributeFilename"
                                ) as any;
                                if (fnameAttr?.fileName) fileName = fnameAttr.fileName;
                            }

                            console.log(`[TG] File: "${fileName}" (${(totalSize / (1024 * 1024)).toFixed(0)} MB)`);

                            if (data.type === "movie") {
                                data.downloadPath = getMoviePath(data.title || data.input, data.year || "unknown");
                            } else {
                                data.downloadPath = getSeriesPath(
                                    data.title || data.input, data.season || 1, data.episode || 1
                                );
                            }
                            data.filename = fileName;
                            job.data = data;

                            const success = await downloadFileWithResume(
                                msg, data.downloadPath, totalSize, data.requestId, data.title || data.input
                            );

                            if (success) {
                                await updateDB(data.requestId, { status: "completed", downloadPath: data.downloadPath });
                                broadcastDownloadComplete(data.requestId, {
                                    title: data.title || data.input,
                                    type: data.type || "movie",
                                    path: data.downloadPath,
                                    success: true,
                                });
                            } else {
                                await updateDB(data.requestId, { status: "failed", error: "Download failed after retries" });
                                broadcastDownloadComplete(data.requestId, {
                                    title: data.title || data.input,
                                    type: data.type || "movie",
                                    path: "",
                                    success: false,
                                    error: "Download failed after retries",
                                });
                            }

                            fileReceived = true;
                            break;
                        }
                    }
                    if (fileReceived) break;
                    if (attempt % 5 === 0) console.log(`[WORKER] Waiting for file... ${attempt * 3}s`);
                }

                if (!fileReceived) {
                    await updateDB(data.requestId, { status: "failed", error: "File not received" });
                    throw new Error("File not received from bot");
                }
            }

            harness.logActivity(`[WORKER] Done: ${data.title || data.input}`);
            console.log(`[WORKER] Job ${job.id} finished`);

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[WORKER] Error:`, errMsg);
            await updateDB(data.requestId, { status: "failed", error: errMsg });
            broadcastDownloadComplete(data.requestId, {
                title: data.title || data.input, type: data.type || "movie", path: "", success: false, error: errMsg,
            });
            harness.logError(`[WORKER] ${job.id}: ${errMsg}`);
            throw error;
        }
    });

    return { close: async () => {} };
}

export async function addDownloadJob(data: DownloadJobData) {
    return downloadQueue.add("download", data);
}

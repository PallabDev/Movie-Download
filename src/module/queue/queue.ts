import client from "../../module/bot/bot.js";
import { db, schema } from "../../common/db/index.js";
import { eq } from "drizzle-orm";
import { getMoviePath, getSeriesPath } from "../../module/download/downloader.js";
import { broadcastDownloadProgress, broadcastDownloadComplete } from "../web/ws.js";
import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

export interface DownloadJobData {
    requestId: string;
    bot: string;
    btnMsgId: number;
    type: "movie" | "series";
    title: string;
    year?: string;
    fileSize?: string;
    buttonText?: string;
}

interface Job {
    id: string;
    data: DownloadJobData;
    status: "waiting" | "active" | "completed" | "failed";
    createdAt: Date;
}

class MemoryQueue {
    private jobs: Map<string, Job> = new Map();
    private processor: ((job: Job) => Promise<void>) | null = null;
    private processing = false;

    setProcessor(fn: (job: Job) => Promise<void>) { this.processor = fn; }

    addJob(data: DownloadJobData): Job {
        const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job: Job = { id, data, status: "waiting", createdAt: new Date() };
        this.jobs.set(id, job);
        console.log(`[QUEUE] Job ${id} added: "${data.title}" (${data.type})`);
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
            completed: all.filter((j) => j.status === "completed").length,
            failed: all.filter((j) => j.status === "failed").length,
        };
    }
}

export const downloadQueue = new MemoryQueue();

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function updateDB(requestId: string, updates: Record<string, any>) {
    try {
        await db.update(schema.downloads).set({ ...updates, updatedAt: new Date() }).where(eq(schema.downloads.requestId, requestId));
    } catch (err) {
        console.error("[DB] Update error:", err);
    }
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
                    requestSize: 5 * 1024 * 1024,
                })) {
                    await fileHandle.write(chunk, 0, chunk.length, downloadedBytes);
                    downloadedBytes += chunk.length;

                    const now = Date.now();
                    if (now - lastBroadcast >= 3000) {
                        lastBroadcast = now;
                        const pct = totalSize > 0 ? Math.min((downloadedBytes / totalSize) * 100, 100) : 0;
                        const elapsed = (now - startTime) / 1000;
                        const speed = elapsed > 0 ? downloadedBytes / elapsed : 0;
                        const speedMB = (speed / (1024 * 1024)).toFixed(1);
                        const remaining = speed > 0 ? (totalSize - downloadedBytes) / speed : 0;
                        const etaMin = Math.floor(remaining / 60);
                        const etaSec = Math.floor(remaining % 60);

                        const dlMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
                        const totMB = (totalSize / (1024 * 1024)).toFixed(0);

                        process.stdout.write(
                            `\r[DL] ${pct.toFixed(1)}% | ${dlMB}/${totMB} MB | ${speedMB} MB/s | ETA ${etaMin}m ${etaSec}s   `
                        );

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
        let data = job.data;

        try {
            // Step 1: Get the button message from the bot
            console.log(`[WORKER] Fetching button message ${data.btnMsgId} from @${data.bot}`);
            const messages = await client.getMessages(data.bot, { limit: 10 });
            let btnMsg: any = null;
            for (const msg of messages) {
                if (msg.id === data.btnMsgId) {
                    btnMsg = msg;
                    break;
                }
            }

            if (!btnMsg) {
                throw new Error("Button message not found in bot chat");
            }

            const buttons = await btnMsg.getButtons();
            if (!buttons) throw new Error("No buttons found on message");

            // Step 2: Click the button if buttonText is provided (bulk download)
            if (data.buttonText) {
                console.log(`[WORKER] Clicking button: "${data.buttonText.substring(0, 50)}"`);
                await btnMsg.click({ text: data.buttonText });
                await sleep(2000);
            }

            // Step 3: Wait for the file
            console.log(`[WORKER] Waiting for file from @${data.bot}...`);
            await updateDB(data.requestId, { status: "downloading" });

            let fileReceived = false;
            for (let attempt = 0; attempt < 30; attempt++) {
                await sleep(3000);
                const recent = await client.getMessages(data.bot, { limit: 5 });

                for (const msg of recent) {
                    if (msg.id <= data.btnMsgId) continue;

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

                        let downloadPath: string;
                        if (data.type === "movie") {
                            downloadPath = getMoviePath(data.title, data.year || "unknown");
                        } else {
                            downloadPath = getSeriesPath(data.title, 1, 1);
                        }

                        const success = await downloadFileWithResume(
                            msg, downloadPath, totalSize, data.requestId, data.title
                        );

                        if (success) {
                            await updateDB(data.requestId, { status: "completed", downloadPath });
                            broadcastDownloadComplete(data.requestId, {
                                title: data.title,
                                type: data.type,
                                path: downloadPath,
                                success: true,
                            });
                        } else {
                            await updateDB(data.requestId, { status: "failed", error: "Download failed after retries" });
                            broadcastDownloadComplete(data.requestId, {
                                title: data.title,
                                type: data.type,
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
                await updateDB(data.requestId, { status: "failed", error: "File not received from bot" });
                broadcastDownloadComplete(data.requestId, {
                    title: data.title,
                    type: data.type,
                    path: "",
                    success: false,
                    error: "File not received from bot",
                });
                throw new Error("File not received from bot");
            }

            console.log(`[WORKER] Job ${job.id} finished`);

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[WORKER] Error:`, errMsg);
            await updateDB(data.requestId, { status: "failed", error: errMsg });
            broadcastDownloadComplete(data.requestId, {
                title: data.title,
                type: data.type,
                path: "",
                success: false,
                error: errMsg,
            });
            throw error;
        }
    });
}

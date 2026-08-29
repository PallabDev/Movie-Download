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

function parseSizeMB(text: string): number {
    const match = text.match(/\[([\d.]+)\s*(GB|MB|KB)\]/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit === "GB") return val * 1024;
    if (unit === "MB") return val;
    return val / 1024;
}

function isInvalidNonVideo(text: string): boolean {
    const lower = text.toLowerCase();
    if (
        lower.includes(".srt") ||
        lower.includes(" srt") ||
        lower.includes("[srt]") ||
        lower.includes("subtitle") ||
        lower.includes("sub") ||
        lower.includes("sample") ||
        lower.includes("trailer") ||
        lower.includes("next") ||
        lower.includes("prev") ||
        lower.includes("page") ||
        lower.includes("back") ||
        lower.includes("close")
    ) {
        return true;
    }
    if (/\[\s*[\d.]+\s*kb\s*\]/i.test(text)) {
        return true;
    }
    const size = parseSizeMB(text);
    if (size > 0 && size < 50) {
        return true; // Any video release less than 50MB is almost certainly a subtitle/sample
    }
    return false;
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
                    if (now - lastBroadcast >= 2000) {
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
                const waitSec = attempt * 4;
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
        const data = job.data;
        const targetBot = data.bot || (data.type === "movie" ? "ProSearchM11Bot" : "ProSearchY11Bot");

        try {
            console.log(`[WORKER] Starting job: "${data.title}" via @${targetBot}`);
            await updateDB(data.requestId, { status: "downloading" });

            let btnMsg: any = null;

            // Step 1: Try locating the original button message
            if (data.btnMsgId && data.btnMsgId > 0) {
                const messages = await client.getMessages(targetBot, { limit: 20 });
                for (const msg of messages) {
                    if (msg.id === data.btnMsgId) {
                        const buttons = await msg.getButtons();
                        if (buttons && buttons.length > 0) {
                            btnMsg = msg;
                            break;
                        }
                    }
                }
            }

            // Step 2: Self-healing bot search if button message not found
            if (!btnMsg) {
                const searchQuery = data.title.replace(/\s*\(\d{4}\).*$/, "").trim();
                console.log(`[WORKER] Querying @${targetBot} directly for: "${searchQuery}"`);
                const sent = await client.sendMessage(targetBot, { message: searchQuery });
                await sleep(3500);

                for (let attempt = 0; attempt < 3; attempt++) {
                    const messages = await client.getMessages(targetBot, { limit: 10 });
                    for (const msg of messages) {
                        if (msg.id === sent.id) continue;
                        const buttons = await msg.getButtons();
                        if (buttons && buttons.length > 0) {
                            btnMsg = msg;
                            break;
                        }
                    }
                    if (btnMsg) break;
                    await sleep(2000);
                }
            }

            if (!btnMsg) {
                throw new Error(`No buttons returned by @${targetBot} for "${data.title}"`);
            }

            // Step 3: Find and click the target video button
            const buttons = (await btnMsg.getButtons())!;
            let targetRow = -1;
            let targetCol = -1;
            let targetBtnText = "";

            const epMatch = data.title.match(/S(\d+)E(\d+)/i);
            const epTag = epMatch ? `s${epMatch[1].padStart(2, "0")}e${epMatch[2].padStart(2, "0")}` : "";

            // 1. Try matching specified buttonText (excluding subtitles / non-video)
            if (data.buttonText) {
                const bLower = data.buttonText.toLowerCase();
                for (let r = 0; r < buttons.length; r++) {
                    for (let c = 0; c < buttons[r].length; c++) {
                        const btn = buttons[r][c] as any;
                        const text = btn.text || "";
                        if (isInvalidNonVideo(text)) continue;

                        if (text.toLowerCase().includes(bLower) || bLower.includes(text.toLowerCase().slice(0, 15))) {
                            targetRow = r;
                            targetCol = c;
                            targetBtnText = btn.text;
                            break;
                        }
                    }
                    if (targetRow >= 0) break;
                }
            }

            // 2. Try episode tag match for series
            if (targetRow < 0 && epTag) {
                for (let r = 0; r < buttons.length; r++) {
                    for (let c = 0; c < buttons[r].length; c++) {
                        const btn = buttons[r][c] as any;
                        const text = (btn.text || "").toLowerCase();
                        if (isInvalidNonVideo(btn.text || "")) continue;

                        if (text.includes(`[${epTag}]`) || text.includes(epTag)) {
                            targetRow = r;
                            targetCol = c;
                            targetBtnText = btn.text;
                            break;
                        }
                    }
                    if (targetRow >= 0) break;
                }
            }

            // 3. Try quality-based match (720p preferred, then 1080p, then 480p)
            if (targetRow < 0) {
                const want1080 = (data.buttonText || "").toLowerCase().includes("1080");
                const want480 = (data.buttonText || "").toLowerCase().includes("480");

                for (let r = 0; r < buttons.length; r++) {
                    for (let c = 0; c < buttons[r].length; c++) {
                        const btn = buttons[r][c] as any;
                        const text = (btn.text || "").toLowerCase();
                        if (isInvalidNonVideo(btn.text || "")) continue;

                        if (want1080 && text.includes("1080p")) {
                            targetRow = r; targetCol = c; targetBtnText = btn.text; break;
                        } else if (want480 && text.includes("480p")) {
                            targetRow = r; targetCol = c; targetBtnText = btn.text; break;
                        } else if (!want1080 && !want480 && text.includes("720p")) {
                            targetRow = r; targetCol = c; targetBtnText = btn.text; break;
                        }
                    }
                    if (targetRow >= 0) break;
                }
            }

            // 4. Fallback: First valid video button with size >= 100MB
            if (targetRow < 0) {
                for (let r = 0; r < buttons.length; r++) {
                    for (let c = 0; c < buttons[r].length; c++) {
                        const btn = buttons[r][c] as any;
                        if (isInvalidNonVideo(btn.text || "")) continue;
                        targetRow = r;
                        targetCol = c;
                        targetBtnText = btn.text;
                        break;
                    }
                    if (targetRow >= 0) break;
                }
            }

            if (targetRow < 0) {
                throw new Error(`Could not find a downloadable video release button on @${targetBot}`);
            }

            console.log(`[WORKER] Clicking verified video button [${targetRow}, ${targetCol}]: "${targetBtnText}"`);
            const clickTriggerTime = Date.now();
            await btnMsg.click(targetRow, targetCol);
            await sleep(2000);

            // Step 4: Wait for the file document to be delivered by the bot
            console.log(`[WORKER] Waiting for video document from @${targetBot}...`);
            let fileReceived = false;

            for (let attempt = 0; attempt < 40; attempt++) {
                await sleep(2500);
                const recent = await client.getMessages(targetBot, { limit: 12 });

                for (const msg of recent) {
                    if (msg.date && msg.date * 1000 < clickTriggerTime - 5000) continue;

                    if (msg.document || msg.photo) {
                        let fileName = "video.mp4";
                        let totalSize = 0;

                        if (msg.document) {
                            totalSize = Number(msg.document.size) || 0;
                            const fnameAttr = msg.document.attributes?.find(
                                (a: any) => a.className === "DocumentAttributeFilename"
                            ) as any;
                            if (fnameAttr?.fileName) fileName = fnameAttr.fileName;

                            const mime = msg.document.mimeType || "";

                            // Strict check: Skip subtitles and tiny non-video files
                            if (
                                fileName.toLowerCase().endsWith(".srt") ||
                                fileName.toLowerCase().endsWith(".vtt") ||
                                fileName.toLowerCase().endsWith(".sub") ||
                                fileName.toLowerCase().endsWith(".txt") ||
                                mime.includes("subrip") ||
                                mime.includes("text") ||
                                totalSize < 20 * 1024 * 1024 // Subtitles/samples are < 20 MB
                            ) {
                                console.log(`[WORKER] Skipped subtitle/non-video document: "${fileName}" (${(totalSize / 1024).toFixed(0)} KB)`);
                                continue;
                            }
                        }

                        console.log(`[TG] Received Media Video: "${fileName}" (${(totalSize / (1024 * 1024)).toFixed(0)} MB)`);

                        let downloadPath: string;
                        if (data.type === "movie") {
                            downloadPath = getMoviePath(data.title, data.year || "unknown", fileName);
                        } else {
                            const m = data.title.match(/^(.*?)\s*S(\d+)E(\d+)/i);
                            if (m) {
                                const baseTitle = m[1].trim();
                                const s = parseInt(m[2]);
                                const e = parseInt(m[3]);
                                downloadPath = getSeriesPath(baseTitle, s, e, fileName);
                            } else {
                                downloadPath = getSeriesPath(data.title, 1, 1, fileName);
                            }
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
            }

            if (!fileReceived) {
                await updateDB(data.requestId, { status: "failed", error: "Video file delivery timed out from bot" });
                broadcastDownloadComplete(data.requestId, {
                    title: data.title,
                    type: data.type,
                    path: "",
                    success: false,
                    error: "Video file delivery timed out from bot",
                });
                throw new Error("Video file delivery timed out from bot");
            }

            console.log(`[WORKER] Job completed successfully: "${data.title}"`);

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`[WORKER] Job failed:`, errMsg);
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

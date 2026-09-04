import client from "../../module/bot/bot.js";
import { Api, utils } from "teleproto";
import bigInt from "big-integer";
import { db, schema } from "../../common/db/index.js";
import { eq } from "drizzle-orm";
import { getMoviePath, getSeriesPath } from "../../module/download/downloader.js";
import { broadcastDownloadProgress, broadcastDownloadComplete } from "../web/ws.js";
import { existsSync, statSync, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";

export interface DownloadJobData {
    requestId: string;
    bot: string;
    btnMsgId: number;
    type: "movie" | "series";
    title: string;
    year?: string;
    season?: number;
    episode?: number;
    fileSize?: string;
    buttonText?: string;
    optionIndex?: number;
    page?: number;
    buttonRow?: number;
    buttonCol?: number;
    savedMsgId?: number;
    fileName?: string;
    fileSizeBytes?: number;
}

export interface Job {
    id: string;
    data: DownloadJobData;
    status: "waiting" | "active" | "paused" | "completed" | "failed" | "cancelled";
    createdAt: Date;
}

const activeJobSignals = new Map<string, { paused: boolean; cancelled: boolean }>();

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
            existing.data = data;
            activeJobSignals.set(data.requestId, { paused: false, cancelled: false });
            setTimeout(() => this.runNext(), 0);
            return existing;
        }

        // 2. Prevent duplicate jobs for the same title and type if already active or waiting in queue
        const duplicate = Array.from(this.jobs.values()).find(j =>
            (j.status === "active" || j.status === "waiting") &&
            j.data.title.toLowerCase().trim() === data.title.toLowerCase().trim() &&
            j.data.type === data.type
        );
        if (duplicate) {
            console.log(`[QUEUE DEDUP] Ignored duplicate job for "${data.title}" - already ${duplicate.status} (Job ID: ${duplicate.id})`);
            return duplicate;
        }

        const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job: Job = { id, data, status: "waiting", createdAt: new Date() };
        this.jobs.set(id, job);
        activeJobSignals.set(data.requestId, { paused: false, cancelled: false });
        console.log(`[QUEUE] Job ${id} added: "${data.title}" (${data.type})`);
        setTimeout(() => this.runNext(), 0);
        return job;
    }

    pauseJob(requestId: string): boolean {
        const job = Array.from(this.jobs.values()).find(j => j.data.requestId === requestId);
        if (!job) return false;
        job.status = "paused";
        const signal = activeJobSignals.get(requestId) || { paused: false, cancelled: false };
        signal.paused = true;
        activeJobSignals.set(requestId, signal);
        updateDB(requestId, { status: "paused" }).catch(() => {});
        console.log(`[QUEUE] Job paused: "${job.data.title}"`);
        return true;
    }

    resumeJob(requestId: string): boolean {
        const job = Array.from(this.jobs.values()).find(j => j.data.requestId === requestId);
        if (!job) return false;
        job.status = "waiting";
        const signal = activeJobSignals.get(requestId) || { paused: false, cancelled: false };
        signal.paused = false;
        activeJobSignals.set(requestId, signal);
        updateDB(requestId, { status: "queued" }).catch(() => {});
        console.log(`[QUEUE] Job resumed: "${job.data.title}"`);
        setTimeout(() => this.runNext(), 0);
        return true;
    }

    retryJob(requestId: string): boolean {
        let job = Array.from(this.jobs.values()).find(j => j.data.requestId === requestId);
        if (job) {
            job.status = "waiting";
            activeJobSignals.set(requestId, { paused: false, cancelled: false });
            updateDB(requestId, { status: "queued", error: null }).catch(() => {});
            console.log(`[QUEUE] Job retrying: "${job.data.title}"`);
            setTimeout(() => this.runNext(), 0);
            return true;
        }
        return false;
    }

    cancelJob(requestId: string): boolean {
        const job = Array.from(this.jobs.values()).find(j => j.data.requestId === requestId);
        if (job) {
            job.status = "cancelled";
        }
        const signal = activeJobSignals.get(requestId) || { paused: false, cancelled: false };
        signal.cancelled = true;
        activeJobSignals.set(requestId, signal);
        if (job) this.jobs.delete(job.id);
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

/**
 * Auto-joins or sends join request to Telegram channels/groups when a bot requires subscription
 */
export async function autoJoinTelegramChannel(linkOrUsername: string): Promise<boolean> {
    try {
        let clean = linkOrUsername.replace(/https?:\/\/t\.me\//i, "").replace(/^@/, "").trim();
        clean = clean.split("?")[0].replace(/\/$/, "");

        if (clean.startsWith("+") || clean.startsWith("joinchat/")) {
            const hash = clean.replace(/^\+/, "").replace(/^joinchat\//, "");
            try {
                await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                console.log(`[TG FORCE-JOIN] Successfully joined private invite hash: "${hash}"`);
                return true;
            } catch (err: any) {
                const msg = err.message || "";
                if (msg.includes("USER_ALREADY_PARTICIPANT")) {
                    console.log(`[TG FORCE-JOIN] Already a participant of private invite hash: "${hash}"`);
                    return true;
                }
                if (msg.includes("INVITE_REQUEST_SENT")) {
                    console.log(`[TG FORCE-JOIN] Join request sent for private invite hash: "${hash}"`);
                    return true;
                }
                console.log(`[TG FORCE-JOIN] Private invite notice for "${hash}": ${msg}`);
                try {
                    await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                } catch {}
            }
        } else {
            const username = clean.split("/")[0];
            if (!username) return false;
            try {
                await client.invoke(new Api.channels.JoinChannel({ channel: username }));
                console.log(`[TG FORCE-JOIN] Successfully joined public channel: "@${username}"`);
                return true;
            } catch (err: any) {
                const msg = err.message || "";
                if (msg.includes("USER_ALREADY_PARTICIPANT")) {
                    console.log(`[TG FORCE-JOIN] Already in channel: "@${username}"`);
                    return true;
                }
                console.log(`[TG FORCE-JOIN] JoinChannel notice for "@${username}": ${msg}`);
            }
        }
    } catch (err: any) {
        console.log(`[TG FORCE-JOIN] autoJoinTelegramChannel failed for "${linkOrUsername}": ${err.message}`);
    }
    return false;
}

/**
 * Checks a bot message for force-sub channel join requirement and joins automatically
 */
export async function handleChannelJoinRequirement(botMsg: any): Promise<boolean> {
    const text = (botMsg.message || botMsg.text || "").toLowerCase();
    const isJoinPrompt =
        text.includes("join") &&
        (text.includes("channel") || text.includes("group") || text.includes("to use this bot") || text.includes("must join") || text.includes("subscribe"));

    let buttons: any[][] | null = null;
    try {
        buttons = await botMsg.getButtons();
    } catch {}

    const hasJoinButtons = buttons && buttons.some((row: any[]) =>
        row.some((b: any) => {
            const bt = (b.text || "").toLowerCase();
            return bt.includes("join") || bt.includes("channel") || bt.includes("group") || bt.includes("subscribe") || b.url;
        })
    );

    if (!isJoinPrompt && !hasJoinButtons) return false;

    console.log(`[TG FORCE-JOIN] Detected bot force-subscription prompt: "${(botMsg.message || "").substring(0, 80)}"`);
    let joinedAny = false;

    // 1. Extract and join channels from inline URL buttons
    if (buttons) {
        for (const row of buttons) {
            for (const btn of row) {
                const btnUrl = btn.url || (btn.button && (btn.button.url || btn.button.urlAuth));
                if (btnUrl && typeof btnUrl === "string" && btnUrl.includes("t.me")) {
                    console.log(`[TG FORCE-JOIN] Auto-joining from button: "${btn.text}" -> ${btnUrl}`);
                    const ok = await autoJoinTelegramChannel(btnUrl);
                    if (ok) joinedAny = true;
                }
            }
        }
    }

    // 2. Extract and join channels from message text links & @mentions
    const urlMatches = (botMsg.message || "").match(/(?:https?:\/\/t\.me\/(?:\+|joinchat\/)?[a-zA-Z0-9_-]+|@[a-zA-Z0-9_]{4,})/gi);
    if (urlMatches) {
        for (const match of urlMatches) {
            if (match.toLowerCase().includes("bot") && !match.toLowerCase().includes("searchbot")) continue;
            console.log(`[TG FORCE-JOIN] Auto-joining from message text: ${match}`);
            const ok = await autoJoinTelegramChannel(match);
            if (ok) joinedAny = true;
        }
    }

    // 3. If there is a verification / refresh / try again button, click it
    if (buttons) {
        for (let r = 0; r < buttons.length; r++) {
            for (let c = 0; c < buttons[r].length; c++) {
                const btn = buttons[r][c];
                const bText = (btn.text || "").toLowerCase();
                if (bText.includes("joined") || bText.includes("try again") || bText.includes("done") || bText.includes("verify") || bText.includes("refresh")) {
                    console.log(`[TG FORCE-JOIN] Clicking verification button: "${btn.text}"`);
                    await sleep(1000);
                    try {
                        if (typeof btn.click === "function") {
                            await btn.click({});
                        } else {
                            await botMsg.click({ i: r, j: c });
                        }
                    } catch {}
                }
            }
        }
    }

    return joinedAny || true;
}

/**
 * High-Speed Multi-Connection Parallel Downloader
 */
async function downloadFileWithResume(
    msg: any,
    downloadPath: string,
    totalSize: number,
    requestId: string,
    title: string
): Promise<boolean> {
    const MAX_RETRIES = 10;
    const CHUNK_SIZE = 1024 * 1024; // 1 MB chunks
    const TARGET_SPEED_BYTES_PER_SEC = 3.8 * 1024 * 1024; // Capped at steady 3.8 - 4.0 MB/s (safe from Telegram flood limits)
    const TARGET_CHUNK_INTERVAL_MS = (CHUNK_SIZE / TARGET_SPEED_BYTES_PER_SEC) * 1000; // ~260ms per 1MB chunk

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const signal = activeJobSignals.get(requestId);
        if (signal?.cancelled) {
            console.log(`[DL] Download cancelled by user: "${title}"`);
            return false;
        }
        if (signal?.paused) {
            console.log(`[DL] Download paused by user: "${title}"`);
            return false;
        }

        // Check already downloaded bytes on disk for True Resume
        let downloadedBytes = 0;
        try {
            if (existsSync(downloadPath)) {
                const diskSize = statSync(downloadPath).size;
                if (totalSize > 0 && diskSize === totalSize) {
                    console.log(`[DL] File already fully downloaded with exact size (${(totalSize / (1024 * 1024)).toFixed(1)} MB): "${title}" -> ${downloadPath}`);
                    return true;
                } else if (totalSize > 0 && diskSize < totalSize) {
                    downloadedBytes = Math.floor(diskSize / CHUNK_SIZE) * CHUNK_SIZE;
                } else {
                    // Disk file is larger than totalSize or different release -> start fresh download
                    downloadedBytes = 0;
                }
            }
        } catch {}

        const isResuming = downloadedBytes > 0;
        console.log(`[DL] ${isResuming ? `Resuming from ${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB` : "Starting fresh paced download"} (Attempt ${attempt}/${MAX_RETRIES}) for "${title}"`);

        let writeStream: any = null;
        try {
            const info = utils.getFileInfo(msg);
            let dcId = info.dcId;

            let lastBroadcast = 0;
            let lastBytes = downloadedBytes;
            let lastSpeedCalcTime = Date.now();
            let currentSpeedMB = "0.0";
            let dlBytes = downloadedBytes;

            const initTotMB = totalSize > 0 ? (totalSize / (1024 * 1024)).toFixed(0) : "0";
            const initDlMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
            const initPct = totalSize > 0 ? Math.min((downloadedBytes / totalSize) * 100, 100) : 0;

            broadcastDownloadProgress(requestId, {
                status: "downloading",
                title,
                percent: Math.round(initPct),
                speed: "0.0 MB/s",
                eta: isResuming ? "Resuming..." : "Starting...",
                downloaded: `${initDlMB} MB`,
                total: `${initTotMB} MB`,
            });

            writeStream = createWriteStream(downloadPath, {
                flags: isResuming ? "a" : "w",
                highWaterMark: 4 * 1024 * 1024,
            });

            const startPartIdx = Math.floor(downloadedBytes / CHUNK_SIZE);
            const totalParts = totalSize > 0 ? Math.ceil(totalSize / CHUNK_SIZE) : Infinity;

            let nextRequestPartIdx = startPartIdx;
            let nextWritePartIdx = startPartIdx;
            const pendingChunks = new Map<number, Buffer>();
            let streamFailedError: any = null;
            let finishedAll = false;

            const writePending = () => {
                while (pendingChunks.has(nextWritePartIdx)) {
                    const chunk = pendingChunks.get(nextWritePartIdx)!;
                    pendingChunks.delete(nextWritePartIdx);
                    writeStream.write(chunk);
                    dlBytes += chunk.length;
                    nextWritePartIdx++;

                    const totBytes = totalSize > 0 ? totalSize : dlBytes;
                    const now = Date.now();

                    const speedTimeDelta = (now - lastSpeedCalcTime) / 1000;
                    if (speedTimeDelta >= 0.4) {
                        const bytesDelta = dlBytes - lastBytes;
                        const instSpeed = speedTimeDelta > 0 ? bytesDelta / speedTimeDelta : 0;
                        currentSpeedMB = (instSpeed / (1024 * 1024)).toFixed(1);
                        lastBytes = dlBytes;
                        lastSpeedCalcTime = now;
                    }

                    if (now - lastBroadcast >= 250 || (totBytes > 0 && dlBytes >= totBytes)) {
                        lastBroadcast = now;
                        const pct = totBytes > 0 ? Math.min((dlBytes / totBytes) * 100, 100) : 0;
                        const speedBytes = Number(currentSpeedMB) * 1024 * 1024;
                        const remaining = speedBytes > 0 ? (totBytes - dlBytes) / speedBytes : 0;
                        const etaMin = Math.floor(remaining / 60);
                        const etaSec = Math.floor(remaining % 60);

                        const dlMB = (dlBytes / (1024 * 1024)).toFixed(1);
                        const totMB = (totBytes / (1024 * 1024)).toFixed(0);

                        process.stdout.write(
                            `\r[DL] ${pct.toFixed(1)}% | ${dlMB}/${totMB} MB | ${currentSpeedMB} MB/s | ETA ${etaMin}m ${etaSec}s   `
                        );

                        broadcastDownloadProgress(requestId, {
                            status: "downloading",
                            title,
                            percent: Math.round(pct),
                            speed: `${currentSpeedMB} MB/s`,
                            eta: `${etaMin}m ${etaSec}s`,
                            downloaded: `${dlMB} MB`,
                            total: `${totMB} MB`,
                        });
                    }
                }
            };

            const CONCURRENCY = 2; // 2 in-flight workers (delivers continuous 3.5 - 4.0 MB/s with zero flood waits)
            const worker = async () => {
                while (!finishedAll && !streamFailedError) {
                    const sig = activeJobSignals.get(requestId);
                    if (sig?.cancelled || sig?.paused) break;

                    const partIdx = nextRequestPartIdx++;
                    if (partIdx >= totalParts) break;

                    while (pendingChunks.size >= 6 && !finishedAll && !streamFailedError) {
                        await sleep(50);
                    }

                    const partOffset = bigInt(partIdx).multiply(CHUNK_SIZE);

                    let partRetries = 0;
                    while (partRetries < 4) {
                        try {
                            const res: any = await client.invoke(
                                new Api.upload.GetFile({
                                    location: info.location,
                                    offset: partOffset,
                                    limit: CHUNK_SIZE,
                                    precise: true,
                                }),
                                dcId
                            );

                            if (res?.bytes && res.bytes.length > 0) {
                                pendingChunks.set(partIdx, Buffer.from(res.bytes));
                                writePending();
                                if (res.bytes.length < CHUNK_SIZE) {
                                    finishedAll = true;
                                }
                            } else {
                                finishedAll = true;
                            }
                            break;
                        } catch (err: any) {
                            if (typeof err?.errorMessage === "string" && err.errorMessage.startsWith("FILE_MIGRATE") && typeof err.newDc === "number") {
                                dcId = err.newDc;
                                continue;
                            }
                            const errMsg = err?.message || String(err);
                            const waitMatch = errMsg.match(/wait\s*(\d+)\s*sec/i);
                            if (waitMatch) {
                                const waitSec = parseInt(waitMatch[1], 10) + 1;
                                await sleep(waitSec * 1000);
                                partRetries++;
                                continue;
                            }
                            streamFailedError = err;
                            break;
                        }
                    }
                }
            };

            await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

            if (streamFailedError) throw streamFailedError;

            // Flush remaining chunks to disk
            writePending();

            await new Promise<void>((resolve, reject) => {
                writeStream.end(() => resolve());
                writeStream.on("error", reject);
            });

            process.stdout.write("\n");
            console.log(`[DL] Download Complete: "${title}" -> ${downloadPath}`);
            return true;

        } catch (dlErr: any) {
            process.stdout.write("\n");
            const errStr = dlErr?.message || String(dlErr);
            console.error(`[DL] Download Error (attempt ${attempt}):`, errStr);

            if (writeStream) {
                try { writeStream.end(); } catch {}
            }

            const sig = activeJobSignals.get(requestId);
            if (sig?.cancelled || sig?.paused) return false;

            const waitMatch = errStr.match(/wait\s*(\d+)\s*sec/i);
            const waitSec = waitMatch ? parseInt(waitMatch[1], 10) + 1 : Math.min(attempt * 2, 10);

            if (attempt < MAX_RETRIES) {
                console.log(`[DL] Resuming download in ${waitSec}s...`);
                await sleep(waitSec * 1000);
            }
        }
    }
    return false;
}

export async function findInSavedMessages(title: string, wantSizeMB?: number): Promise<any | null> {
    try {
        const messages = await client.getMessages("me", { limit: 50 });
        const cleanTitle = title.replace(/\s*\(\d{4}\).*$/, "").toLowerCase().trim();
        const titleWords = cleanTitle.split(/\s+/).filter(w => w.length > 2 && !/^\d{4}$/.test(w));

        for (const msg of messages) {
            if (!msg.document) continue;
            const fnameAttr = msg.document.attributes?.find(
                (a: any) => a.className === "DocumentAttributeFilename"
            ) as any;
            const fileName = (fnameAttr?.fileName || "").toLowerCase();
            const docSizeMB = Number(msg.document.size) / (1024 * 1024);

            if (wantSizeMB && wantSizeMB > 0 && Math.abs(docSizeMB - wantSizeMB) > 50) {
                continue;
            }

            if (titleWords.length > 0) {
                const matched = titleWords.filter(w => fileName.includes(w)).length;
                if (matched >= Math.ceil(titleWords.length * 0.6)) {
                    return msg;
                }
            }
        }
    } catch (err: any) {
        console.log(`[SAVED_MSG] Search error: ${err?.message || err}`);
    }
    return null;
}

export async function secureBotFileToSavedMessages(
    targetBot: string,
    btnMsg?: any,
    buttonText?: string,
    targetPage: number = 1,
    buttonRow?: number,
    buttonCol?: number
): Promise<{ savedMsgId: number; fileName: string; totalSize: number } | null> {
    try {
        if (!btnMsg) return null;

        let curMsg = btnMsg;

        // If target release is on Page > 1, navigate forward by clicking Next button
        if (targetPage > 1) {
            console.log(`[SECURE_FILE] Target is on Page ${targetPage}. Flipping pages...`);
            for (let p = 1; p < targetPage; p++) {
                const curButtons = (await curMsg.getButtons()) || [];
                let nextBtn: any = null;
                for (const row of curButtons) {
                    for (const btn of row) {
                        const bt = ((btn as any).text || "").toLowerCase();
                        if (
                            bt.includes("next") ||
                            bt.includes("➡️") ||
                            bt.includes(">>") ||
                            (/\[\d+\/\d+\]/.test(bt) && !bt.includes("prev") && !bt.includes("⬅️"))
                        ) {
                            nextBtn = btn;
                            break;
                        }
                    }
                    if (nextBtn) break;
                }

                if (nextBtn) {
                    await nextBtn.click({});
                    await sleep(1500);
                    const msgs = await client.getMessages(targetBot, { ids: [curMsg.id] });
                    if (msgs && msgs[0]) {
                        curMsg = msgs[0];
                    }
                } else {
                    console.log(`[SECURE_FILE] No next button found on page ${p}`);
                    break;
                }
            }
        }

        const initialRecent = await client.getMessages(targetBot, { limit: 15 });
        const seenIds = new Set<number>(initialRecent.map((m: any) => m.id));

        console.log(`[SECURE_FILE] Clicking release button on @${targetBot} (Page ${targetPage}) to trigger and secure file...`);
        const buttons = (await curMsg.getButtons()) || [];
        if (buttonRow !== undefined && buttonCol !== undefined && buttons?.[buttonRow]?.[buttonCol]) {
            await (buttons[buttonRow][buttonCol] as any).click({});
        } else if (buttonText) {
            try { await curMsg.click({ text: buttonText }); } catch {
                if (buttonRow !== undefined && buttonCol !== undefined) {
                    await curMsg.click({ i: buttonRow, j: buttonCol });
                }
            }
        } else if (buttonRow !== undefined && buttonCol !== undefined) {
            await curMsg.click({ i: buttonRow, j: buttonCol });
        }

        // Poll for document message from bot (up to 20 seconds)
        for (let i = 0; i < 10; i++) {
            await sleep(2000);
            const recent = await client.getMessages(targetBot, { limit: 10 });
            for (const msg of recent) {
                if (seenIds.has(msg.id) && !msg.document) continue;

                if (msg.document) {
                    const fnameAttr = msg.document.attributes?.find(
                        (a: any) => a.className === "DocumentAttributeFilename"
                    ) as any;
                    const fileName = fnameAttr?.fileName || "video.mp4";
                    const totalSize = Number(msg.document.size) || 0;

                    // Skip subtitles
                    if (fileName.toLowerCase().endsWith(".srt") || totalSize < 20 * 1024 * 1024) {
                        seenIds.add(msg.id);
                        continue;
                    }

                    console.log(`[SECURE_FILE] Bot delivered "${fileName}" (${(totalSize / (1024 * 1024)).toFixed(0)} MB). Forwarding to Saved Messages...`);
                    await client.forwardMessages("me", { messages: [msg.id], fromPeer: targetBot });
                    await sleep(800);

                    const savedMsgs = await client.getMessages("me", { limit: 5 });
                    const savedMatch = savedMsgs.find((m: any) => m.document);
                    if (savedMatch) {
                        console.log(`[SECURE_FILE] Successfully secured in Saved Messages (ID: ${savedMatch.id})!`);
                        return {
                            savedMsgId: savedMatch.id,
                            fileName,
                            totalSize
                        };
                    }
                }
            }
        }
    } catch (err: any) {
        console.log(`[SECURE_FILE] Notice: ${err?.message || err}`);
    }
    return null;
}

export function createDownloadWorker() {
    console.log("[QUEUE] Worker initialized");

    downloadQueue.setProcessor(async (job) => {
        const data = job.data;
        const targetBot = data.bot || (data.type === "movie" ? "ProSearchM11Bot" : "ProSearchY11Bot");

        try {
            console.log(`[WORKER] Starting job: "${data.title}" via @${targetBot}`);
            await updateDB(data.requestId, { status: "downloading" });

            let mediaToDownload: any = null;
            let fileName = data.fileName || "video.mp4";
            let totalSize = data.fileSizeBytes || 0;

            // ─── TIER 1: CHECK SAVED MESSAGES BY DIRECT ID ───
            if (data.savedMsgId) {
                console.log(`[WORKER] [TIER 1] Checking Saved Messages for pre-secured file (ID: ${data.savedMsgId})...`);
                try {
                    const msgs = await client.getMessages("me", { ids: [data.savedMsgId] });
                    if (msgs && msgs[0] && (msgs[0].document || msgs[0].media)) {
                        mediaToDownload = msgs[0];
                        if (msgs[0].document) {
                            totalSize = Number(msgs[0].document.size) || totalSize;
                            const fnameAttr = msgs[0].document.attributes?.find(
                                (a: any) => a.className === "DocumentAttributeFilename"
                            ) as any;
                            if (fnameAttr?.fileName) fileName = fnameAttr.fileName;
                        }
                        console.log(`[WORKER] Direct grab from Saved Messages succeeded: "${fileName}" (${(totalSize / (1024 * 1024)).toFixed(0)} MB). Skipping bot search!`);
                    }
                } catch (e: any) {
                    console.log(`[WORKER] Saved message ID lookup notice: ${e?.message || e}`);
                }
            }

            // ─── TIER 2: CHECK SAVED MESSAGES BY TITLE/SIZE MATCH ───
            if (!mediaToDownload) {
                console.log(`[WORKER] [TIER 2] Searching Saved Messages for "${data.title}"...`);
                const matchedSaved = await findInSavedMessages(data.title, parseSizeMB(data.fileSize || ""));
                if (matchedSaved) {
                    mediaToDownload = matchedSaved;
                    if (matchedSaved.document) {
                        totalSize = Number(matchedSaved.document.size) || totalSize;
                        const fnameAttr = matchedSaved.document.attributes?.find(
                            (a: any) => a.className === "DocumentAttributeFilename"
                        ) as any;
                        if (fnameAttr?.fileName) fileName = fnameAttr.fileName;
                    }
                    console.log(`[WORKER] Matched existing file in Saved Messages for "${data.title}": "${fileName}" (${(totalSize / (1024 * 1024)).toFixed(0)} MB). Skipping bot search!`);
                }
            }

            // ─── TIER 3: CHECK BOT CHAT FOR ALREADY-DELIVERED FILE BEFORE RE-QUERYING ───
            if (!mediaToDownload) {
                try {
                    console.log(`[WORKER] [TIER 3] Checking @${targetBot} recent messages for delivered file...`);
                    const botRecent = await client.getMessages(targetBot, { limit: 25 });
                    const cleanTitle = data.title.replace(/\s*\(\d{4}\).*$/, "").toLowerCase().trim();
                    const titleWords = cleanTitle.split(/\s+/).filter((w: string) => w.length > 2 && !/^\d{4}$/.test(w));
                    const wantSize = parseSizeMB(data.fileSize || "");

                    for (const msg of botRecent) {
                        if (!msg.document) continue;
                        const fnameAttr = msg.document.attributes?.find(
                            (a: any) => a.className === "DocumentAttributeFilename"
                        ) as any;
                        const docName = (fnameAttr?.fileName || "").toLowerCase();
                        const docSizeMB = Number(msg.document.size) / (1024 * 1024);

                        if (docName.endsWith(".srt") || docSizeMB < 20) continue;
                        if (wantSize > 0 && Math.abs(docSizeMB - wantSize) > 50) continue;

                        if (titleWords.length > 0) {
                            const matchCount = titleWords.filter((w: string) => docName.includes(w)).length;
                            if (matchCount >= Math.ceil(titleWords.length * 0.6)) {
                                console.log(`[WORKER] Found matching video document in bot chat for "${data.title}": "${fnameAttr?.fileName}". Forwarding to Saved Messages...`);
                                await client.forwardMessages("me", { messages: [msg.id], fromPeer: targetBot });
                                await sleep(800);
                                const savedMsgs = await client.getMessages("me", { limit: 5 });
                                const savedMatch = savedMsgs.find((m: any) => m.document);
                                if (savedMatch) {
                                    mediaToDownload = savedMatch;
                                    fileName = fnameAttr?.fileName || fileName;
                                    totalSize = Number(msg.document.size) || totalSize;
                                    console.log(`[WORKER] Secured bot chat file into Saved Messages (ID: ${savedMatch.id})! Skipping bot search!`);
                                    break;
                                }
                            }
                        }
                    }
                } catch (bErr: any) {
                    console.log(`[WORKER] Bot chat pre-check notice: ${bErr?.message || bErr}`);
                }
            }

            // ─── DIRECT DOWNLOAD FROM SAVED MESSAGES IF AVAILABLE ───
            if (mediaToDownload) {
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
                    mediaToDownload, downloadPath, totalSize, data.requestId, data.title
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
                console.log(`[WORKER] Pre-secured job finished: "${data.title}"`);
                return;
            }

            // If file was NOT pre-secured in Saved Messages, query the bot and click the button
            let btnMsg: any = null;
            const epMatch = data.title.match(/S(\d+)E(\d+)/i);
            const epTag = epMatch ? `s${epMatch[1].padStart(2, "0")}e${epMatch[2].padStart(2, "0")}` : "";

                // Step 1: Query bot for fresh Page 1 start
                let searchQuery = data.title.trim();
                if (data.type === "series" || targetBot === "ProSearchY11Bot") {
                    const epMatch = data.title.match(/S(\d+)E(\d+)/i);
                    if (epMatch) {
                        const cleanT = data.title.replace(/\s*S\d+E\d+.*$/i, "").trim();
                        const sTag = `S${epMatch[1].padStart(2, "0")}E${epMatch[2].padStart(2, "0")}`;
                        searchQuery = `${cleanT} ${sTag}`;
                    } else if (data.season && data.episode) {
                        const cleanT = data.title.replace(/\s*S\d+.*$/i, "").trim();
                        const sTag = `S${String(data.season).padStart(2, "0")}E${String(data.episode).padStart(2, "0")}`;
                        searchQuery = `${cleanT} ${sTag}`;
                    }
                } else {
                    searchQuery = data.title.replace(/\s*\(\d{4}\).*$/, "").trim();
                    if (data.year) searchQuery = `${searchQuery} ${data.year}`.trim();
                }

                console.log(`[WORKER] Querying @${targetBot} for fresh Page 1 start: "${searchQuery}"`);
                const sent = await client.sendMessage(targetBot, { message: searchQuery });
                await sleep(2000);

                for (let attempt = 0; attempt < 4; attempt++) {
                    await sleep(1500);
                    const messages = await client.getMessages(targetBot, { limit: 10 });
                    for (const msg of messages) {
                        if (msg.id <= sent.id) continue;
                        const buttons = await msg.getButtons();
                        if (buttons && buttons.length > 0) {
                            btnMsg = msg;
                            break;
                        }
                    }
                    if (btnMsg) break;
                }

                if (!btnMsg) {
                    throw new Error(`No buttons returned by @${targetBot} for "${data.title}"`);
                }

            // Step 2: Navigate forward if target release is on Page > 1
            const targetPage = data.page || 1;
            if (targetPage > 1) {
                console.log(`[WORKER] Target release is on Page ${targetPage}. Navigating forward...`);
                for (let p = 1; p < targetPage; p++) {
                    const curButtons = (await btnMsg.getButtons()) || [];
                    let nextBtn: any = null;
                    for (const row of curButtons) {
                        for (const btn of row) {
                            const bt = ((btn as any).text || "").toLowerCase();
                            if (
                                bt.includes("next") ||
                                bt.includes("➡️") ||
                                bt.includes(">>") ||
                                (/\[\d+\/\d+\]/.test(bt) && !bt.includes("prev") && !bt.includes("⬅️"))
                            ) {
                                nextBtn = btn;
                                break;
                            }
                        }
                        if (nextBtn) break;
                    }

                    if (nextBtn) {
                        await nextBtn.click({});
                        await sleep(1800);
                        const msgs = await client.getMessages(targetBot, { ids: [btnMsg.id] });
                        if (msgs && msgs[0]) {
                            btnMsg = msgs[0];
                        }
                    } else {
                        console.log(`[WORKER] No NEXT button found on page ${p}`);
                        break;
                    }
                }
            }

            // Step 3: Find and click the exact target video button on the current page
            const buttons = (await btnMsg.getButtons())!;
            let targetRow = -1;
            let targetCol = -1;
            let targetBtnText = "";

            const isNavOrInvalid = (text: string) => {
                const lower = text.toLowerCase();
                return (
                    lower.includes("next") ||
                    lower.includes("prev") ||
                    lower.includes("page") ||
                    lower.includes("back") ||
                    lower.includes("close") ||
                    lower.includes("update") ||
                    lower.includes("channel") ||
                    lower.includes("srt") ||
                    lower.includes("sub") ||
                    /^\s*(⬅️|➡️|◀️|▶️|<<|>>|\d+\/\d+)/i.test(lower) ||
                    /\[\d+\/\d+\]/.test(lower)
                );
            };

            // Collect all valid video buttons on this page
            const validVideoButtons: { r: number; c: number; text: string; sizeMB: number }[] = [];
            for (let r = 0; r < buttons.length; r++) {
                for (let c = 0; c < buttons[r].length; c++) {
                    const btn = buttons[r][c] as any;
                    const text = btn.text || "";
                    if (!isNavOrInvalid(text)) {
                        validVideoButtons.push({ r, c, text, sizeMB: parseSizeMB(text) });
                    }
                }
            }

            // 1. EXACT text matching (highest accuracy)
            if (data.buttonText) {
                const bClean = data.buttonText.toLowerCase().trim();
                for (const vb of validVideoButtons) {
                    if (vb.text.toLowerCase().trim() === bClean) {
                        targetRow = vb.r;
                        targetCol = vb.c;
                        targetBtnText = vb.text;
                        console.log(`[WORKER] Exact text match on Page ${targetPage}: "${targetBtnText}"`);
                        break;
                    }
                }
            }

            // 2. Exact [buttonRow, buttonCol] on this page
            if (targetRow < 0 && data.buttonRow !== undefined && data.buttonCol !== undefined) {
                if (buttons[data.buttonRow] && buttons[data.buttonRow][data.buttonCol]) {
                    const b = buttons[data.buttonRow][data.buttonCol] as any;
                    targetRow = data.buttonRow;
                    targetCol = data.buttonCol;
                    targetBtnText = b.text || "";
                    console.log(`[WORKER] Matched button by position [${targetRow}, ${targetCol}]: "${targetBtnText}"`);
                }
            }

            // 3. Option index relative to the current page
            if (targetRow < 0 && data.optionIndex && typeof data.optionIndex === "number") {
                const pageOffset = (targetPage - 1) * 10;
                const pageRelIdx = data.optionIndex > 10 ? (data.optionIndex - pageOffset) : data.optionIndex;
                if (pageRelIdx >= 1 && pageRelIdx <= validVideoButtons.length) {
                    const chosen = validVideoButtons[pageRelIdx - 1];
                    targetRow = chosen.r;
                    targetCol = chosen.c;
                    targetBtnText = chosen.text;
                    console.log(`[WORKER] Matched button by page-relative Option #${pageRelIdx} (global #${data.optionIndex}): "${targetBtnText}"`);
                }
            }

            // 4. Exact file size matching
            if (targetRow < 0 && data.fileSize) {
                const wantMB = parseSizeMB(data.fileSize);
                if (wantMB > 0) {
                    for (const vb of validVideoButtons) {
                        if (Math.abs(vb.sizeMB - wantMB) < 2) {
                            targetRow = vb.r;
                            targetCol = vb.c;
                            targetBtnText = vb.text;
                            console.log(`[WORKER] Matched button by file size (${wantMB} MB): "${targetBtnText}"`);
                            break;
                        }
                    }
                }
            }

            // 2. Try exact & smart token matching on data.buttonText (size, resolution, codec)
            if (targetRow < 0 && data.buttonText) {
                const bLower = data.buttonText.toLowerCase();
                const bSize = parseSizeMB(data.buttonText);
                const want265 = bLower.includes("265") || bLower.includes("hevc");
                const want264 = bLower.includes("264") || bLower.includes("avc");
                const want1080 = bLower.includes("1080");
                const want720 = bLower.includes("720");
                const want480 = bLower.includes("480");

                let bestScore = -1;
                let bestMatch: typeof validVideoButtons[0] | null = null;

                for (const vb of validVideoButtons) {
                    const vLower = vb.text.toLowerCase();
                    let score = 0;

                    // Match exact or close file size
                    if (bSize > 0 && Math.abs(vb.sizeMB - bSize) < 5) score += 50;

                    // Match resolution
                    if (want1080 && vLower.includes("1080")) score += 20;
                    if (want720 && vLower.includes("720")) score += 20;
                    if (want480 && vLower.includes("480")) score += 20;

                    // Match codec
                    if (want265 && (vLower.includes("265") || vLower.includes("hevc"))) score += 15;
                    if (want264 && (vLower.includes("264") || vLower.includes("avc"))) score += 15;

                    // Substring match (only for long strings >= 6 chars)
                    if (bLower.length >= 6 && vLower.includes(bLower)) score += 30;

                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = vb;
                    }
                }

                if (bestMatch && bestScore > 0) {
                    targetRow = bestMatch.r;
                    targetCol = bestMatch.c;
                    targetBtnText = bestMatch.text;
                    console.log(`[WORKER] Matched button by attributes (Score: ${bestScore}): "${targetBtnText}"`);
                }
            }

            // 3. Try episode tag match for series
            if (targetRow < 0 && epTag) {
                for (const vb of validVideoButtons) {
                    const text = vb.text.toLowerCase();
                    if (text.includes(`[${epTag}]`) || text.includes(epTag)) {
                        targetRow = vb.r;
                        targetCol = vb.c;
                        targetBtnText = vb.text;
                        break;
                    }
                }
            }

            // 4. Try quality-based match: 720p heavily prioritized, then 1080p, then 480p
            if (targetRow < 0) {
                const want1080 = (data.buttonText || "").toLowerCase().includes("1080");
                const want480 = (data.buttonText || "").toLowerCase().includes("480");

                if (!want1080 && !want480) {
                    // Try 720p with H.265/x265 first
                    const p720hevc = validVideoButtons.find(b => {
                        const t = b.text.toLowerCase();
                        return t.includes("720p") && (t.includes("265") || t.includes("hevc"));
                    });
                    const p720any = validVideoButtons.find(b => b.text.toLowerCase().includes("720p"));
                    const chosen720 = p720hevc || p720any;
                    if (chosen720) {
                        targetRow = chosen720.r;
                        targetCol = chosen720.c;
                        targetBtnText = chosen720.text;
                        console.log(`[WORKER] Prioritizing 720p video release: "${targetBtnText}"`);
                    }
                }

                if (targetRow < 0) {
                    for (const vb of validVideoButtons) {
                        const text = vb.text.toLowerCase();
                        if (want1080 && text.includes("1080p")) {
                            targetRow = vb.r; targetCol = vb.c; targetBtnText = vb.text; break;
                        } else if (want480 && text.includes("480p")) {
                            targetRow = vb.r; targetCol = vb.c; targetBtnText = vb.text; break;
                        } else if (text.includes("1080p")) {
                            targetRow = vb.r; targetCol = vb.c; targetBtnText = vb.text; break;
                        }
                    }
                }
            }

            // 5. Fallback: First valid video button
            if (targetRow < 0 && validVideoButtons.length > 0) {
                const chosen = validVideoButtons[0];
                targetRow = chosen.r;
                targetCol = chosen.c;
                targetBtnText = chosen.text;
            }

            if (targetRow < 0) {
                throw new Error(`Could not find a downloadable video release button on @${targetBot}`);
            }

            // Collect initial recent message IDs before clicking
            const initialRecent = await client.getMessages(targetBot, { limit: 20 });
            const seenMessageIds = new Set<number>(initialRecent.map((m: any) => m.id));

            console.log(`[WORKER] Clicking verified video button [${targetRow}, ${targetCol}]: "${targetBtnText}"`);
            try {
                if (buttons[targetRow] && buttons[targetRow][targetCol]) {
                    await (buttons[targetRow][targetCol] as any).click({});
                } else {
                    await btnMsg.click({ i: targetRow, j: targetCol });
                }
            } catch (clickErr: any) {
                console.log(`[WORKER] Button click fallback: ${clickErr.message}`);
                try {
                    await btnMsg.click({ text: targetBtnText });
                } catch {
                    await btnMsg.click({ i: targetRow, j: targetCol });
                }
            }
            await sleep(2500);

            // Step 4: Wait for the file document to be delivered by the bot
            console.log(`[WORKER] Waiting for video document from @${targetBot}...`);
            let fileReceived = false;
            let channelJoinHandled = false;
            let retryClickCount = 0;

            for (let attempt = 0; attempt < 60; attempt++) {
                await sleep(2500);
                const recent = await client.getMessages(targetBot, { limit: 15 });

                for (const msg of recent) {
                    if (seenMessageIds.has(msg.id) && !msg.document && !msg.photo) continue;

                    // Handle bot force-channel subscription prompt
                    if (!msg.document && !msg.photo && !channelJoinHandled) {
                        const requiredJoin = await handleChannelJoinRequirement(msg);
                        if (requiredJoin) {
                            channelJoinHandled = true;
                            seenMessageIds.add(msg.id);
                            console.log(`[WORKER] Channel join requested/completed. Waiting 6 seconds for Telegram & bot membership sync...`);
                            await sleep(6000);
                            console.log(`[WORKER] Re-clicking video release button after channel join sync...`);
                            try {
                                if (buttons[targetRow] && buttons[targetRow][targetCol]) {
                                    await (buttons[targetRow][targetCol] as any).click({});
                                } else {
                                    await btnMsg.click({ i: targetRow, j: targetCol });
                                }
                            } catch {
                                try { await btnMsg.click({ text: targetBtnText }); } catch {}
                            }
                            console.log(`[WORKER] Re-click sent. Now waiting for bot to upload/deliver the file...`);
                            await sleep(3000);
                            break;
                        }
                    }

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
                                seenMessageIds.add(msg.id);
                                continue;
                            }
                        }

                        console.log(`[TG] Received Media Video from bot: "${fileName}" (${(totalSize / (1024 * 1024)).toFixed(0)} MB)`);

                        // ─── PERSISTENCE SAFEGUARD: FORWARD TO SAVED MESSAGES FIRST ───
                        // Bots often auto-delete messages after a short timeout; forwarding to "Saved Messages" ("me")
                        // preserves the file indefinitely for uninterrupted high-speed multi-connection downloading.
                        let mediaToDownload = msg;
                        try {
                            console.log(`[TG] Forwarding "${fileName}" to Saved Messages for download persistence...`);
                            await client.forwardMessages("me", { messages: [msg.id], fromPeer: targetBot });
                            await sleep(800);
                            const savedMsgs = await client.getMessages("me", { limit: 5 });
                            const match = savedMsgs.find((m: any) => m.document || m.media);
                            if (match && (match.document || match.media)) {
                                mediaToDownload = match;
                                console.log(`[TG] Successfully secured video document in Saved Messages (ID: ${match.id}). Proceeding with download.`);
                            } else {
                                console.log(`[TG] Using original bot message for download.`);
                                mediaToDownload = msg;
                            }
                        } catch (fwdErr: any) {
                            console.log(`[TG] Forward to Saved Messages notice: ${fwdErr?.message || fwdErr}. Proceeding with direct download.`);
                            mediaToDownload = msg;
                        }

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
                            mediaToDownload, downloadPath, totalSize, data.requestId, data.title
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

                // Gentle re-trigger if bot is slow to respond after 20 seconds
                if (!fileReceived && (attempt === 8 || attempt === 16) && retryClickCount < 2) {
                    retryClickCount++;
                    console.log(`[WORKER] Bot hasn't sent file yet after ${attempt * 2.5}s. Re-triggering release button click (Retry #${retryClickCount})...`);
                    try {
                        if (buttons[targetRow] && buttons[targetRow][targetCol]) {
                            await (buttons[targetRow][targetCol] as any).click({});
                        } else {
                            await btnMsg.click({ i: targetRow, j: targetCol });
                        }
                    } catch {
                        try { await btnMsg.click({ text: targetBtnText }); } catch {}
                    }
                }
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

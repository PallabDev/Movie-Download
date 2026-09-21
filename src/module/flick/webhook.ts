import { env } from "../../common/utils/env.js";
import { db, schema } from "../../common/db/index.js";
import { eq, and, sql } from "drizzle-orm";
import { searchMedia, getDownloadLinks, selectBest720pQuality } from "../download/api-client.js";
import { downloadQueue } from "../queue/queue.js";
import { broadcastNewDownload } from "../web/ws.js";
import { parseMediaWithAI, formatMediaJobTitle, formatMediaFileName } from "../ai/cleaner.js";
import { lookupMedia } from "../../common/tmdb/client.js";

export const FLICK_WEBHOOK_URL = env.FLICK_WEBHOOK_URL || "https://flick.pallabdev.in/api/webhook/request";

export interface FlickWebhookPayload {
    id: string; // Flick request ID (e.g. "req_...") or DLM ID
    status: "approved" | "downloading" | "inlibrary" | "available" | "rejected";
    note?: string | null;
}

export interface FlickWebhookResult {
    success: boolean;
    data?: any;
    error?: string;
    statusSent?: string;
}

/**
 * Sends a webhook status update back to Flick (https://flick.pallabdev.in/api/webhook/request)
 */
export async function notifyFlickWebhook(payload: FlickWebhookPayload): Promise<FlickWebhookResult> {
    const { id, status, note } = payload;
    if (!id) {
        console.warn("[DLM -> Flick] Missing request ID for webhook notification");
        return { success: false, error: "Missing request ID" };
    }

    // Normalize 'available' to 'inlibrary'
    const normalizedStatus = status === "available" ? "inlibrary" : status;

    console.log(`[DLM -> Flick] Delivering webhook: ID="${id}", Status="${normalizedStatus}", Note="${note || 'None'}"`);

    try {
        const res = await fetch(FLICK_WEBHOOK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "DLM-Server/1.0",
            },
            body: JSON.stringify({
                id,
                status: normalizedStatus,
                note: note || undefined,
            }),
            signal: AbortSignal.timeout(15000),
        });

        const text = await res.text();
        let jsonRes: any = null;
        try {
            jsonRes = JSON.parse(text);
        } catch {
            jsonRes = { raw: text };
        }

        if (res.ok) {
            console.log(`[DLM -> Flick] Webhook "${normalizedStatus}" successfully acknowledged by Flick for ${id}:`, jsonRes?.message || res.status);
            // Log to activityLogs
            db.insert(schema.activityLogs).values({
                level: "info",
                source: "flick_webhook",
                message: `Webhook "${normalizedStatus}" delivered to Flick for request ${id}`,
                metadata: { id, status: normalizedStatus, note, response: jsonRes },
            }).catch(() => {});

            return { success: true, data: jsonRes, statusSent: normalizedStatus };
        } else {
            console.warn(`[DLM -> Flick] Webhook returned HTTP ${res.status}:`, text);
            db.insert(schema.activityLogs).values({
                level: "warn",
                source: "flick_webhook",
                message: `Flick webhook HTTP ${res.status} for ${id}: ${text.substring(0, 200)}`,
                metadata: { id, status: normalizedStatus, note, httpStatus: res.status, rawResponse: text },
            }).catch(() => {});

            return { success: false, error: `HTTP ${res.status}: ${text}`, statusSent: normalizedStatus };
        }
    } catch (err: any) {
        console.error(`[DLM -> Flick] Failed to deliver webhook for ${id}:`, err?.message);
        db.insert(schema.activityLogs).values({
            level: "error",
            source: "flick_webhook",
            message: `Flick webhook network error for ${id}: ${err?.message}`,
            metadata: { id, status: normalizedStatus, note, error: err?.message },
        }).catch(() => {});

        return { success: false, error: err?.message, statusSent: normalizedStatus };
    }
}

/**
 * Asynchronously searches scraper sources for a requested media and begins downloading
 */
export async function autoSearchAndDownloadForRequest(requestedMediaId: number): Promise<{
    success: boolean;
    message: string;
    jobTitle?: string;
    downloadId?: string;
}> {
    const [reqRow] = await db.select().from(schema.requestedMedia).where(eq(schema.requestedMedia.id, requestedMediaId)).limit(1);
    if (!reqRow) {
        return { success: false, message: `Request #${requestedMediaId} not found in database.` };
    }

    const titleToSearch = reqRow.title.trim();
    console.log(`[AUTO-DOWNLOAD] Attempting auto search & queue for "${titleToSearch}" (ID: #${requestedMediaId}, Flick ID: ${reqRow.flickRequestId || 'none'})`);

    // 1. Fetch active scraper sources
    let activeSources: any[] = [];
    try {
        activeSources = await db.select().from(schema.scraperSources)
            .where(eq(schema.scraperSources.enabled, true))
            .orderBy(schema.scraperSources.priority);
    } catch {}

    // 2. Search scraper sources
    const results = await searchMedia(titleToSearch, activeSources);
    if (!results || results.length === 0) {
        return { success: false, message: `No releases found on scraper sources for "${titleToSearch}".` };
    }

    // 3. Find the best match
    const bestResult = results[0];
    if (!bestResult || !bestResult.url) {
        return { success: false, message: `No valid release URLs found for "${titleToSearch}".` };
    }

    // 4. Resolve download links
    const details = await getDownloadLinks(bestResult.url);
    const quality = selectBest720pQuality(details);

    if (!quality || !quality.servers || quality.servers.length === 0) {
        return { success: false, message: `Found release "${bestResult.name}", but no active download servers were available.` };
    }

    // 5. Parse media metadata using AI
    const rawToParse = [details.name || bestResult.name, reqRow.year].filter(Boolean).join(" ");
    const aiMeta = await parseMediaWithAI(rawToParse);

    if (reqRow.type === "series") {
        aiMeta.type = "series";
        aiMeta.isBatch = true;
    } else {
        aiMeta.type = "movie";
        if (reqRow.tmdbId) {
            try {
                const tmdb = await lookupMedia(aiMeta.title, reqRow.year || undefined);
                if (tmdb && tmdb.found) {
                    aiMeta.title = tmdb.title;
                    if (tmdb.year) aiMeta.year = tmdb.year;
                }
            } catch {}
        }
    }

    const mediaType = aiMeta.type;
    const movieYear = aiMeta.year || reqRow.year;
    const jobTitle = formatMediaJobTitle(aiMeta);
    const jobFileName = formatMediaFileName(aiMeta);
    const actualFileSize = quality.fileSize || "720p HD";

    // 6. Enqueue download
    const downloadReqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await db.insert(schema.downloads).values({
        requestId: downloadReqId,
        title: jobTitle,
        year: movieYear ? String(movieYear) : null,
        type: mediaType,
        status: "queued",
        season: mediaType === "series" ? (aiMeta.season || 1) : null,
        episode: mediaType === "series" ? (aiMeta.episode ?? null) : null,
        fileSize: actualFileSize,
        flickRequestId: reqRow.flickRequestId || null,
    });

    downloadQueue.addJob({
        requestId: downloadReqId,
        type: mediaType,
        title: jobTitle,
        cleanTitle: aiMeta.title,
        year: movieYear ? String(movieYear) : undefined,
        season: mediaType === "series" ? (aiMeta.season || 1) : undefined,
        episode: mediaType === "series" ? (aiMeta.episode ?? undefined) : undefined,
        servers: quality.servers,
        fileSize: actualFileSize,
        isBatchPack: quality.isBatchPack || Boolean(aiMeta.isBatch),
        fileName: jobFileName,
        flickRequestId: reqRow.flickRequestId || undefined,
    });

    // 7. Update requested_media status to "downloading"
    await db.update(schema.requestedMedia).set({
        status: "downloading",
        note: `Downloading ${jobTitle} (${actualFileSize})`,
        updatedAt: new Date(),
    }).where(eq(schema.requestedMedia.id, requestedMediaId));

    // 8. Send "downloading" webhook to Flick if this came from Flick
    if (reqRow.flickRequestId) {
        notifyFlickWebhook({
            id: reqRow.flickRequestId,
            status: "downloading",
            note: `Queued and downloading 720p HDR release (${actualFileSize}).`,
        }).catch(() => {});
    }

    // Broadcast WebSocket
    try {
        broadcastNewDownload({
            jobId: downloadReqId,
            title: jobTitle,
            type: mediaType,
            requestedBy: reqRow.requestedBy || "flick",
        });
    } catch {}

    console.log(`[AUTO-DOWNLOAD] Successfully queued "${jobTitle}" for request #${requestedMediaId}`);
    return {
        success: true,
        message: `Successfully queued "${jobTitle}" (${actualFileSize}) for high-speed CDN download!`,
        jobTitle,
        downloadId: downloadReqId,
    };
}

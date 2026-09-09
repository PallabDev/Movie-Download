import { getHarness } from "../../../command/harness.js";
import { db, schema } from "../../common/db/index.js";
import { lookupMedia, cleanMediaTitle } from "../../common/tmdb/client.js";
import { parseToolCall, KNOWN_TOOLS } from "./tool-parser.js";
import { executeTool, SYSTEM_PROMPT, clearWorkflow, searchSessions, type ToolResult } from "./tools.js";
import { broadcastAiStatus } from "./ws.js";

// ─── AGENT MEMORY (PostgreSQL) ───

async function saveMemory(sessionId: string, role: string, content: string) {
    try {
        await db.insert(schema.agentMemory).values({ sessionId, role, content });
    } catch (err: any) {
        console.error(`[MEMORY] Write error: ${err.message}`);
    }
}

// ─── VISUAL MEDIA CARD GENERATOR ───

// ─── VISUAL MEDIA CARD GENERATOR ───

export function formatVisualMediaReply(
    searchResults: any[],
    dlResult?: ToolResult,
    mediaFormats?: any
): string {
    if (!searchResults || searchResults.length === 0) {
        return "No matching releases found on the 10Gbps CDN network.";
    }

    const top = searchResults[0];
    const topTitle = top.name;
    const topThumb = top.thumbnail;
    const targetUrl = top.url;
    const categories = Array.isArray(top.category) ? top.category.filter(Boolean).join(", ") : "";
    const stars = Array.isArray(top.stars) ? top.stars.filter(Boolean).join(", ") : "";

    const escapeAttr = (str: string) => (str || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const safeUrl = escapeAttr(targetUrl);
    const safeTitle = escapeAttr(topTitle);

    let html = `
<div style="display: flex; gap: 14px; align-items: flex-start; margin-bottom: 12px; background: rgba(255, 255, 255, 0.03); padding: 12px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.08);">
    ${topThumb && !topThumb.includes("No-Image-Placeholder") ? `
        <img src="${topThumb}" alt="Poster" style="width: 76px !important; height: 112px !important; max-width: 76px !important; max-height: 112px !important; object-fit: cover !important; border-radius: 6px !important; box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important; flex-shrink: 0 !important; float: none !important; margin: 0 !important; display: block !important;" onerror="this.style.display='none'">
    ` : ''}
    <div style="flex: 1; min-width: 0;">
        <div style="font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 6px; line-height: 1.3;">🎬 ${topTitle}</div>
        ${categories ? `<div style="font-size: 12px; color: #94a3b8; margin-bottom: 4px;">🏷️ <strong>Categories:</strong> ${categories}</div>` : ''}
        ${stars ? `<div style="font-size: 12px; color: #94a3b8;">⭐ <strong>Cast:</strong> ${stars}</div>` : ''}
    </div>
</div>
`;

    if (dlResult?.success) {
        const d = dlResult.data;
        if (d?.isBatchPack) {
            html += `<div style="color: #34d399; font-weight: 600; margin-bottom: 10px;">⚡ Batch Season Pack Queued: Full season pack (${d.fileSize || "Season Pack"}) is downloading via 10Gbps CDN!</div>`;
        } else if (d?.queuedEpisodes?.length) {
            html += `<div style="color: #34d399; font-weight: 600; margin-bottom: 10px;">⚡ Episodes Queued: All ${d.queuedEpisodes.length} episodes are downloading via 10Gbps CDN!</div>`;
        } else {
            html += `<div style="color: #34d399; font-weight: 600; margin-bottom: 10px;">⚡ Download Queued: ${topTitle} (${d?.fileSize || "Direct"}) is downloading via 10Gbps CDN!</div>`;
        }
    } else if (mediaFormats) {
        if (mediaFormats.isSeries) {
            const batches = mediaFormats.seriesBatches || [];
            const episodes = mediaFormats.seriesEpisodes || [];

            if (batches.length > 0) {
                html += `
<div style="margin-top: 10px; margin-bottom: 12px;">
    <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">📦 Complete Season Batch Packs (1-Click Download)</div>
    <div style="display: flex; flex-direction: column; gap: 6px;">
        ${batches.map((b: any) => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.04); border: 1px solid ${b.isRecommended ? 'rgba(16,185,129,0.5)' : 'rgba(255,255,255,0.08)'}; border-radius: 6px; gap: 8px;">
                <div>
                    <div style="font-weight: 600; font-size: 13px; color: #fff;">${b.label}</div>
                    <div style="display: flex; gap: 6px; font-size: 11px; margin-top: 2px;">
                        <span style="background: rgba(56,189,248,0.2); color: #38bdf8; padding: 1px 5px; border-radius: 4px; font-weight: 600;">${b.resolution}</span>
                        ${b.fileSize ? `<span style="background: rgba(192,132,252,0.2); color: #c084fc; padding: 1px 5px; border-radius: 4px; font-weight: 600;">${b.fileSize}</span>` : ''}
                        ${b.isRecommended ? `<span style="background: rgba(52,211,153,0.2); color: #34d399; padding: 1px 5px; border-radius: 4px; font-weight: 600;">⭐ Recommended</span>` : ''}
                    </div>
                </div>
                <button class="btn-download-format ${b.isRecommended ? 'primary' : ''}" style="cursor: pointer; padding: 6px 12px; border-radius: 5px; font-weight: 600; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; background: ${b.isRecommended ? '#10b981' : 'rgba(255,255,255,0.1)'}; color: ${b.isRecommended ? '#000' : '#fff'}; border: none;" onclick="triggerSpecificFormatDownload('${safeUrl}', '${escapeAttr(b.qualityKey)}', '${safeTitle}', true, undefined, '${escapeAttr(b.fileSize)}', this)">
                    ⚡ Download Batch
                </button>
            </div>
        `).join('')}
    </div>
</div>`;
            }

            if (episodes.length > 0) {
                html += `
<div style="margin-top: 10px; margin-bottom: 12px;">
    <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">📺 Individual Episodes (${episodes.length} Episodes)</div>
    <div style="display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; padding-right: 4px;">
        ${episodes.map((ep: any) => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; gap: 6px; flex-wrap: wrap;">
                <span style="font-size: 12px; font-weight: 600; color: #fff;">${ep.title}</span>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    ${ep.qualities.map((q: any) => `
                        <button class="btn-ep-download" style="cursor: pointer; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.15);" onclick="triggerSpecificFormatDownload('${safeUrl}', '${escapeAttr(q.qualityKey)}', '${safeTitle}', false, ${ep.episodeNum}, '${escapeAttr(q.fileSize)}', this)">
                            ${q.label || q.resolution} <small style="color: #94a3b8;">(${q.fileSize})</small>
                        </button>
                    `).join('')}
                </div>
            </div>
        `).join('')}
    </div>
</div>`;
            }
        } else if (mediaFormats.movieFormats?.length > 0) {
            html += `
<div style="margin-top: 10px; margin-bottom: 12px;">
    <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">⚡ Available Download Formats (Direct 10Gbps CDN)</div>
    <div style="display: flex; flex-direction: column; gap: 6px;">
        ${mediaFormats.movieFormats.map((f: any) => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.04); border: 1px solid ${f.isRecommended ? 'rgba(16,185,129,0.5)' : 'rgba(255,255,255,0.08)'}; border-radius: 6px; gap: 8px;">
                <div>
                    <div style="font-weight: 600; font-size: 13px; color: #fff;">${f.label}</div>
                    <div style="display: flex; gap: 6px; font-size: 11px; margin-top: 2px;">
                        <span style="background: rgba(56,189,248,0.2); color: #38bdf8; padding: 1px 5px; border-radius: 4px; font-weight: 600;">${f.resolution}</span>
                        ${f.fileSize ? `<span style="background: rgba(192,132,252,0.2); color: #c084fc; padding: 1px 5px; border-radius: 4px; font-weight: 600;">${f.fileSize}</span>` : ''}
                        ${f.isRecommended ? `<span style="background: rgba(52,211,153,0.2); color: #34d399; padding: 1px 5px; border-radius: 4px; font-weight: 600;">⭐ Recommended</span>` : ''}
                    </div>
                </div>
                <button class="btn-download-format ${f.isRecommended ? 'primary' : ''}" style="cursor: pointer; padding: 6px 12px; border-radius: 5px; font-weight: 600; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; background: ${f.isRecommended ? '#10b981' : 'rgba(255,255,255,0.1)'}; color: ${f.isRecommended ? '#000' : '#fff'}; border: none;" onclick="triggerSpecificFormatDownload('${safeUrl}', '${escapeAttr(f.qualityKey)}', '${safeTitle}', false, undefined, '${escapeAttr(f.fileSize)}', this)">
                    ⚡ Download ${f.resolution}
                </button>
            </div>
        `).join('')}
    </div>
</div>`;
        }
    }

    if (searchResults.length > 1) {
        html += `
<div style="margin-top: 12px;">
    <div style="font-size: 12.5px; font-weight: 700; color: #fff; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px;">📦 Other Available Releases (${searchResults.length - 1} More)</div>
    <div style="display: flex; flex-direction: column; gap: 6px;">
        ${searchResults.slice(1, 5).map((item: any, idx: number) => {
            const optNum = idx + 2;
            return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; gap: 8px;">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-size: 12px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Option #${optNum}: ${item.name}</div>
                </div>
                <button class="btn-download-release" style="cursor: pointer; padding: 4px 10px; border-radius: 4px; font-size: 11.5px; font-weight: 600; background: rgba(255,255,255,0.08); color: #fff; border: 1px solid rgba(255,255,255,0.2); white-space: nowrap;" onclick="handleQuickPrompt('#${optNum}')">
                    ⚡ Option #${optNum} Formats
                </button>
            </div>`;
        }).join('')}
    </div>
</div>`;
    }

    return html;
}

// ─── CHAT HANDLER ───

export async function handleChat(
    userMessage: string,
    history: { role: string; content: string }[],
    sessionId: string
): Promise<{ reply: string; toolCalls: { tool: string; args: any; result: ToolResult }[]; meta?: any }> {
    const harness = getHarness();
    const toolCalls: { tool: string; args: any; result: ToolResult }[] = [];

    broadcastAiStatus(sessionId, { step: "thinking", label: "Thinking..." });

    const lowerMsg = userMessage.toLowerCase().trim();
    const isOptionOrNumber = /^#?\d+$/.test(lowerMsg);
    if (!isOptionOrNumber && (/^(hi|hello|hey|start|reset|clear|new|help|\?)/.test(lowerMsg) || (lowerMsg.length < 3 && !/^[1-9]$/.test(lowerMsg)))) {
        clearWorkflow(sessionId);
    }

    await saveMemory(sessionId, "user", userMessage);

    // ─── AUTONOMOUS FAST-PATH: DETECT SEARCH & FORMAT SELECTION ───
    const session = searchSessions.get(`session_${sessionId}`);
    const downloadNumMatch = lowerMsg.match(/^(?:download\s+(?:#?(\d+)|recommend|best|it|movie|series)|#?(\d+)|yes|confirm|ok)$/i);
    const isGreeting = /^(hi|hello|hey|start|reset|clear|new|help|how are you|what can you do|\?)$/i.test(lowerMsg);
    const isAction = /^(list|status|downloads|reconnect|all)$/i.test(lowerMsg);

    if (session && downloadNumMatch) {
        const optNum = downloadNumMatch[1] || downloadNumMatch[2];
        const optIdx = optNum ? parseInt(optNum, 10) : 1;
        const selectedItem = session.results[optIdx - 1] || session.results[0];

        broadcastAiStatus(sessionId, { step: "resolving_links", label: `Resolving download formats for Option #${optIdx}...` });
        harness.logActivity(`[CHAT FAST-PATH] Format lookup for Option #${optIdx}: "${selectedItem.name}"`);

        const formatsRes = await executeTool("get_media_formats", { targetUrl: selectedItem.url, sessionId }, sessionId);
        toolCalls.push({ tool: "get_media_formats", args: { targetUrl: selectedItem.url }, result: formatsRes });

        const reply = formatVisualMediaReply([selectedItem, ...session.results.filter((_, i) => i !== optIdx - 1)], undefined, formatsRes.data?.details);
        await saveMemory(sessionId, "ai", reply.substring(0, 500));
        return {
            reply,
            toolCalls,
            meta: {
                searchResults: { results: session.results, title: session.title },
                mediaFormats: formatsRes.data?.details,
                targetUrl: selectedItem.url
            }
        };
    } else if (isOptionOrNumber && !session) {
        const reply = `I'm ready to help you search and download movies & series! Tell me the movie or series title first (e.g. *Panchayat*, *Bahubali*, *Stree 2*).`;
        await saveMemory(sessionId, "ai", reply);
        return { reply, toolCalls };
    } else if (!isGreeting && !isAction && !isOptionOrNumber) {
        // Strip common search prefixes
        const titleToDl = lowerMsg
            .replace(/^(?:download|get|find|stream|watch|search(?:\s+for)?)\s+/i, "")
            .trim();

        if (titleToDl.length >= 2 && !/^(movie|series|it|recommend|best)$/i.test(titleToDl)) {
            broadcastAiStatus(sessionId, { step: "searching", label: `Searching releases for "${titleToDl}"...` });
            harness.logActivity(`[CHAT FAST-PATH] Searching releases for: "${titleToDl}"`);
            const sRes = await executeTool("search_media", { query: titleToDl }, sessionId);
            toolCalls.push({ tool: "search_media", args: { query: titleToDl }, result: sRes });

            if (sRes.success && sRes.data?.results?.length > 0) {
                const firstResult = sRes.data.results[0];
                broadcastAiStatus(sessionId, { step: "resolving_links", label: `Resolving download options for "${firstResult.name}"...` });

                const formatsRes = await executeTool("get_media_formats", { targetUrl: firstResult.url, sessionId }, sessionId);
                toolCalls.push({ tool: "get_media_formats", args: { targetUrl: firstResult.url }, result: formatsRes });

                const reply = formatVisualMediaReply(sRes.data.results, undefined, formatsRes.data?.details);
                await saveMemory(sessionId, "ai", reply.substring(0, 500));
                return {
                    reply,
                    toolCalls,
                    meta: {
                        searchResults: { results: sRes.data.results, title: sRes.data.title },
                        mediaFormats: formatsRes.data?.details,
                        targetUrl: firstResult.url
                    }
                };
            }
        }
    }

    // Pre-fetch TMDB metadata for enriched context if helpful
    let tmdbGroundTruth = "";
    try {
        const { title: cleanT, year: cleanY } = cleanMediaTitle(userMessage);
        if (cleanT && cleanT.length > 2 && !/^(hi|hello|hey|help|status|reconnect|clear)/i.test(cleanT)) {
            const mediaFacts = await lookupMedia(cleanT, cleanY);
            if (mediaFacts && mediaFacts.found) {
                tmdbGroundTruth = `\n\n[TMDB GROUND TRUTH FOR "${mediaFacts.title}"]:\n- Type: ${mediaFacts.type}\n- Release Year: ${mediaFacts.year}\n- Overview: ${mediaFacts.overview}`;
            }
        }
    } catch {}

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: SYSTEM_PROMPT + tmdbGroundTruth },
        ...history.map(m => ({ role: m.role as "system" | "user" | "assistant", content: m.content })),
        { role: "user", content: userMessage },
    ];

    const MAX_ITERATIONS = 8;

    try {
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            harness.logActivity(`[CHAT] AI iteration ${i + 1}`);

            let response = "";
            try {
                response = await harness.chat(messages);
            } catch (chatErr: any) {
                harness.logError(`[CHAT] harness.chat error: ${chatErr.message}`);
            }

            harness.logActivity(`[CHAT] AI output: ${(response || "").substring(0, 200)}`);

            const parsed = parseToolCall(response);

            if (parsed) {
                if (toolCalls.some(t => t.tool === parsed.tool)) {
                    harness.logActivity(`[CHAT] Skipping redundant tool call "${parsed.tool}" - already executed in this turn.`);
                    const existingTool = toolCalls.find(t => t.tool === parsed.tool)!;
                    messages.push({ role: "assistant", content: response });
                    messages.push({
                        role: "user",
                        content: `Tool "${parsed.tool}" already executed.\nResult: ${existingTool.result.message}\nData: ${JSON.stringify(existingTool.result.data || {})}\n\nPlease respond to the user in friendly Markdown with thumbnails and download status. DO NOT call any more tools.`
                    });
                    continue;
                }

                const toolLabels: Record<string, string> = {
                    search_media: "Searching high-speed 10Gbps CDN releases...",
                    search_movie: "Searching movie releases...",
                    search_series: "Searching series releases...",
                    get_media_formats: "Resolving available download formats & episodes...",
                    download_media: "Queueing download in background...",
                    download_movie: "Queueing movie download in background...",
                    download_series: "Queueing series download in background...",
                    check_jellyfin: "Checking Jellyfin media library...",
                    list_downloads: "Checking download queue status...",
                };

                if (toolLabels[parsed.tool]) {
                    broadcastAiStatus(sessionId, { step: parsed.tool, label: toolLabels[parsed.tool] });
                }

                harness.logActivity(`[CHAT] Executing tool: "${parsed.tool}" with args: ${JSON.stringify(parsed.args)}`);

                const result = await executeTool(parsed.tool, parsed.args, sessionId);
                toolCalls.push({ tool: parsed.tool, args: parsed.args, result });

                broadcastAiStatus(sessionId, { step: "analyzing", label: "Analyzing releases & download options..." });

                messages.push({ role: "assistant", content: response });
                messages.push({
                    role: "user",
                    content: `Tool "${parsed.tool}" executed.\nResult message: ${result.message}\nData: ${JSON.stringify(result.data || {})}\n\nNow respond to the user in conversational, friendly Markdown with poster thumbnails and all available formats/episodes. NEVER display raw JSON in your reply.`
                });
                continue;
            }

            let finalReply = (response || "").trim();
            const sTool = toolCalls.find(t => t.tool === "search_media" || t.tool === "search_movie" || t.tool === "search_series");
            let fmtTool = toolCalls.find(t => t.tool === "get_media_formats");
            const dlTool = toolCalls.find(t => t.tool === "download_media" || t.tool === "download_movie" || t.tool === "download_series");

            if (sTool?.result?.success && (sTool.result.data?.results?.length || 0) > 0 && !fmtTool) {
                const firstResult = sTool.result.data.results[0];
                const formatsRes = await executeTool("get_media_formats", { targetUrl: firstResult.url, sessionId }, sessionId);
                fmtTool = { tool: "get_media_formats", args: { targetUrl: firstResult.url }, result: formatsRes };
                toolCalls.push(fmtTool);
            }

            if (sTool?.result?.success && (sTool.result.data?.results?.length || 0) > 0) {
                finalReply = formatVisualMediaReply(sTool.result.data.results, dlTool?.result, fmtTool?.result?.data?.details);
            } else if (!finalReply) {
                if (toolCalls.length > 0) {
                    const lastTool = toolCalls[toolCalls.length - 1];
                    finalReply = lastTool.result.message ? `✅ ${lastTool.result.message}` : `Done processing your request!`;
                } else {
                    finalReply = `I'm ready to help you find movies & web series. What would you like to watch?`;
                }
            }

            await saveMemory(sessionId, "ai", finalReply.substring(0, 500));
            return {
                reply: finalReply,
                toolCalls,
                meta: {
                    searchResults: sTool?.result?.data,
                    mediaFormats: fmtTool?.result?.data?.details,
                    targetUrl: sTool?.result?.data?.results?.[0]?.url
                }
            };
        }

        const fallbackReply = toolCalls.length > 0
            ? `🎬 Request completed: ${toolCalls.map(t => t.result.message).join("; ")}`
            : "Done processing your request!";
        return { reply: fallbackReply, toolCalls };
    } catch (err: any) {
        harness.logError(`[CHAT] handleChat unexpected error: ${err.message}`);
        const fallbackReply = toolCalls.length > 0
            ? `🎬 Processed request: ${toolCalls.map(t => t.result.message).join("; ")}`
            : `⚠️ Sorry, there was an issue processing your request (${err.message}). Please try again!`;
        return { reply: fallbackReply, toolCalls };
    }
}

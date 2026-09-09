import { getHarness } from "../../../command/harness.js";
import { db, schema } from "../../common/db/index.js";
import { lookupMedia, cleanMediaTitle } from "../../common/tmdb/client.js";
import { parseToolCall, KNOWN_TOOLS } from "./tool-parser.js";
import { executeTool, SYSTEM_PROMPT, clearWorkflow, searchSessions, type ToolResult } from "./tools.js";
import { broadcastAiStatus } from "./ws.js";
import { checkMediaExists } from "../../common/jellyfin/client.js";

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

export function formatSearchResultsReply(title: string, results: any[]): string {
    return `Found **${results.length} available release${results.length > 1 ? 's' : ''}** for **"${title}"** on 10Gbps CDN.\n\nPlease select an option below to view all available download formats & qualities:`;
}

export function formatSelectedMediaReply(
    item: any,
    mediaFormats?: any
): string {
    if (!item) return "Select your preferred download format or episode below:";
    const title = item.name || "Selected Release";
    const categories = Array.isArray(item.category) ? item.category.filter(Boolean).join(", ") : "";
    const stars = Array.isArray(item.stars) ? item.stars.filter(Boolean).join(", ") : "";

    let md = `## 🎬 ${title}\n\n`;
    if (item.thumbnail && !item.thumbnail.includes("No-Image-Placeholder")) {
        md += `![Poster](${item.thumbnail})\n\n`;
    }
    if (categories) {
        md += `🏷️ **Categories**: ${categories}\n\n`;
    }
    if (stars) {
        md += `⭐ **Cast**: ${stars}\n\n`;
    }

    md += `*Select your preferred download format or episode below:*`;
    return md;
}

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
    const categories = Array.isArray(top.category) ? top.category.filter(Boolean).join(", ") : "";
    const stars = Array.isArray(top.stars) ? top.stars.filter(Boolean).join(", ") : "";

    let md = `## 🎬 ${topTitle}\n\n`;
    if (topThumb && !topThumb.includes("No-Image-Placeholder")) {
        md += `![Poster](${topThumb})\n\n`;
    }
    if (categories) {
        md += `🏷️ **Categories**: ${categories}\n\n`;
    }
    if (stars) {
        md += `⭐ **Cast**: ${stars}\n\n`;
    }

    if (dlResult?.success) {
        const d = dlResult.data;
        if (d?.isBatchPack) {
            md += `⚡ **Batch Season Pack Queued**: Full season pack (${d.fileSize || "Season Pack"}) is downloading at high speed via 10Gbps CDN!\n\n`;
        } else if (d?.queuedEpisodes?.length) {
            md += `⚡ **Episodes Queued**: All **${d.queuedEpisodes.length} episodes** are downloading via 10Gbps CDN!\n\n`;
        } else {
            md += `⚡ **Download Queued**: ${topTitle} (${d?.fileSize || "Direct"}) is downloading at high speed via 10Gbps CDN!\n\n`;
        }
    } else {
        md += `*Select your preferred download format or episode below:*`;
    }

    return md;
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
    const optRegex = /^(?:(?:download|select|choose|view|option|get)\s+)?(?:option\s*)?#?(\d+)$/i;
    const optMatch = lowerMsg.match(optRegex);
    const downloadWordMatch = lowerMsg.match(/^(?:download\s+(?:recommend|best|it|movie|series)|recommend|best|yes|confirm|ok)$/i);
    const isGreeting = /^(hi|hello|hey|start|reset|clear|new|help|how are you|what can you do|\?)$/i.test(lowerMsg);
    const isAction = /^(list|status|downloads|reconnect|all)$/i.test(lowerMsg);

    if (session && (optMatch || downloadWordMatch)) {
        const optNum = optMatch ? optMatch[1] : "1";
        const optIdx = optNum ? parseInt(optNum, 10) : 1;
        const selectedItem = session.results[optIdx - 1] || session.results[0];

        // Check if this media already exists in Jellyfin before providing download options
        const jfCheck = await checkMediaExists(selectedItem.name || session.title || "");
        if (jfCheck.exists) {
            harness.logActivity(`[CHAT JELLYFIN CHECK] Option #${optIdx} ("${selectedItem.name}") ALREADY in Jellyfin (${jfCheck.type})`);
            const reply = `## 🎬 ${selectedItem.name}\n\n` +
                (selectedItem.thumbnail && !selectedItem.thumbnail.includes("No-Image-Placeholder") ? `![Poster](${selectedItem.thumbnail})\n\n` : "") +
                `> 🍿 **Already in your Jellyfin Library!**\n> **"${jfCheck.item?.Name || selectedItem.name}"** is already stored on your media server and ready to stream in full quality. To conserve storage and bandwidth, re-downloading is not needed.`;

            await saveMemory(sessionId, "ai", reply.substring(0, 500));
            return {
                reply,
                toolCalls,
                meta: {
                    selectedOption: optIdx,
                    selectedItem,
                    alreadyInJellyfin: {
                        exists: true,
                        name: jfCheck.item?.Name || selectedItem.name,
                        type: jfCheck.type,
                        id: jfCheck.item?.Id,
                        year: jfCheck.item?.ProductionYear || jfCheck.item?.Year
                    },
                    searchResults: { results: session.results, title: session.title }
                }
            };
        }

        broadcastAiStatus(sessionId, { step: "resolving_links", label: `Resolving download formats for Option #${optIdx}...` });
        harness.logActivity(`[CHAT FAST-PATH] Format lookup for Option #${optIdx}: "${selectedItem.name}"`);

        const formatsRes = await executeTool("get_media_formats", { targetUrl: selectedItem.url, sessionId }, sessionId);
        toolCalls.push({ tool: "get_media_formats", args: { targetUrl: selectedItem.url }, result: formatsRes });

        const reply = formatSelectedMediaReply(selectedItem, formatsRes.data?.details);
        await saveMemory(sessionId, "ai", reply.substring(0, 500));
        return {
            reply,
            toolCalls,
            meta: {
                selectedOption: optIdx,
                selectedItem,
                mediaFormats: formatsRes.data?.details,
                targetUrl: selectedItem.url,
                alreadyInJellyfin: { exists: false },
                searchResults: { results: session.results, title: session.title }
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

            // Parallel lookup: CDN releases and Jellyfin library check
            const [sRes, jfCheck] = await Promise.all([
                executeTool("search_media", { query: titleToDl }, sessionId),
                checkMediaExists(titleToDl)
            ]);
            toolCalls.push({ tool: "search_media", args: { query: titleToDl }, result: sRes });

            if (sRes.success && sRes.data?.results?.length > 0) {
                const results = sRes.data.results;
                const searchTitle = sRes.data.title || titleToDl;
                let reply = formatSearchResultsReply(searchTitle, results);

                if (jfCheck.exists) {
                    reply = `> 🍿 **Already In Jellyfin**: **"${jfCheck.item?.Name || searchTitle}"** is already present in your Jellyfin ${jfCheck.type || "media"} library! You can stream it directly, or choose a release below if you need a different version.\n\n` + reply;
                }

                await saveMemory(sessionId, "ai", reply.substring(0, 500));
                return {
                    reply,
                    toolCalls,
                    meta: {
                        searchResults: { results, title: searchTitle },
                        alreadyInJellyfin: jfCheck.exists ? {
                            exists: true,
                            name: jfCheck.item?.Name || searchTitle,
                            type: jfCheck.type,
                            id: jfCheck.item?.Id,
                            year: jfCheck.item?.ProductionYear || jfCheck.item?.Year
                        } : { exists: false }
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

            if (fmtTool?.result?.success && fmtTool.result.data?.details) {
                const details = fmtTool.result.data.details;
                const selItem = sTool?.result?.data?.results?.[0] || { name: details.name, thumbnail: details.thumbnail };
                finalReply = formatSelectedMediaReply(selItem, details);
                await saveMemory(sessionId, "ai", finalReply.substring(0, 500));
                return {
                    reply: finalReply,
                    toolCalls,
                    meta: {
                        mediaFormats: details,
                        targetUrl: fmtTool.args?.targetUrl || details.url,
                        searchResults: sTool?.result?.data
                    }
                };
            }

            if (sTool?.result?.success && (sTool.result.data?.results?.length || 0) > 0) {
                const results = sTool.result.data.results;
                const searchTitle = sTool.result.data.title || userMessage;
                finalReply = formatSearchResultsReply(searchTitle, results);
                await saveMemory(sessionId, "ai", finalReply.substring(0, 500));
                return {
                    reply: finalReply,
                    toolCalls,
                    meta: {
                        searchResults: sTool.result.data
                    }
                };
            }

            if (!finalReply) {
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
                    searchResults: sTool?.result?.data
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

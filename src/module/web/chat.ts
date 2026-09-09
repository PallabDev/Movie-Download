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

export function formatVisualMediaReply(
    searchResults: any[],
    dlResult?: ToolResult
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
            md += `⚡ **720p Batch Season Pack Queued**: Full season pack (${d.fileSize || "720p"}) is downloading at high speed via 10Gbps CDN!\n\n`;
        } else if (d?.queuedEpisodes?.length) {
            md += `⚡ **720p Episodes Queued**: All **${d.queuedEpisodes.length} episodes** are downloading in 720p via 10Gbps CDN!\n\n`;
        } else {
            md += `⚡ **720p Direct Download Queued**: ${topTitle} (${d?.fileSize || "720p"}) is downloading at high speed via 10Gbps CDN!\n\n`;
        }
    } else if (dlResult?.message) {
        md += `⚡ **Download Status**: ${dlResult.message}\n\n`;
    }

    if (searchResults.length > 1) {
        md += `### 📦 Other Available Releases:\n`;
        for (let j = 1; j < Math.min(searchResults.length, 5); j++) {
            const item = searchResults[j];
            md += `- **Option #${j + 1}**: ${item.name}\n`;
        }
        md += `\n*Reply with \`#2\`, \`#3\`, etc. to switch to another release.*\n`;
    }

    return md;
}

// ─── CHAT HANDLER ───

export async function handleChat(
    userMessage: string,
    history: { role: string; content: string }[],
    sessionId: string
): Promise<{ reply: string; toolCalls: { tool: string; args: any; result: ToolResult }[] }> {
    const harness = getHarness();
    const toolCalls: { tool: string; args: any; result: ToolResult }[] = [];

    broadcastAiStatus(sessionId, { step: "thinking", label: "Thinking..." });

    const lowerMsg = userMessage.toLowerCase().trim();
    const isOptionOrNumber = /^#?\d+$/.test(lowerMsg);
    if (!isOptionOrNumber && (/^(hi|hello|hey|start|reset|clear|new|help|\?)/.test(lowerMsg) || (lowerMsg.length < 3 && !/^[1-9]$/.test(lowerMsg)))) {
        clearWorkflow(sessionId);
    }

    await saveMemory(sessionId, "user", userMessage);

    // ─── AUTONOMOUS FAST-PATH: DETECT SEARCH & DOWNLOAD INTENTS ───
    const session = searchSessions.get(`session_${sessionId}`);
    const downloadNumMatch = lowerMsg.match(/^(?:download\s+(?:#?(\d+)|recommend|best|it|movie|series)|#?(\d+)|yes|confirm|ok)$/i);
    const isGreeting = /^(hi|hello|hey|start|reset|clear|new|help|how are you|what can you do|\?)$/i.test(lowerMsg);
    const isAction = /^(list|status|downloads|reconnect|all)$/i.test(lowerMsg);

    if (session && downloadNumMatch) {
        const optNum = downloadNumMatch[1] || downloadNumMatch[2];
        const optIdx = optNum ? parseInt(optNum, 10) : 1;
        broadcastAiStatus(sessionId, { step: "starting_download", label: `Starting 720p download (Option #${optIdx})...` });
        harness.logActivity(`[CHAT FAST-PATH] Direct download selection (Option #${optIdx}) for "${session.title}"`);
        const result = await executeTool("download_media", { title: session.title, optionIndex: optIdx, sessionId }, sessionId);
        toolCalls.push({ tool: "download_media", args: { title: session.title, optionIndex: optIdx }, result });

        const selectedItem = session.results[optIdx - 1] || session.results[0];
        const reply = formatVisualMediaReply([selectedItem, ...session.results.filter((_, i) => i !== optIdx - 1)], result);
        await saveMemory(sessionId, "ai", reply.substring(0, 500));
        return { reply, toolCalls };
    } else if (isOptionOrNumber && !session) {
        const reply = `I'm ready to download movies & series in 720p! Please tell me the movie or series title first (e.g. *Panchayat*, *Bahubali*, *Stree 2*).`;
        await saveMemory(sessionId, "ai", reply);
        return { reply, toolCalls };
    } else if (!isGreeting && !isAction && !isOptionOrNumber) {
        // Strip common search/download prefixes
        const titleToDl = lowerMsg
            .replace(/^(?:download|get|find|stream|watch|search(?:\s+for)?)\s+/i, "")
            .trim();

        if (titleToDl.length >= 2 && !/^(movie|series|it|recommend|best)$/i.test(titleToDl)) {
            broadcastAiStatus(sessionId, { step: "searching", label: `Searching releases for "${titleToDl}"...` });
            harness.logActivity(`[CHAT FAST-PATH] Autonomous Search & Download for: "${titleToDl}"`);
            const sRes = await executeTool("search_media", { query: titleToDl }, sessionId);
            toolCalls.push({ tool: "search_media", args: { query: titleToDl }, result: sRes });

            if (sRes.success && sRes.data?.results?.length > 0) {
                const firstResult = sRes.data.results[0];
                broadcastAiStatus(sessionId, { step: "starting_download", label: `Queuing 720p download for "${firstResult.name}"...` });
                const dlRes = await executeTool("download_media", {
                    targetUrl: firstResult.url,
                    title: firstResult.name,
                    sessionId
                }, sessionId);
                toolCalls.push({ tool: "download_media", args: { targetUrl: firstResult.url, title: firstResult.name }, result: dlRes });

                const reply = formatVisualMediaReply(sRes.data.results, dlRes);
                await saveMemory(sessionId, "ai", reply.substring(0, 500));
                return { reply, toolCalls };
            }
        }
    }

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
                // If this exact tool was already executed in this turn, don't execute it again
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
                    download_media: "Starting 720p download in background...",
                    download_movie: "Starting movie download in background...",
                    download_series: "Starting series download in background...",
                    check_jellyfin: "Checking Jellyfin media library...",
                    list_downloads: "Checking download queue status...",
                };

                if (toolLabels[parsed.tool]) {
                    broadcastAiStatus(sessionId, { step: parsed.tool, label: toolLabels[parsed.tool] });
                }

                harness.logActivity(`[CHAT] Executing tool: "${parsed.tool}" with args: ${JSON.stringify(parsed.args)}`);

                const result = await executeTool(parsed.tool, parsed.args, sessionId);
                toolCalls.push({ tool: parsed.tool, args: parsed.args, result });

                broadcastAiStatus(sessionId, { step: "analyzing", label: "Analyzing releases & download servers..." });

                messages.push({ role: "assistant", content: response });
                messages.push({
                    role: "user",
                    content: `Tool "${parsed.tool}" executed.\nResult message: ${result.message}\nData: ${JSON.stringify(result.data || {})}\n\nNow respond to the user in conversational, friendly Markdown with poster thumbnails. NEVER display raw JSON in your reply.`
                });
                continue;
            }

            let finalReply = (response || "").trim();
            const sTool = toolCalls.find(t => t.tool === "search_media");
            const dlTool = toolCalls.find(t => t.tool === "download_media");

            // If LLM apologized or hallucinated an issue when search actually succeeded, format visual response
            const isApology = /apologize|technical issue|temporary issue|could not find/i.test(finalReply);
            if ((!finalReply || isApology) && sTool?.result?.success && (sTool.result.data?.results?.length || 0) > 0) {
                const results = sTool.result.data.results;
                const top = results[0];
                const topTitle = top.name;
                const topThumb = top.thumbnail;
                const categories = (top.category || []).join(", ");

                let md = `## 🎬 ${topTitle}\n\n`;
                if (topThumb && !topThumb.includes("No-Image-Placeholder")) {
                    md += `![Poster](${topThumb})\n\n`;
                }
                if (categories) {
                    md += `🏷️ **Categories**: ${categories}\n\n`;
                }
                if (dlTool?.result?.success) {
                    md += `⚡ **720p Direct Download Queued**: High-speed 10Gbps CDN download has started in the background!\n`;
                } else if (dlTool?.result?.message) {
                    md += `⚡ **Status**: ${dlTool.result.message}\n`;
                }

                if (results.length > 1) {
                    md += `\n### 📦 Other Available Releases:\n`;
                    for (let j = 1; j < Math.min(results.length, 4); j++) {
                        md += `- **Option #${j + 1}**: ${results[j].name}\n`;
                    }
                }
                finalReply = md;
            } else if (!finalReply) {
                if (toolCalls.length > 0) {
                    const lastTool = toolCalls[toolCalls.length - 1];
                    if (lastTool.result.data?.queuedEpisodes?.length > 0) {
                        finalReply = `🎬 Found and queued **${lastTool.result.data.queuedEpisodes.length} episodes** for **${lastTool.result.data.title || "series"}** in **720p** into the download queue!`;
                    } else if (lastTool.result.message) {
                        finalReply = `✅ ${lastTool.result.message}`;
                    } else {
                        finalReply = `Done processing your request!`;
                    }
                } else {
                    finalReply = `I'm ready to search and download movies & web series in 720p. What would you like to watch?`;
                }
            }

            // If search tool was executed but download wasn't, auto-trigger 720p download
            const hasSearch = toolCalls.some(t => t.tool.includes("search"));
            const hasDownload = toolCalls.some(t => t.tool.includes("download"));
            if (hasSearch && !hasDownload) {
                const sSession = searchSessions.get(`session_${sessionId}`);
                if (sSession && sSession.results.length > 0) {
                    const first = sSession.results[0];
                    harness.logActivity(`[AUTONOMOUS AUTO-DOWNLOAD] Automatically initiating 720p download for top result: "${first.name}"`);
                    const autoDl = await executeTool("download_media", { targetUrl: first.url, title: first.name, sessionId }, sessionId);
                    toolCalls.push({ tool: "download_media", args: { targetUrl: first.url, title: first.name }, result: autoDl });
                }
            }

            await saveMemory(sessionId, "ai", finalReply.substring(0, 500));
            return { reply: finalReply, toolCalls };
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

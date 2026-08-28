// TOOL CALL PARSER - Handles multiple AI output formats

const KNOWN_TOOLS = [
    "web_search", "search_movie", "search_series", "download_movie", "download_episode",
    "download_season", "check_jellyfin", "list_downloads", "bot_reconnect",
    "bot_auth_phone", "bot_auth_code", "bot_auth_password", "bot_auth_status"
];

export function parseToolCall(text: string): { tool: string; args: Record<string, any> } | null {

    // Format 1: JSON {"tool": "name", "args": {...}}
    const jsonRegex = /\{"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/;
    const jsonMatch = text.match(jsonRegex);
    if (jsonMatch) {
        const tool = jsonMatch[1];
        if (!KNOWN_TOOLS.includes(tool)) return null;
        let args: Record<string, any> = {};
        try { args = JSON.parse(jsonMatch[2]); } catch {}
        return { tool, args };
    }

    // Format 2: XML tool_call with function= and parameter tags
    const tcMatch = text.match(/tool_call[^>]*>([\s\S]*?)<\/tool_call/i);
    if (tcMatch) {
        const inner = tcMatch[1];
        const funcMatch = inner.match(/function=([a-z_]+)/i);
        if (funcMatch) {
            const tool = funcMatch[1];
            if (!KNOWN_TOOLS.includes(tool)) return null;
            const args: Record<string, any> = {};
            const paramRegex = /parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter/gi;
            let m;
            while ((m = paramRegex.exec(inner)) !== null) {
                args[m[1]] = m[2].trim();
            }
            if (Object.keys(args).length === 0) {
                const kvRegex = /([a-z_]+)\s*=\s*([^\s<]+)/gi;
                let kv;
                while ((kv = kvRegex.exec(inner)) !== null) {
                    args[kv[1]] = kv[2].replace(/["']/g, "");
                }
            }
            return { tool, args };
        }
    }

    // Format 3: bare function call like bot_reconnect() or web_search("query")
    for (const tool of KNOWN_TOOLS) {
        const bareRegex = new RegExp(tool + "\\s*\\(([^)]*)\\)", "i");
        const bareMatch = text.match(bareRegex);
        if (bareMatch) {
            const args: Record<string, any> = {};
            const argStr = bareMatch[1].trim();
            if (argStr) {
                const kvPairs = argStr.split(",");
                for (const kv of kvPairs) {
                    const parts = kv.split("=");
                    if (parts.length === 2) {
                        args[parts[0].trim()] = parts[1].trim().replace(/["']/g, "");
                    } else {
                        const paramNames: Record<string, string[]> = {
                            web_search: ["query"],
                            search_movie: ["title"],
                            search_series: ["title"],
                            check_jellyfin: ["title"],
                            download_movie: ["title"],
                            download_episode: ["title"],
                            download_season: ["title"],
                            bot_auth_phone: ["phone"],
                            bot_auth_code: ["code"],
                            bot_auth_password: ["password"],
                        };
                        const params = paramNames[tool];
                        if (params && params.length === 1) {
                            args[params[0]] = kv.trim().replace(/["']/g, "");
                        }
                    }
                }
            }
            return { tool, args };
        }
    }

    return null;
}

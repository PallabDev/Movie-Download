import fs from "node:fs";
import path from "node:path";

export interface TelegramAuditEntry {
    timestamp: string;
    action: "SEND_QUERY" | "RECEIVE_RESPONSE" | "CLICK_BUTTON" | "QUEUE_DOWNLOAD" | "NO_RESULTS" | "ERROR";
    bot: string;
    query?: string;
    sentMsgId?: number;
    responseMsgId?: number;
    resultsCount?: number;
    resultsPreview?: string[];
    selectedButton?: string;
    caller: string;
    details?: any;
}

const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "telegram_audit.log");

// In-memory buffer of recent logs
const recentAuditLogs: TelegramAuditEntry[] = [];
const MAX_IN_MEMORY = 200;

function ensureLogDir() {
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
    } catch {}
}

export function logTelegramAudit(entry: Omit<TelegramAuditEntry, "timestamp">) {
    const timestamp = new Date().toISOString();
    const fullEntry: TelegramAuditEntry = { timestamp, ...entry };

    // 1. Keep in memory
    recentAuditLogs.unshift(fullEntry);
    if (recentAuditLogs.length > MAX_IN_MEMORY) {
        recentAuditLogs.pop();
    }

    // 2. Format console log line
    const tag = `[TG AUDIT ${fullEntry.action}]`;
    const callerTag = `[${fullEntry.caller}]`;
    const botTag = `@${fullEntry.bot}`;

    if (fullEntry.action === "SEND_QUERY") {
        console.log(`📡 ${tag} ${callerTag} -> ${botTag}: "${fullEntry.query}"`);
    } else if (fullEntry.action === "RECEIVE_RESPONSE") {
        console.log(`📥 ${tag} ${callerTag} <- ${botTag}: Found ${fullEntry.resultsCount} buttons for query "${fullEntry.query}"`);
    } else if (fullEntry.action === "CLICK_BUTTON") {
        console.log(`🔘 ${tag} ${callerTag} on ${botTag}: Clicked "${fullEntry.selectedButton}"`);
    } else if (fullEntry.action === "QUEUE_DOWNLOAD") {
        console.log(`💾 ${tag} ${callerTag}: Queued "${fullEntry.selectedButton || fullEntry.query}"`);
    } else if (fullEntry.action === "NO_RESULTS") {
        console.warn(`⚠️ ${tag} ${callerTag} ${botTag}: No results for "${fullEntry.query}"`);
    } else if (fullEntry.action === "ERROR") {
        console.error(`❌ ${tag} ${callerTag} ${botTag}: Error on "${fullEntry.query}": ${fullEntry.details?.error || ""}`);
    }

    // 3. Append to persistent file
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o777 });
        }
        const line = JSON.stringify(fullEntry) + "\n";
        fs.appendFileSync(LOG_FILE, line, "utf8");
    } catch {
        try {
            fs.appendFileSync("logs.md", `[${timestamp}] ${JSON.stringify(fullEntry)}\n`, "utf8");
        } catch {}
    }
}

export function getRecentTelegramAuditLogs(limit: number = 50): TelegramAuditEntry[] {
    return recentAuditLogs.slice(0, limit);
}

export function getTelegramAuditLogFilePath(): string {
    return LOG_FILE;
}

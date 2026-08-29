import "node:process";
import { TelegramClient } from "teleproto";
import { StoreSession } from "teleproto/sessions/index.js";

import { env } from "../../common/utils/env.js";

const apiId = Number(env.TG_API_ID);
const apiHash = env.TG_API_HASH;

// Disk-backed session — persists under ./bot-session/
const session = new StoreSession("bot-session");

const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 10,
    autoReconnect: true,
    downloadPool: {
        partSize: 1024 * 1024,
        requestDeadlineMs: 20000,
        requestRetries: 8,
        download: {
            partSize: 1024 * 1024,
            startWindow: 8 * 1024 * 1024,
            maxWindow: 16 * 1024 * 1024,
            startSessions: 4,
            maxSessions: 8,
            slowRequestMs: 6000,
            removeAfterTimeouts: 5,
            addSessionGateMs: 500,
        }
    }
});

let _connected = false;
let _connecting = false;

export function isBotConnected(): boolean {
    return _connected;
}

export function isBotConnecting(): boolean {
    return _connecting;
}

export function setBotConnected(val: boolean) {
    _connected = val;
}

export function setBotConnecting(val: boolean) {
    _connecting = val;
}

// ─── Web-based Auth State Machine ───
// Used when bot needs re-auth from the web UI

type AuthStep = "idle" | "need_phone" | "need_code" | "need_password" | "authenticating" | "done" | "error";

let authState: {
    step: AuthStep;
    phone?: string;
    code?: string;
    password?: string;
    error?: string;
    phoneResolver?: (value: string) => void;
    codeResolver?: (value: string) => void;
    passwordResolver?: (value: string) => void;
} = { step: "idle" };

export function getAuthState() {
    return { step: authState.step, error: authState.error, phone: authState.phone };
}

export function submitPhone(phone: string): { ok: boolean; error?: string } {
    if (authState.step !== "need_phone") return { ok: false, error: "Not waiting for phone" };
    authState.phone = phone;
    authState.phoneResolver?.(phone);
    authState.phoneResolver = undefined;
    authState.step = "authenticating";
    return { ok: true };
}

export function submitCode(code: string): { ok: boolean; error?: string } {
    if (authState.step !== "need_code") return { ok: false, error: "Not waiting for code" };
    authState.code = code;
    authState.codeResolver?.(code);
    authState.codeResolver = undefined;
    authState.step = "authenticating";
    return { ok: true };
}

export function submitPassword(password: string): { ok: boolean; error?: string } {
    if (authState.step !== "need_password") return { ok: false, error: "Not waiting for password" };
    authState.password = password;
    authState.passwordResolver?.(password);
    authState.passwordResolver = undefined;
    authState.step = "authenticating";
    return { ok: true };
}

export async function startWebAuth(): Promise<{ ok: boolean; step?: string; error?: string }> {
    if (_connected) return { ok: true, step: "done" };
    if (_connecting) return { ok: false, error: "Already connecting" };

    // Reset state
    authState = { step: "need_phone" };

    setBotConnecting(true);

    try {
        await client.start({
            phoneNumber: async () => {
                authState.step = "need_phone";
                console.log("[BOT AUTH] Waiting for phone number...");
                return new Promise<string>((resolve) => {
                    authState.phoneResolver = resolve;
                });
            },
            phoneCode: async () => {
                authState.step = "need_code";
                console.log("[BOT AUTH] Waiting for code...");
                return new Promise<string>((resolve) => {
                    authState.codeResolver = resolve;
                });
            },
            password: async () => {
                authState.step = "need_password";
                console.log("[BOT AUTH] Waiting for 2FA password...");
                return new Promise<string>((resolve) => {
                    authState.passwordResolver = resolve;
                });
            },
            onError: async (err: Error) => {
                console.error("[BOT AUTH] Error:", err.message);
                authState.step = "error";
                authState.error = err.message;
                return false;
            },
        });

        const me = await client.getMe();
        setBotConnected(true);
        setBotConnecting(false);
        authState.step = "done";
        console.log(`[BOT AUTH] Connected as ${me.username ?? me.firstName}`);
        return { ok: true, step: "done" };
    } catch (err: any) {
        setBotConnecting(false);
        authState.step = "error";
        authState.error = err.message;
        console.error("[BOT AUTH] Failed:", err.message);
        return { ok: false, error: err.message };
    }
}

export default client;

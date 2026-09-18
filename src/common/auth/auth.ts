import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const SALT_ROUNDS = 10;

export type UserRole = "user" | "mod" | "admin";

export interface TokenPayload {
    userId: number;
    email: string;
    role: string;
}

export async function register(
    email: string,
    password: string,
    name: string,
    role: UserRole = "user"
) {
    // Check if user exists
    const existing = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);

    if (existing.length > 0) {
        throw new Error("Email already registered");
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await db
        .insert(schema.users)
        .values({ email, password: hashedPassword, name, role })
        .returning({ id: schema.users.id });

    return { id: result[0].id, email, name, role };
}

export async function login(email: string, password: string) {
    const users = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);

    if (users.length === 0) {
        throw new Error("Invalid email or password");
    }

    const user = users[0];
    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
        throw new Error("Invalid email or password");
    }

    const token = generateToken({
        userId: user.id,
        email: user.email,
        role: user.role,
    });

    return {
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
}

export function generateToken(payload: TokenPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): TokenPayload | null {
    try {
        return jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch {
        return null;
    }
}

export async function getUserById(id: number) {
    const users = await db
        .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role })
        .from(schema.users)
        .where(eq(schema.users.id, id))
        .limit(1);
    return users[0] || null;
}

export async function getAllUsers() {
    return db
        .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role, createdAt: schema.users.createdAt })
        .from(schema.users)
        .orderBy(schema.users.id);
}

export async function updateUser(
    id: number,
    data: { name?: string; email?: string; role?: UserRole; password?: string }
) {
    const existing = await getUserById(id);
    if (!existing) {
        throw new Error("User not found");
    }

    if (data.email && data.email !== existing.email) {
        const emailCheck = await db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.email, data.email))
            .limit(1);
        if (emailCheck.length > 0 && emailCheck[0].id !== id) {
            throw new Error("Email already registered by another account");
        }
    }

    const updates: Record<string, any> = {};
    if (data.name && data.name.trim()) updates.name = data.name.trim();
    if (data.email && data.email.trim()) updates.email = data.email.trim();
    if (data.role && ["user", "mod", "admin"].includes(data.role)) updates.role = data.role;
    if (data.password && data.password.trim().length > 0) {
        updates.password = await bcrypt.hash(data.password, SALT_ROUNDS);
    }

    if (Object.keys(updates).length > 0) {
        await db
            .update(schema.users)
            .set(updates)
            .where(eq(schema.users.id, id));
    }

    return getUserById(id);
}

export async function deleteUser(id: number) {
    return db.delete(schema.users).where(eq(schema.users.id, id));
}

// Middleware helper: extract user from cookie/header
export function extractUser(req: { headers: { authorization?: string; cookie?: string; host?: string } }): TokenPayload | null {
    // Try Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        return verifyToken(authHeader.slice(7));
    }

    // Try cookie
    const cookie = req.headers.cookie;
    if (cookie) {
        const match = cookie.match(/token=([^;]+)/);
        if (match) {
            const payload = verifyToken(match[1]);
            return payload;
        }
    }

    return null;
}

/**
 * Attempt to refresh a token that is either currently valid or expired within grace period.
 * Verifies cryptographic signature using JWT_SECRET and checks database that user still exists.
 */
export async function tryRefreshToken(token: string, maxExpiredAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<{ token: string; user: { id: number; email: string; name: string; role: string } } | null> {
    if (!token) return null;

    let payload: TokenPayload | null = null;

    // 1. If currently valid, we can refresh it directly
    try {
        payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    } catch (err: any) {
        if (err?.name === "TokenExpiredError") {
            // Check if within grace period
            try {
                const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true }) as (TokenPayload & { exp?: number });
                if (decoded && decoded.exp) {
                    const expiredAtMs = decoded.exp * 1000;
                    const elapsedSinceExpiry = Date.now() - expiredAtMs;
                    if (elapsedSinceExpiry <= maxExpiredAgeMs) {
                        payload = {
                            userId: decoded.userId,
                            email: decoded.email,
                            role: decoded.role
                        };
                    }
                }
            } catch {
                return null;
            }
        } else {
            return null;
        }
    }

    if (!payload || !payload.userId) {
        return null;
    }

    // Verify user still exists in database (or fall back to payload if DB temporarily unreachable)
    let user: any = null;
    try {
        user = await getUserById(payload.userId);
    } catch {
        user = { id: payload.userId, email: payload.email, name: payload.email.split("@")[0], role: payload.role };
    }

    if (!user) {
        return null;
    }

    // Generate fresh 7-day token
    const newToken = generateToken({
        userId: user.id,
        email: user.email,
        role: user.role
    });

    return {
        token: newToken,
        user: { id: user.id, email: user.email, name: user.name, role: user.role }
    };
}

/**
 * Middleware helper: extract user from cookie/header with optional automatic transparent refresh
 */
export async function extractUserAsync(req: any, res?: any): Promise<TokenPayload | null> {
    // 1. Try Authorization header
    const authHeader = req.headers?.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        const verified = verifyToken(token);
        if (verified) return verified;
        const refreshed = await tryRefreshToken(token);
        if (refreshed) {
            return { userId: refreshed.user.id, email: refreshed.user.email, role: refreshed.user.role };
        }
        return null;
    }

    // 2. Try cookie
    const cookie = req.headers?.cookie;
    if (cookie) {
        const match = cookie.match(/token=([^;]+)/);
        if (match) {
            const token = match[1];
            const verified = verifyToken(token);
            if (verified) return verified;

            // Token expired: attempt transparent refresh
            const refreshed = await tryRefreshToken(token);
            if (refreshed) {
                if (res && typeof res.cookie === "function") {
                    res.cookie("token", refreshed.token, {
                        httpOnly: true,
                        maxAge: 7 * 24 * 60 * 60 * 1000,
                        sameSite: "lax",
                        path: "/"
                    });
                }
                return { userId: refreshed.user.id, email: refreshed.user.email, role: refreshed.user.role };
            }
        }
    }

    return null;
}

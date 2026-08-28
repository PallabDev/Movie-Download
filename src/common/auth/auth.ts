import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const SALT_ROUNDS = 10;

export interface TokenPayload {
    userId: number;
    email: string;
    role: string;
}

export async function register(
    email: string,
    password: string,
    name: string,
    role: "user" | "admin" = "user"
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
        .from(schema.users);
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
    console.log(`[AUTH] Host: ${req.headers.host}, Cookie header: ${cookie ? cookie.substring(0, 80) + "..." : "NONE"}`);
    if (cookie) {
        const match = cookie.match(/token=([^;]+)/);
        if (match) {
            const payload = verifyToken(match[1]);
            console.log(`[AUTH] Token valid: ${!!payload}, role: ${payload?.role}`);
            return payload;
        }
    }

    return null;
}

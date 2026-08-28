import {
    pgTable,
    serial,
    varchar,
    text,
    timestamp,
    boolean,
    integer,
    jsonb,
} from "drizzle-orm/pg-core";

// Users table
export const users = pgTable("users", {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    password: varchar("password", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).notNull().default("user"), // "user" | "admin"
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Downloads table
export const downloads = pgTable("downloads", {
    id: serial("id").primaryKey(),
    requestId: varchar("request_id", { length: 100 }).notNull().unique(),
    title: varchar("title", { length: 500 }).notNull(),
    year: varchar("year", { length: 10 }),
    type: varchar("type", { length: 20 }).notNull(), // "movie" | "series"
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    // pending | analyzing | searching | clicking | downloading | completed | failed | skipped
    quality: varchar("quality", { length: 20 }),
    fileSize: varchar("file_size", { length: 50 }),
    downloadPath: text("download_path"),
    season: integer("season"),
    episode: integer("episode"),
    totalEpisodes: integer("total_episodes"),
    jellyfinExists: boolean("jellyfin_exists").default(false),
    error: text("error"),
    progress: integer("progress").default(0), // 0-100
    speed: varchar("speed", { length: 50 }),
    eta: varchar("eta", { length: 50 }),
    requestedBy: integer("requested_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Agent memory
export const agentMemory = pgTable("agent_memory", {
    id: serial("id").primaryKey(),
    sessionId: varchar("session_id", { length: 100 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(), // "user" | "ai" | "tool" | "web"
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Activity logs
export const activityLogs = pgTable("activity_logs", {
    id: serial("id").primaryKey(),
    level: varchar("level", { length: 20 }).notNull(), // "info" | "error" | "warn"
    message: text("message").notNull(),
    source: varchar("source", { length: 50 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

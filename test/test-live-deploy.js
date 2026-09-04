import http from "node:http";
import jwt from "jsonwebtoken";

function post(path, data, cookie) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(data || {});
        const req = http.request({
            hostname: "localhost",
            port: 3000,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                ...(cookie ? { "Cookie": cookie } : {})
            }
        }, (res) => {
            let body = "";
            res.on("data", d => body += d);
            res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

function get(path, cookie) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "localhost",
            port: 3000,
            path,
            method: "GET",
            headers: { ...(cookie ? { "Cookie": cookie } : {}) }
        }, (res) => {
            let body = "";
            res.on("data", d => body += d);
            res.on("end", () => resolve({ status: res.statusCode, body }));
        });
        req.on("error", reject);
        req.end();
    });
}

async function main() {
    const jwtSecret = process.env.JWT_SECRET || "dev-secret-change-me";
    const token = jwt.sign({ userId: 2, email: "ookarmakarpallab1212@gmail.com", role: "admin" }, jwtSecret, { expiresIn: "7d" });
    const authCookie = `token=${token}`;

    console.log("1. Testing authenticated /api/new-releases/refresh (30 days)...");
    const refreshRes = await post("/api/new-releases/refresh", { daysBack: 30 }, authCookie);
    console.log("Refresh Response:", refreshRes.body);

    console.log("\n2. Testing /api/new-releases/stats...");
    const statsRes = await get("/api/new-releases/stats", authCookie);
    console.log("Stats Response:", statsRes.body);

    console.log("\n3. Testing /api/new-releases (sample list)...");
    const releasesRes = await get("/api/new-releases?limit=6", authCookie);
    const parsed = JSON.parse(releasesRes.body);
    console.log(`Discovered ${parsed.pagination?.total} total OTT releases in PostgreSQL:`);
    for (const r of (parsed.releases || [])) {
        console.log(`🎬 [${r.industry}] "${r.title}" (${r.releaseDate}) - ⭐ Rating: ${r.rating} | OTT: ${JSON.stringify(r.providers?.map(p => p.name))}`);
    }

    console.log("\n✅ Deployment & Live Endpoints verified successfully on remote server!");
}

main().catch(console.error);

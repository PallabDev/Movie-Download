async function testEndpoints() {
    console.log("--- Logging in as admin ---");
    const loginRes = await fetch("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@admin.com", password: "admin123" }),
    });
    const cookie = loginRes.headers.get("set-cookie") || "";
    console.log("Login status:", loginRes.status, "Cookie obtained:", cookie ? "YES" : "NO");

    const headers = { Cookie: cookie, "Content-Type": "application/json" };

    console.log("\n--- Testing Bot Status (/api/bot/status) ---");
    const botRes = await fetch("http://localhost:3000/api/bot/status", { headers });
    const botData = await botRes.json();
    console.log("Bot status response:", botData);

    console.log("\n--- Testing Requested Media (/api/requested-media) ---");
    const addMediaRes = await fetch("http://localhost:3000/api/requested-media", {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Inception", type: "movie", year: "2010" }),
    });
    console.log("Add requested media:", await addMediaRes.json());

    const getMediaRes = await fetch("http://localhost:3000/api/requested-media", { headers });
    const mediaData = await getMediaRes.json();
    console.log("Requested media items:", mediaData.items.length, "items found. First:", mediaData.items[0]?.title);

    console.log("\n--- Testing Downloads API & Controls ---");
    const dlRes = await fetch("http://localhost:3000/api/downloads", { headers });
    const dlData = await dlRes.json();
    console.log("Downloads list:", dlData.downloads?.length, "downloads");

    console.log("\n--- Testing Jellyfin Stats & Series Endpoints ---");
    const jfStats = await fetch("http://localhost:3000/api/jellyfin/stats", { headers });
    console.log("Jellyfin stats:", await jfStats.json());

    const jfSeries = await fetch("http://localhost:3000/api/jellyfin/series", { headers });
    console.log("Jellyfin series status:", jfSeries.status);

    console.log("\n✅ ALL ENDPOINT CHECKS COMPLETE!");
}

testEndpoints().catch(console.error);

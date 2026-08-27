const JELLYFIN_URL = "https://movie.pallabdev.in";
const TOKEN = "ec6627aa89a4485fa41f7235ca3b1656";

const url = new URL(`${JELLYFIN_URL}/Items`);

url.searchParams.set("IncludeItemTypes", "Movie");
url.searchParams.set("Recursive", "true");
url.searchParams.set("Limit", "10000");

const response = await fetch(url, {
    headers: {
        "X-Emby-Token": TOKEN,
    },
});

if (!response.ok) {
    throw new Error(
        `Jellyfin request failed: ${response.status} ${response.statusText}`
    );
}

const data = await response.json();

for (const movie of data.Items) {
    console.log(movie.Name);
}

console.log(`\nTotal movies: ${data.Items.length}`);

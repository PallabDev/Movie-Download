# Cloudflare-Bypassing Web Scraper (FastAPI + uv + Docker)

A high-performance, browserless web scraping service designed to bypass Cloudflare bot protection and TLS/JA3/JA4 fingerprinting using **FastAPI**, **uv**, and **`curl_cffi`** (powered by `curl-impersonate`).

---

## 🚀 Features

- **No Headless Browser Required**: Uses network-level browser TLS and HTTP/2 fingerprint impersonation (JA3/JA4) via `curl_cffi`, saving ~95% memory and CPU compared to Playwright / Puppeteer.
- **FastAPI + AsyncIO**: Built for high concurrency and async execution.
- **Astral `uv` Package Manager**: Blazing fast dependency resolution and execution.
- **Dockerized**: Pre-configured `Dockerfile` and `docker-compose.yml`.
- **Automatic Domain Rewriter**: Automatically rewrites outdated domains (e.g., `new1.hdhub4u.af`) to active domains (e.g., `new5.hdhub4u.cl`).
- **All-Pages Auto-Scraping**: Automatically scrapes and aggregates all pagination pages.
- **Direct Download & Stream Link Extractor**: Scrapes movie detail pages to extract exact 480p, 720p, 1080p, 4K, and Stream URLs with file sizes and screenshots.
- **Interactive Web Dashboard**: Built-in dark UI on `http://localhost:8000` with visual cards, table view, download links modal, and JSON inspector.

---

## 🛠️ Quick Start with Docker Compose

### 1. Build and Run Container
```bash
docker compose up -d --build
```

### 2. Open the Web Dashboard
Visit [http://localhost:8000](http://localhost:8000) in your browser.

### 3. Check Logs
```bash
docker compose logs -f
```

### 4. Stop Service
```bash
docker compose down
```

---

## 📡 API Endpoints

### 1. Scrape Movie Download Links (`/api/scrape/movie`)
Fetches any movie detail page and returns all download qualities, file sizes, and stream links.
```bash
curl "http://localhost:8000/api/scrape/movie?url=https://new5.hdhub4u.cl/bahubali-2-the-conclusion-2017-hindi-bluray-full-movie/"
```

**Example Response:**
```json
{
  "page_url": "https://new5.hdhub4u.cl/bahubali-2-the-conclusion-2017-hindi-bluray-full-movie/",
  "title": "Bahubali 2: The Conclusion (2017) BluRay [Hindi DD5.1] 1080p 720p & 480p",
  "synopsis": "...",
  "screenshots": ["https://catimages.co/images/2024/01/08/vlcsnap-...th.png"],
  "download_links": [
    {
      "label": "480p Links [620MB]",
      "quality": "480p",
      "size": "620MB",
      "download_url": "https://greenmountmotors.com/?id=...",
      "type": "Download"
    },
    {
      "label": "720p Links [1.4GB]",
      "quality": "720p",
      "size": "1.4GB",
      "download_url": "https://greenmountmotors.com/?id=...",
      "type": "Download"
    },
    {
      "label": "1080p Links [3.2GB]",
      "quality": "1080p",
      "size": "3.2GB",
      "download_url": "https://greenmountmotors.com/?id=...",
      "type": "Download"
    },
    {
      "label": "WATCH ONLiNE",
      "quality": "Watch Online / Stream",
      "size": "",
      "download_url": "https://greenmountmotors.com/?id=...",
      "type": "Stream"
    }
  ],
  "total_download_links": 6
}
```

---

### 2. Scrape Search Query (`/api/scrape/search`)
```bash
curl "http://localhost:8000/api/scrape/search?q=bahubali&fetch_all=true"
```

---

### 3. Scrape Target URL (`/api/scrape/url`)
```bash
curl "http://localhost:8000/api/scrape/url?url=https://new5.hdhub4u.cl/search.html?q=bahubali%202017"
```

---

### 4. Health Check
```bash
curl "http://localhost:8000/api/health"
```

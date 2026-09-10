import asyncio
import base64
import codecs
import json
import re
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple
from bs4 import BeautifulSoup
from curl_cffi.requests import AsyncSession

DEFAULT_BASE_DOMAIN = "https://new5.hdhub4u.cl"
LANDING_PAGE_URL = "https://hdhub4u.bi/"
SEARCH_BACKEND_URL = "https://search.pingora.fyi/collections/post/documents/search"
DEFAULT_IMPERSONATE = "chrome124"
DEFAULT_TIMEOUT = 25

HOST_ENDPOINTS = [
    "https://h4.suncdn.org/host/",
    "https://points.topapii.com/host/",
    "https://ml.theapii.org/host/",
    "https://dns.pingora.fyi/v2/host",
    "https://cdn.hub4u.cloud/host/",
]

# In-memory cache for discovered domain
_cached_active_domain: Optional[str] = None


class CloudflareScraper:
    """
    Multi-stage browserless scraping & direct download resolution engine:
    1. Dynamic Domain Discovery: Auto-fetch working domain from https://hdhub4u.bi/
    2. Search: Query Pingora/Typesense search engine and rewrite permalinks to working domain
    3. Movie / TV Series Scraper: Extract storyline, posters, screenshots, batch season packs, and episode-wise links
    4. Intermediate Bypass: Instant 0s bypass of mediator redirect sites (greenmountmotors, etc.)
    5. Final Link Resolver: Extract 10Gbps High-Speed & Direct CDN (.mkv/.zip) download links from HubCloud / HBLinks
    """

    @staticmethod
    def _get_browser_headers(referer: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        }
        if referer:
            headers["Referer"] = referer
            parsed = urllib.parse.urlsplit(referer)
            headers["Origin"] = f"{parsed.scheme}://{parsed.netloc}"
        return headers

    @classmethod
    async def get_active_domain(cls, impersonate: str = DEFAULT_IMPERSONATE, force_refresh: bool = False) -> str:
        """
        Step 1: Automatically discovers the current working HDHub4u domain from https://hdhub4u.bi/
        """
        global _cached_active_domain
        if _cached_active_domain and not force_refresh:
            return _cached_active_domain

        headers = cls._get_browser_headers()
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            # 1. Try host discovery endpoints first
            for host_url in HOST_ENDPOINTS:
                try:
                    res = await session.get(host_url, headers=headers, timeout=10)
                    if res.status_code == 200:
                        data = res.json()
                        if "c" in data:
                            raw_target = base64.b64decode(data["c"]).decode("utf-8")
                            parsed = urllib.parse.urlsplit(raw_target)
                            active_domain = f"{parsed.scheme}://{parsed.netloc}"
                            _cached_active_domain = active_domain
                            return active_domain
                except Exception:
                    continue

            # 2. Fallback: Parse landing page HTML at https://hdhub4u.bi/
            try:
                res = await session.get(LANDING_PAGE_URL, headers=headers, timeout=15)
                soup = BeautifulSoup(res.text, "html.parser")
                for a in soup.find_all("a"):
                    href = a.get("href", "")
                    if "hdhub4u" in href and href != LANDING_PAGE_URL:
                        parsed = urllib.parse.urlsplit(href)
                        active_domain = f"{parsed.scheme}://{parsed.netloc}"
                        _cached_active_domain = active_domain
                        return active_domain
            except Exception:
                pass

        _cached_active_domain = DEFAULT_BASE_DOMAIN
        return _cached_active_domain

    @classmethod
    def replace_domain(cls, url: str, base_domain: str) -> str:
        """
        Replaces outdated domain (e.g. new1.hdhub4u.af) with the active working domain.
        """
        if not url:
            return ""
        parsed_base = urllib.parse.urlsplit(base_domain)
        parsed_url = urllib.parse.urlsplit(url)
        path = parsed_url.path
        if not path.startswith("/"):
            path = "/" + path
        if parsed_url.query:
            path = f"{path}?{parsed_url.query}"
        return f"{parsed_base.scheme}://{parsed_base.netloc}{path}"

    @classmethod
    def extract_episode_number(cls, text: str) -> Optional[int]:
        """
        Extracts a clean episode number (1-300) from text while strictly excluding
        common video resolutions (480, 720, 1080, 2160) and resolutions followed by 'p'.
        """
        if not text:
            return None
        invalid_nums = {480, 720, 1080, 2160}
        
        # 1. Standard pattern: S01E02, S1.E2, S01 - E02
        m1 = re.search(r"\b[sS]\d{1,2}\s*[ ._-]?\s*[eE]([0-9]{1,3})\b", text)
        if m1:
            val = int(m1.group(1))
            if val not in invalid_nums and 0 < val <= 300:
                return val

        # 2. Standalone E01, E02, E1, E12 (e.g. "E01 - Drive", "Kota.Factory.E01")
        for m in re.finditer(r"\b[eE]([0-9]{1,3})\b", text):
            val = int(m.group(1))
            if val not in invalid_nums and 0 < val <= 300:
                return val

        # 3. Explicit episode notation: EP 01, Episode 1, Ep.02
        for m in re.finditer(r"\b(?:episode|ep)\s*[-._]?\s*([0-9]{1,3})\b", text, re.I):
            val = int(m.group(1))
            end_pos = m.end()
            if end_pos < len(text) and text[end_pos:end_pos+1].lower() == 'p':
                continue
            if val not in invalid_nums and 0 < val <= 300:
                return val

        return None

    @classmethod
    async def search_movies(
        cls, 
        query: str, 
        page: int = 1, 
        fetch_all: bool = True,
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> Dict[str, Any]:
        """
        Step 2: Searches for movies/shows using the automatically discovered active working domain.
        """
        active_domain = await cls.get_active_domain(impersonate=impersonate)
        target_search_url = f"{active_domain}/search.html?q={urllib.parse.quote(query)}&page={page}"

        api_headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": target_search_url,
            "Origin": active_domain,
            "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": '"Windows"',
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "cross-site",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        }

        items: List[Dict[str, Any]] = []
        total_found = 0
        total_pages = 1
        per_page = 15

        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            first_params = {
                "q": query,
                "query_by": "post_title,category,stars,director,imdb_id",
                "query_by_weights": "4,2,2,2,4",
                "sort_by": "sort_by_date:desc",
                "limit": per_page,
                "highlight_fields": "none",
                "use_cache": "true",
                "page": page if not fetch_all else 1,
            }

            try:
                api_res = await session.get(
                    SEARCH_BACKEND_URL, 
                    params=first_params, 
                    headers=api_headers, 
                    timeout=DEFAULT_TIMEOUT
                )
                if api_res.status_code == 200:
                    data = api_res.json()
                    total_found = data.get("found", 0)
                    total_pages = max(1, (total_found + per_page - 1) // per_page)
                    
                    for hit in data.get("hits", []):
                        doc = hit.get("document", {})
                        raw_permalink = doc.get("permalink", "")
                        updated_permalink = cls.replace_domain(raw_permalink, active_domain)
                        
                        items.append({
                            "id": doc.get("id"),
                            "title": doc.get("post_title"),
                            "permalink": updated_permalink,
                            "original_permalink": raw_permalink,
                            "thumbnail": doc.get("post_thumbnail") or "https://upload.wikimedia.org/wikipedia/commons/6/65/No-Image-Placeholder.svg",
                            "category": doc.get("category", []),
                            "director": doc.get("director", []),
                            "stars": doc.get("stars", []),
                            "imdb_id": doc.get("imdb_id"),
                            "post_date": doc.get("post_date"),
                        })

                    # Fetch remaining pages if multi-page requested
                    if fetch_all and total_pages > 1:
                        for p in range(2, min(total_pages + 1, 10)):
                            next_params = dict(first_params)
                            next_params["page"] = p
                            next_res = await session.get(
                                SEARCH_BACKEND_URL,
                                params=next_params,
                                headers=api_headers,
                                timeout=DEFAULT_TIMEOUT
                            )
                            if next_res.status_code == 200:
                                next_data = next_res.json()
                                for hit in next_data.get("hits", []):
                                    doc = hit.get("document", {})
                                    raw_permalink = doc.get("permalink", "")
                                    updated_permalink = cls.replace_domain(raw_permalink, active_domain)
                                    items.append({
                                        "id": doc.get("id"),
                                        "title": doc.get("post_title"),
                                        "permalink": updated_permalink,
                                        "original_permalink": raw_permalink,
                                        "thumbnail": doc.get("post_thumbnail") or "https://upload.wikimedia.org/wikipedia/commons/6/65/No-Image-Placeholder.svg",
                                        "category": doc.get("category", []),
                                        "director": doc.get("director", []),
                                        "stars": doc.get("stars", []),
                                        "imdb_id": doc.get("imdb_id"),
                                        "post_date": doc.get("post_date"),
                                    })
            except Exception:
                pass

        return {
            "query": query,
            "active_domain": active_domain,
            "page": page,
            "total_found": total_found,
            "total_pages": total_pages,
            "total_pages_fetched": total_pages if fetch_all else 1,
            "items": items,
        }

    search_hdhub4u = search_movies

    @classmethod
    async def bypass_intermediate_link(cls, url: str, impersonate: str = DEFAULT_IMPERSONATE) -> str:
        """
        Instantly decodes mediator / intermediate redirect pages (such as greenmountmotors.com)
        bypassing countdown timers and ads in 0 seconds.
        """
        if not ("greenmount" in url or "id=" in url or "mediator" in url):
            return url

        headers = cls._get_browser_headers()
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            try:
                res = await session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT)
                m = re.search(r"s\('o',\s*'([^']+)'", res.text)
                if m:
                    token_o = m.group(1)
                    step1 = base64.b64decode(token_o).decode("utf-8")
                    step2 = base64.b64decode(step1).decode("utf-8")
                    step3 = codecs.decode(step2, "rot_13")
                    step4 = base64.b64decode(step3).decode("utf-8")
                    parsed = json.loads(step4)
                    if "o" in parsed:
                        dest_url = base64.b64decode(parsed["o"]).decode("utf-8")
                        return dest_url
            except Exception:
                pass
        return url

    @classmethod
    async def get_movie_details(
        cls, 
        movie_url: str, 
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> Dict[str, Any]:
        """
        Step 3: Fetches movie detail page and extracts storyline, poster, screenshots,
        categories, batch full-season packs, and episode-wise download options.
        """
        active_domain = await cls.get_active_domain(impersonate=impersonate)
        target_url = cls.replace_domain(movie_url, active_domain)
        headers = cls._get_browser_headers(referer=active_domain)
        
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            response = await session.get(target_url, headers=headers, timeout=DEFAULT_TIMEOUT)
            soup = BeautifulSoup(response.text, "html.parser")
            
            title = ""
            if soup.find("h1", class_="entry-title"):
                title = soup.find("h1", class_="entry-title").get_text(strip=True)
            elif soup.title:
                title = soup.title.get_text(strip=True)
                
            entry = soup.find("div", class_="entry-content") or soup.find("article") or soup
            
            # Categories
            categories = []
            for meta in soup.find_all("meta", property=re.compile(r"article:(?:section|tag)", re.I)):
                c = meta.get("content", "").strip()
                c_clean = re.sub(r"[^\w\s-]", "", c).strip()
                if c_clean and c_clean not in categories:
                    categories.append(c_clean)
            if not categories:
                for cat_a in soup.find_all("a", rel="category tag"):
                    c_text = cat_a.get_text(strip=True)
                    c_clean = re.sub(r"[^\w\s-]", "", c_text).strip()
                    if c_clean and c_clean not in categories:
                        categories.append(c_clean)
            if not categories:
                for p in entry.find_all(["p", "span", "div"]):
                    pt = p.get_text(" ", strip=True)
                    if "genre" in pt.lower() or "category" in pt.lower():
                        parts = re.split(r"[:,|/]", pt)
                        if len(parts) > 1:
                            for c in parts[1:]:
                                cln = re.sub(r"[^\w\s-]", "", c).strip()
                                if cln and len(cln) < 25 and cln not in categories:
                                    categories.append(cln)
                        break


            # Is TV Series Check
            is_tv_series = bool(re.search(r"season|series|episode|ep-\d+|all episodes|tv-shows|web-series", f"{title} {' '.join(categories)}", re.I))

            # Synopsis / Storyline
            synopsis = ""
            for tag in entry.find_all(["p", "span", "div"]):
                t = tag.get_text(strip=True)
                if any(k in t.lower() for k in ["storyline", "synopsis", "about:", "plot:"]) and len(t) < 50:
                    nxt = tag.find_next_sibling("p") or tag.find_next("p")
                    if nxt:
                        synopsis = nxt.get_text(strip=True)
                        break
                        
            # Poster
            poster = ""
            og_img = soup.find("meta", property="og:image")
            if og_img and og_img.get("content") and "logo" not in og_img.get("content").lower():
                poster = og_img.get("content").strip()

            if not poster or "logo" in poster.lower():
                for img in entry.find_all("img"):
                    src = img.get("src") or img.get("data-src") or ""
                    if not src:
                        continue
                    src_lower = src.lower()
                    if "logo" in src_lower or "banner" in src_lower or "icon" in src_lower:
                        continue
                    if any(k in src_lower for k in ["imdb", "tmdb", "poster", "imagebam", "postimg", "catimages"]):
                        poster = src
                        break

            if poster and poster.startswith("/"):
                poster = f"{active_domain}{poster}"

                
            # Screenshots
            screenshots = []
            for img in entry.find_all("img"):
                src = img.get("src") or img.get("data-src") or ""
                if src and src != poster:
                    if any(k in src.lower() for k in ["imdb", "tmdb", "extraimage", "imgextra", "imagebam", "postimg", "catimages"]):
                        if "logo" not in src.lower() and "banner" not in src.lower():
                            screenshots.append(src)
                            
            # Download options extraction with DOM context tracking
            download_options: List[Dict[str, Any]] = []
            blacklist_keywords = [
                "snvhost.com", "hdhub4u.download", "hdhub4u.tv", "disclaimer", 
                "join-our-group", "request-a-movie", "how-to-download", 
                "telegram", "whatsapp", "4khdhub.one", "catimages.co",
                "imagebam.com", "postimg.cc", "imdb.com", "tmdb.org", "extraimage",
                "imgextra", "instagram.com", "facebook.com", "twitter.com",
                "youtube.com", "youtu.be", "tinyurl.com"
            ]

            valid_download_hints = [
                "hubcloud", "hubdrive", "hblinks", "greenmount", "gamerxyt",
                "drive.", "/drive/", "download", "archives", "id=", "dl.",
                "pixeldrain", "r2.dev", "workers.dev"
            ]

            current_heading = ""
            current_episode = ""

            for elem in entry.descendants:
                if elem.name in ["h1", "h2", "h3", "h4", "h5", "h6"]:
                    h_text = elem.get_text(" ", strip=True)
                    if any(k in h_text.lower() for k in ["episode", "ep", "bonus", "zip", "pack", "batch", "season", "download links"]):
                        current_heading = h_text
                        ep_val = cls.extract_episode_number(h_text)
                        if ep_val is not None:
                            current_episode = f"EPISODE {ep_val:02d}"
                        else:
                            current_episode = ""

                elif elem.name == "a":
                    a = elem
                    href = a.get("href", "")
                    text = a.get_text(" ", strip=True)
                    classes = " ".join(a.get("class", []))
                    
                    if not href or href.startswith("#"):
                        continue

                    href_lower = href.lower()
                    if any(k in href_lower for k in blacklist_keywords) or any(k in text.lower() for k in ["how to download", "join our group", "disclaimer", "request", "telegram", "whatsapp"]):
                        continue
                    
                    if not any(k in href_lower for k in valid_download_hints):
                        continue

                    parsed_href = urllib.parse.urlsplit(href)
                    if ("hdhub4u" in parsed_href.netloc or not parsed_href.netloc) and not any(k in href for k in ["download", "drive", "archives", "id="]):
                        continue

                    parent = a.find_parent(["p", "div", "h3", "h4", "li", "span", "tr"])
                    parent_text = parent.get_text(" ", strip=True) if parent else ""

                    # Category / Noise filter: ignore anchors that are just genre/category tags
                    text_clean = text.strip().lower()
                    genre_words = {"comedy", "drama", "action", "romance", "thriller", "horror", "sci-fi", "bollywood", "hollywood", "web-series", "hindi", "english", "300mb movies", "hd movies"}
                    if (text_clean in genre_words or text_clean in [c.lower() for c in categories]) and not any(k in href_lower for k in ["hubcloud", "hubdrive", "pixeldrain"]):
                        if not any(k in parent_text.lower() for k in ["mb", "gb", "pack", "episode", "ep", "e0", "e1", "720p", "1080p", "480p", "4k", "drive", "instant", "download"]):
                            continue

                    # Contextual label construction
                    label = text
                    if not label or label.lower() in ["drive", "instant", "watch", "download", "watch online", "link", "click here", "direct", "stream", "hubcloud", "gdrive"]:
                        context_parts = []
                        if current_episode and current_episode.lower() not in parent_text.lower():
                            context_parts.append(current_episode)
                        if parent_text and len(parent_text) < 80:
                            context_parts.append(parent_text)
                        elif text:
                            context_parts.append(text)
                        label = " - ".join(context_parts) if context_parts else (text or "Download Link")

                    # Check quality
                    quality = "Direct Download"
                    combined_info = f"{label} {parent_text} {current_heading}".lower()
                    if "4k" in combined_info or "2160p" in combined_info:
                        quality = "4K / 2160p"
                    elif "1080p" in combined_info:
                        quality = "1080p"
                    elif "720p" in combined_info:
                        quality = "720p"
                    elif "480p" in combined_info:
                        quality = "480p"

                    size_match = re.search(r"\[([0-9.]+\s*(?:MB|GB|mb|gb))\]", f"{label} {parent_text}")
                    size = size_match.group(1) if size_match else ""

                    # Determine Batch Pack vs Episode
                    is_batch = False
                    category_type = "movie"
                    if is_tv_series:
                        ep_val = cls.extract_episode_number(f"{label} {parent_text} {current_episode}")
                        if any(k in combined_info for k in ["bonus"]):
                            category_type = "bonus_episode"
                        elif any(k in combined_info for k in ["pack", "zip", "all episode", "season pack", "full series", "complete season"]):
                            is_batch = True
                            category_type = "batch_pack"
                        elif ep_val is not None:
                            category_type = "episode"
                        elif size or quality in ["480p", "720p", "1080p", "4K / 2160p"]:
                            # Top level resolution links in series without episode numbers are full season batch packs!
                            is_batch = True
                            category_type = "batch_pack"

                    is_hubcloud = "hubcloud." in href and "drive" in href
                    is_hblinks = "hblinks." in href
                    is_intermediate = "greenmount" in href or "id=" in href

                    download_options.append({
                        "label": label,
                        "quality": quality,
                        "size": size,
                        "link_url": href,
                        "type": "Stream" if "watch online" in text.lower() else ("Batch Pack" if is_batch else ("Episode" if category_type == "episode" else "Download")),
                        "is_batch": is_batch,
                        "category_type": category_type,
                        "is_hubcloud": is_hubcloud,
                        "is_hblinks": is_hblinks,
                        "is_intermediate": is_intermediate,
                    })

            # Filter out duplicate URLs and generic site links
            seen_urls = set()
            unique_options = []
            for opt in download_options:
                u = opt["link_url"]
                if u not in seen_urls and opt["label"].lower() not in ["hdhub4u", "hdhub4u.tv", "hdhub4u.download"]:
                    seen_urls.add(u)
                    unique_options.append(opt)

            return {
                "page_url": target_url,
                "active_domain": active_domain,
                "title": title,
                "poster": poster,
                "synopsis": synopsis,
                "category": categories,
                "is_tv_series": is_tv_series,
                "screenshots": screenshots[:8],
                "download_options": unique_options,
                "download_links": unique_options,
                "total_options": len(unique_options),
            }

    scrape_movie_page = get_movie_details

    @classmethod
    def normalize_direct_url(cls, url: str) -> str:
        if not url:
            return ""
        # Convert pixeldrain /u/ID to /api/file/ID
        m = re.search(r"pixeldrain\.(?:dev|com)/u/([a-zA-Z0-9_-]+)", url, re.I)
        if m:
            return f"https://pixeldrain.com/api/file/{m.group(1)}"
        return url

    @classmethod
    async def resolve_pixel_or_gpdl(cls, url: str, referer: Optional[str], session: AsyncSession) -> Optional[str]:
        headers = cls._get_browser_headers(referer=referer or "https://gamerxyt.com/")
        try:
            res = await session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT)
            # 1. Check if redirect target URL has link=
            parsed = urllib.parse.urlsplit(res.url)
            qs = urllib.parse.parse_qs(parsed.query)
            if "link" in qs:
                raw_link = qs["link"][0]
                if raw_link.startswith("http"):
                    return raw_link
            
            # 2. Check HTML for downloadBtn or link parameter
            soup = BeautifulSoup(res.text, "html.parser")
            btn = soup.find("a", id="downloadBtn")
            if btn and btn.get("href") and btn.get("href").startswith("http"):
                return btn.get("href")
                
            orig_qs = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            if "link" in orig_qs and orig_qs["link"][0].startswith("http"):
                return orig_qs["link"][0]
                
            m_reurl = re.search(r'reurl\s*=\s*["\']([^"\']+)["\']', res.text)
            if m_reurl and "link=" in m_reurl.group(1):
                p_re = urllib.parse.urlsplit(m_reurl.group(1))
                qs_re = urllib.parse.parse_qs(p_re.query)
                if "link" in qs_re:
                    return qs_re["link"][0]
        except Exception:
            pass
        return None

    @classmethod
    async def resolve_hubcdn_file(cls, url: str, referer: Optional[str], session: AsyncSession) -> Optional[str]:
        headers = cls._get_browser_headers(referer=referer or "https://hblinks.co/")
        try:
            res = await session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT)
            if "File is Deleted or UnAvailable" in res.text or "Something went wrong" in res.text:
                return None

            m = re.search(r'reurl\s*=\s*["\']([^"\']+)["\']', res.text)
            if not m:
                m = re.search(r'https?://(?:www\.)?inventoryidea\.com/\?r=([a-zA-Z0-9+/=]+)', res.text)
                target = m.group(0) if m else None
            else:
                target = m.group(1)

            dl_page_url = None
            if target:
                parsed = urllib.parse.urlsplit(target)
                qs = urllib.parse.parse_qs(parsed.query)
                if "r" in qs:
                    decoded = base64.b64decode(qs["r"][0]).decode("utf-8", errors="ignore")
                    dl_page_url = decoded
            
            if not dl_page_url and "/dl/?link=" in res.text:
                m_dl = re.search(r'https?://[^\s"\']+/dl/\?link=[^\s"\']+', res.text)
                if m_dl:
                    dl_page_url = m_dl.group(0)

            if dl_page_url:
                res_dl = await session.get(dl_page_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                soup_dl = BeautifulSoup(res_dl.text, "html.parser")
                for a in soup_dl.find_all("a"):
                    h = a.get("href", "")
                    if any(x in h for x in ["r2.dev", "cloudflarestorage", "googleapis.com", "workers.dev"]) or "download" in a.get_text(strip=True).lower():
                        if h.startswith("http"):
                            return h
        except Exception:
            pass
        return None

    @classmethod
    async def resolve_to_direct_link(cls, url: str, referer: Optional[str], session: AsyncSession) -> Optional[str]:
        if not url or not url.startswith("http"):
            return None

        url = cls.normalize_direct_url(url)
        url_lower = url.lower()

        # Filter out non-download blacklisted URLs
        if any(b in url_lower for b in ["catimages", "imagebam", "postimg", "imdb.com", "tmdb.org", "snvhost", "telegram", "t.me"]):
            return None

        # Pixel / GPDL Hubcloud intermediate
        if ("pixel.hubcloud." in url_lower or "gpdl.hubcloud." in url_lower) and "?id=" in url_lower:
            resolved = await cls.resolve_pixel_or_gpdl(url, referer=referer, session=session)
            if resolved:
                return cls.normalize_direct_url(resolved)
            return None

        # HubCDN file intermediate
        if "hubcdn." in url_lower and "/file/" in url_lower:
            resolved = await cls.resolve_hubcdn_file(url, referer=referer, session=session)
            if resolved:
                return cls.normalize_direct_url(resolved)
            return None

        # Greenmount / mediator redirect
        if "greenmount" in url_lower or "mediator" in url_lower:
            bypassed = await cls.bypass_intermediate_link(url)
            if bypassed and bypassed != url:
                return await cls.resolve_to_direct_link(bypassed, referer=referer, session=session)

        # Already direct CDN / storage links
        if any(k in url_lower for k in ["r2.cloudflarestorage.com", "pub-", "r2.dev", "workers.dev", "video-downloads.googleusercontent.com", "/api/file/"]):
            return url

        if any(url_lower.endswith(ext) or f"{ext}?" in url_lower for ext in [".mkv", ".mp4", ".zip", ".rar", ".avi", ".tar"]):
            return url

        if "storage.googleapis.com" in url_lower:
            return url

        return url

    @classmethod
    async def extract_final_download_links(cls, link_url: str, impersonate: str = DEFAULT_IMPERSONATE) -> Dict[str, Any]:
        """
        Step 4: Resolves any HubCloud, HBLinks, or intermediate URL to the FINAL DIRECT DOWNLOADING URLs (10Gbps, CDN .mkv/.zip file).
        """
        headers = cls._get_browser_headers()

        # Check if URL is an intermediate redirect (e.g. greenmountmotors)
        if "greenmount" in link_url or "id=" in link_url or "mediator" in link_url:
            target_url = await cls.bypass_intermediate_link(link_url, impersonate=impersonate)
        else:
            target_url = link_url

        url_lower = target_url.lower()

        # Case A: HubDrive file URL (e.g. hubdrive.tips/file/2230208894)
        if "hubdrive." in url_lower and "/file/" in url_lower:
            async with AsyncSession(impersonate=impersonate, verify=False) as session:
                res = await session.get(target_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                soup = BeautifulSoup(res.text, "html.parser")
                
                filename = soup.title.string.replace("HubDrive | ", "").strip() if soup.title else ""
                file_size = ""
                for td in soup.find_all(["td", "div", "span"]):
                    t = td.get_text(strip=True)
                    m_sz = re.search(r"([0-9.]+\s*(?:MB|GB|mb|gb))", t)
                    if m_sz and len(t) < 40:
                        file_size = m_sz.group(1).strip()
                        break
                    elif m_sz and not file_size:
                        file_size = m_sz.group(1).strip()

                hubcloud_url = None
                for a in soup.find_all("a"):
                    href = a.get("href", "")
                    if "hubcloud" in href and "drive" in href:
                        hubcloud_url = href
                        break

                if hubcloud_url:
                    resolved = await cls.extract_final_download_links(hubcloud_url, impersonate=impersonate)
                    if filename and not resolved.get("filename"):
                        resolved["filename"] = filename
                    if file_size and not resolved.get("file_size"):
                        resolved["file_size"] = file_size
                    return resolved

                # Direct links on HubDrive page
                raw_links = []
                for a in soup.find_all("a"):
                    h = a.get("href", "")
                    if not h or any(k in h.lower() for k in ["telegram", "t.me", "tg/go", "privacy", "terms", "copyright", "sign"]):
                        continue
                    if any(x in h for x in ["r2.cloudflarestorage.com", "storage.googleapis.com", "pixeldrain", "gpdl.", "workers.dev", "hubcdn."]):
                        stype = "💾 Direct Download File (Fast CDN)"
                        if "pixeldrain" in h:
                            stype = "📦 Pixeldrain Fast Download"
                        elif "10gbps" in h:
                            stype = "⚡ Server : 10Gbps High Speed"
                        raw_links.append({
                            "server_name": a.get_text(strip=True) or stype,
                            "server_type": stype,
                            "download_url": h,
                            "is_direct": True
                        })
                
                resolved_final = []
                seen_urls = set()
                for srv in raw_links:
                    d_url = await cls.resolve_to_direct_link(srv["download_url"], referer=target_url, session=session)
                    if d_url and d_url not in seen_urls:
                        seen_urls.add(d_url)
                        resolved_final.append({**srv, "download_url": d_url})

                return {
                    "source_url": target_url,
                    "filename": filename,
                    "file_size": file_size,
                    "final_downloads": resolved_final,
                    "total_servers": len(resolved_final)
                }

        # Case B: HBLinks archive URL (contains multiple qualities & direct servers)
        if "hblinks." in url_lower:
            async with AsyncSession(impersonate=impersonate, verify=False) as session:
                res = await session.get(target_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                soup = BeautifulSoup(res.text, "html.parser")
                entry = soup.find("div", class_="entry-content") or soup.find("article") or soup
                
                raw_results = []
                current_heading = ""

                for el in entry.find_all(["h1", "h2", "h3", "h4", "h5", "h6", "p", "div"]):
                    text = el.get_text(" ", strip=True)
                    if el.name in ["h1", "h2", "h3", "h4", "h5", "h6"] or any(k in text.lower() for k in ["480p", "720p", "1080p", "4k", "2160p", "hevc", "pack"]):
                        if any(k in text.lower() for k in ["480p", "720p", "1080p", "4k", "2160p", "hevc", "web-dl"]):
                            current_heading = text

                    for a in el.find_all("a"):
                        href = a.get("href", "")
                        if not href or any(k in href.lower() for k in ["telegram", "t.me", "tg/go", "how-to-download"]):
                            continue

                        a_text = a.get_text(strip=True)
                        if "hubcloud" in href and "drive" in href:
                            resolved = await cls.extract_final_download_links(href, impersonate=impersonate)
                            for srv in resolved.get("final_downloads", []):
                                if current_heading and not srv.get("section_label"):
                                    srv["section_label"] = current_heading
                                raw_results.append(srv)
                        elif "hubdrive." in href and "/file/" in href:
                            resolved = await cls.extract_final_download_links(href, impersonate=impersonate)
                            for srv in resolved.get("final_downloads", []):
                                if current_heading and not srv.get("section_label"):
                                    srv["section_label"] = current_heading
                                raw_results.append(srv)
                        elif any(k in href for k in ["hubdrive", "gdrive", "drive", "hubcdn", "instant", "workers.dev"]):
                            item_name = a_text if a_text not in ["Drive", "Instant", "Direct", "Download"] else current_heading
                            stype = "☁️ Google Drive / HubDrive" if "hubdrive" in href or "gdrive" in href else "💾 Direct Fast CDN"
                            raw_results.append({
                                "server_name": item_name or "Direct Server",
                                "server_type": stype,
                                "download_url": href,
                                "section_label": current_heading,
                                "is_direct": True
                            })

                resolved_final = []
                seen_urls = set()
                for srv in raw_results:
                    d_url = await cls.resolve_to_direct_link(srv["download_url"], referer=target_url, session=session)
                    if d_url and d_url not in seen_urls:
                        # Avoid returning intermediate pages
                        if any(k in d_url.lower() for k in ["hubcdn.sbs/file/", "pixel.hubcloud.cx/?id=", "gpdl.hubcloud.cx/?id=", "inventoryidea.com"]):
                            continue
                        seen_urls.add(d_url)
                        resolved_final.append({**srv, "download_url": d_url})

                return {
                    "source_url": target_url,
                    "final_downloads": resolved_final,
                    "total_servers": len(resolved_final)
                }

        # Case C: HubCloud Drive URL (e.g. hubcloud.cx/drive/...)
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            res1 = await session.get(target_url, headers=headers, timeout=DEFAULT_TIMEOUT)
            soup1 = BeautifulSoup(res1.text, "html.parser")
            
            filename = soup1.title.string.strip() if soup1.title else "Movie Download File"
            file_size = ""
            for td in soup1.find_all(["td", "p", "div", "span"]):
                t = td.get_text(strip=True)
                m_sz = re.search(r"([0-9.]+\s*(?:MB|GB|mb|gb))", t)
                if m_sz and len(t) < 40:
                    file_size = m_sz.group(1).strip()
                    break
                elif m_sz and not file_size:
                    file_size = m_sz.group(1).strip()

            # Find generator link (e.g. gamerxyt.com/hubcloud.php?...)
            gen_link = None
            for a in soup1.find_all("a"):
                href = a.get("href", "")
                if "hubcloud.php" in href or "token=" in href:
                    gen_link = href
                    break

            raw_downloads = []

            if not gen_link:
                # Direct links on page
                for a in soup1.find_all("a"):
                    h = a.get("href", "")
                    if not h or "telegram" in h.lower() or "t.me" in h.lower() or "tg/go" in h:
                        continue
                    if any(x in h for x in ["r2.cloudflarestorage.com", "storage.googleapis.com", "pixeldrain", "gpdl.", "workers.dev", "pixel."]):
                        server_type = "⚡ High-Speed Direct Server"
                        if "workers.dev" in h or "r2." in h:
                            server_type = "💾 Direct Download File (Fast CDN)"
                        elif "pixeldrain" in h:
                            server_type = "📦 Pixeldrain Fast Download"
                        raw_downloads.append({
                            "server_name": a.get_text(strip=True) or server_type,
                            "server_type": server_type,
                            "download_url": h,
                            "is_direct": True
                        })
            else:
                # 2. Fetch generator page (gamerxyt)
                gen_headers = dict(headers)
                gen_headers["Referer"] = target_url
                res2 = await session.get(gen_link, headers=gen_headers, timeout=DEFAULT_TIMEOUT)
                soup2 = BeautifulSoup(res2.text, "html.parser")

                for a in soup2.find_all("a"):
                    href = a.get("href", "")
                    text = a.get_text(" ", strip=True)

                    if (
                        not href 
                        or href.startswith("#") 
                        or "admin" in href.lower() 
                        or "telegram" in href.lower() 
                        or "t.me" in href.lower() 
                        or "tg/go" in href.lower() 
                        or "tinyurl" in href.lower()
                        or "telegram" in text.lower()
                        or "how ? click here" in text.lower()
                        or "snvhost" in href.lower()
                    ):
                        continue

                    if any(k in href for k in ["gpdl.", "workers.dev", "r2.cloudflarestorage", "googleapis.com", "pixeldrain", "hubcloud", "drive", "download", "dl."]) or "download" in text.lower():
                        server_type = "Direct Server"
                        if "10gbps" in text.lower() or "gpdl" in href or "pixel" in href:
                            server_type = "⚡ Server : 10Gbps High Speed"
                        elif "download file" in text.lower() or "workers.dev" in href or "r2." in href:
                            server_type = "💾 Direct Download File (Fast CDN)"
                        elif "pixeldrain" in href:
                            server_type = "📦 Pixeldrain Fast Download"
                        elif "googleapis" in href:
                            server_type = "☁️ Google Cloud Storage"
                        elif "hubdrive" in href or "gdrive" in href:
                            server_type = "☁️ Google Drive / HubDrive"

                        raw_downloads.append({
                            "server_name": text or server_type,
                            "server_type": server_type,
                            "download_url": href,
                            "is_direct": True
                        })

            resolved_final = []
            seen_urls = set()
            for srv in raw_downloads:
                d_url = await cls.resolve_to_direct_link(srv["download_url"], referer=gen_link or target_url, session=session)
                if not d_url or d_url in seen_urls:
                    continue
                # Avoid returning intermediate pages
                if any(k in d_url.lower() for k in ["hubcdn.sbs/file/", "pixel.hubcloud.cx/?id=", "gpdl.hubcloud.cx/?id=", "inventoryidea.com"]):
                    continue

                seen_urls.add(d_url)
                stype = srv["server_type"]
                if "video-downloads.googleusercontent.com" in d_url:
                    stype = "⚡ Server : 10Gbps High Speed (Google CDN)"
                elif "r2.dev" in d_url or "r2.cloudflarestorage" in d_url:
                    stype = "💾 Cloudflare R2 Direct CDN"
                elif "pixeldrain" in d_url:
                    stype = "📦 Pixeldrain Fast Download"
                elif "workers.dev" in d_url:
                    stype = "⚡ Fast Workers CDN"

                resolved_final.append({
                    "server_name": srv["server_name"],
                    "server_type": stype,
                    "download_url": d_url,
                    "file_size": srv.get("file_size") or file_size,
                    "is_direct": True
                })

            return {
                "source_url": target_url,
                "filename": filename,
                "file_size": file_size,
                "final_downloads": resolved_final,
                "total_servers": len(resolved_final)
            }

    resolve_any_link = extract_final_download_links

    @classmethod
    def _parse_link_metadata(
        cls, 
        opt: Dict[str, Any], 
        dl: Dict[str, Any], 
        res_filename: str = "", 
        is_tv_series: bool = False
    ) -> Tuple[str, str, str, bool]:
        """
        Parses episode tag, resolution, codec, and is_batch status from link metadata.
        """
        opt_label = (opt.get("label") or "").strip()
        opt_quality = (opt.get("quality") or "").strip()
        opt_type = opt.get("category_type") or ""
        opt_is_batch = bool(opt.get("is_batch"))
        
        srv_name = (dl.get("server_name") or "").strip()
        srv_type = (dl.get("server_type") or "").strip()
        section_label = (dl.get("section_label") or "").strip()
        dl_url = dl.get("download_url") or ""
        
        full_url_decoded = urllib.parse.unquote(dl_url)
        
        opt_lower = opt_label.lower()
        url_lower = full_url_decoded.lower()
        srv_lower = srv_name.lower()
        section_lower = section_label.lower()
        combined = f"{opt_label} {opt_quality} {section_label} {srv_name} {srv_type} {res_filename} {full_url_decoded}".lower()

        # 1. Detect Episode Number
        ep_search_text = f"{opt_label} {section_label} {srv_name} {res_filename} {full_url_decoded}"
        ep_num = cls.extract_episode_number(ep_search_text)

        # 2. Detect Batch / Season Pack
        is_batch = False
        if "bonus" in combined:
            is_batch = False
        elif ep_num is not None:
            is_batch = False
        elif opt_is_batch or (opt_type == "batch_pack"):
            is_batch = True
        elif any(k in opt_lower for k in ["pack", "all episode", "season pack", "full series", "complete season", "zip [all"]):
            is_batch = True
        elif any(k in url_lower or k in srv_lower for k in ["season.pack", "complete.season", "all.episodes", "complete.s0"]):
            is_batch = True
        elif is_tv_series:
            if re.search(r"\[[0-9.]+\s*(?:mb|gb)\]", opt_lower) or any(k in opt_lower for k in ["480p", "720p", "1080p", "2160p", "4k"]):
                is_batch = True

        # 3. Detect Episode (Episode 1, Ep 02, Bonus Ep 1, Bonus Clip of Ep 04, etc.)
        episode_tag = ""
        if "bonus" in combined:
            b_num_match = re.search(r"bonus.*?(?:ep|episode|e)?\s*([0-9]{1,3})", combined)
            num = f"{int(b_num_match.group(1)):02d}" if b_num_match else ""
            episode_tag = f"bonus_ep_{num}" if num else "bonus_episode"
        elif not is_batch and ep_num is not None:
            episode_tag = f"episode_{ep_num:02d}"

        # 3. Detect Resolution
        resolution = "direct"
        # Check server name, section label, and filename first, then opt label
        if any(k in section_lower or k in srv_lower or k in url_lower for k in ["2160p", "4k", "ds4k", "uhd"]):
            resolution = "4k"
        elif any(k in section_lower or k in srv_lower or k in url_lower for k in ["1080p", "1080"]):
            resolution = "1080p"
        elif any(k in section_lower or k in srv_lower or k in url_lower for k in ["720p", "720"]):
            resolution = "720p"
        elif any(k in section_lower or k in srv_lower or k in url_lower for k in ["480p", "480"]):
            resolution = "480p"
        else:
            if any(k in opt_lower or k in opt_quality.lower() for k in ["2160p", "4k", "ds4k", "uhd"]):
                resolution = "4k"
            elif "1080p" in opt_lower or "1080p" in opt_quality.lower():
                resolution = "1080p"
            elif "720p" in opt_lower or "720p" in opt_quality.lower():
                resolution = "720p"
            elif "480p" in opt_lower or "480p" in opt_quality.lower():
                resolution = "480p"

        # 4. Detect Codec
        codec = ""
        if any(k in section_lower or k in srv_lower or k in url_lower for k in ["hevc", "x265", "10bit"]):
            codec = "hevc"
        elif any(k in section_lower or k in srv_lower or k in url_lower for k in ["x264", "h264", "avc"]):
            codec = "x264"
        elif any(k in opt_lower for k in ["hevc", "x265", "10bit"]):
            codec = "hevc"
        elif any(k in opt_lower for k in ["x264", "h264", "avc"]):
            codec = "x264"

        return episode_tag, resolution, codec, is_batch

    @classmethod
    def _generate_format_key(cls, episode_tag: str, resolution: str, codec: str, is_batch: bool) -> str:
        """
        Constructs standardized, descriptive format keys.
        """
        if is_batch:
            parts = ["batch_season_pack"]
            if resolution != "direct":
                parts.append(resolution)
            if codec == "hevc":
                parts.append(codec)
            return "_".join(parts)

        if episode_tag:
            parts = [episode_tag]
            if resolution != "direct":
                parts.append(resolution)
            if codec == "hevc":
                parts.append(codec)
            return "_".join(parts)

        # Standard movie format key
        parts = ["format"]
        if resolution == "4k":
            parts.append("4k_2160p")
        elif resolution != "direct":
            parts.append(resolution)
        if codec == "hevc":
            parts.append(codec)
        elif codec == "x264":
            parts.append("h264")
        if len(parts) == 1:
            parts.append("direct")
        return "_".join(parts)

    @classmethod
    def _sort_download_keys(cls, key: str) -> Tuple[int, int, int, str]:
        """
        Sorting comparator:
        Priority 1: Batch Season Packs (4K -> 1080p -> 720p HEVC -> 720p -> 480p)
        Priority 2: Episode-wise links (Ep 01 -> Ep 02 -> ..., with qualities 4K -> 1080p -> 720p -> 480p)
        Priority 3: Bonus Episodes (Bonus 01 -> Bonus 02...)
        Priority 4: Movies (4K -> 1080p -> 720p -> 480p)
        """
        cat_rank = 4
        ep_num = 0
        res_rank = 10
        
        if key.startswith("batch_season_pack"):
            cat_rank = 0
        elif key.startswith("episode_"):
            cat_rank = 1
            m = re.search(r"episode_(\d+)", key)
            if m:
                ep_num = int(m.group(1))
        elif key.startswith("bonus_ep"):
            cat_rank = 2
            m = re.search(r"bonus_ep_?(\d+)?", key)
            if m and m.group(1):
                ep_num = int(m.group(1))
        elif key.startswith("format_"):
            cat_rank = 3

        if "4k" in key or "2160" in key:
            res_rank = 0
        elif "1080" in key:
            res_rank = 1
        elif "720" in key and "hevc" in key:
            res_rank = 2
        elif "720" in key:
            res_rank = 3
        elif "480" in key:
            res_rank = 4

        return (cat_rank, ep_num, res_rank, key)

    @classmethod
    async def fetch_url(
        cls,
        url: str,
        impersonate: str = DEFAULT_IMPERSONATE,
        fetch_all_pages: bool = True,
        target_domain: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Generic fetcher and search router for direct URL queries.
        """
        active_domain = target_domain or (await cls.get_active_domain(impersonate=impersonate))
        parsed = urllib.parse.urlsplit(url)
        params = urllib.parse.parse_qs(parsed.query)

        if "search" in parsed.path or "q" in params:
            query = params.get("q", [""])[0]
            page = int(params.get("page", ["1"])[0])
            search_res = await cls.search_movies(
                query=query, 
                page=page, 
                fetch_all=fetch_all_pages, 
                impersonate=impersonate
            )
            return {
                "url": url,
                "status_code": 200,
                "content_type": "application/json",
                "title": f"Search Results for: {query}",
                "total_found": search_res.get("total_found", 0),
                "total_pages": search_res.get("total_pages", 1),
                "total_pages_fetched": search_res.get("total_pages_fetched", 1),
                "items": search_res.get("items", []),
                "active_domain": active_domain,
            }

        headers = cls._get_browser_headers()
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            res = await session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT)
            soup = BeautifulSoup(res.text, "html.parser")
            return {
                "url": url,
                "status_code": res.status_code,
                "content_type": res.headers.get("content-type", "text/html"),
                "title": soup.title.string if soup.title else "",
                "html": res.text,
            }

    @classmethod
    async def search_and_resolve_downloads(
        cls,
        query: str,
        limit: Optional[int] = None,
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> List[Dict[str, Any]]:
        """
        Special Automated Endpoint Method:
        Executes search, scrapes details for all matching movies/shows, and resolves all download
        options into direct download links formatted with episode & batch pack priorities.
        """
        search_res = await cls.search_movies(query=query, page=1, fetch_all=True, impersonate=impersonate)
        items = search_res.get("items", [])
        if limit is not None:
            items = items[:limit]

        sem = asyncio.Semaphore(10)

        async def process_single_movie(item: Dict[str, Any]) -> Dict[str, Any]:
            permalink = item.get("permalink", "")
            if not permalink:
                return {}

            details = await cls.get_movie_details(movie_url=permalink, impersonate=impersonate)
            options = details.get("download_options", [])
            is_tv = details.get("is_tv_series", False)

            async def resolve_opt(opt: Dict[str, Any]):
                async with sem:
                    try:
                        resolved = await cls.extract_final_download_links(opt["link_url"], impersonate=impersonate)
                        return opt, resolved
                    except Exception:
                        return opt, None

            resolved_tuples = await asyncio.gather(*(resolve_opt(opt) for opt in options))

            raw_downloads_map: Dict[str, List[Dict[str, Any]]] = {}
            for opt, res in resolved_tuples:
                if not res:
                    continue
                final_downloads = res.get("final_downloads", [])
                for dl in final_downloads:
                    ep_tag, res_label, codec, is_batch = cls._parse_link_metadata(
                        opt=opt, 
                        dl=dl, 
                        res_filename=res.get("filename", ""), 
                        is_tv_series=is_tv
                    )
                    format_key = cls._generate_format_key(ep_tag, res_label, codec, is_batch)
                    
                    if format_key not in raw_downloads_map:
                        raw_downloads_map[format_key] = []

                    dl_url = dl.get("download_url")
                    if dl_url and not any(existing.get("download_url") == dl_url for existing in raw_downloads_map[format_key]):
                        raw_downloads_map[format_key].append({
                            "server_name": dl.get("server_name"),
                            "server_type": dl.get("server_type"),
                            "download_url": dl_url,
                            "file_size": res.get("file_size") or opt.get("size") or "",
                        })

            # Sort keys by batch pack priority -> Episode order -> Movie quality
            sorted_downloads_map = {
                k: raw_downloads_map[k] for k in sorted(raw_downloads_map.keys(), key=cls._sort_download_keys)
            }

            return {
                "name": details.get("title") or item.get("title"),
                "url": permalink,
                "thumbnail": details.get("poster") or item.get("thumbnail"),
                "synopsis": details.get("synopsis", ""),
                "category": details.get("category") or item.get("category", []),
                "downloads": sorted_downloads_map,
            }

        tasks = [process_single_movie(it) for it in items]
        movie_results = await asyncio.gather(*tasks)
        return [m for m in movie_results if m and m.get("name")]

    @classmethod
    async def resolve_movie_direct_downloads(
        cls,
        movie_url: str,
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> Dict[str, Any]:
        """
        Takes a specific movie / series page URL, scrapes its details,
        and resolves all qualities / episodes / batch packs to final direct download links.
        """
        active_domain = await cls.get_active_domain(impersonate=impersonate)
        target_url = cls.replace_domain(movie_url, active_domain)

        details = await cls.get_movie_details(movie_url=target_url, impersonate=impersonate)
        options = details.get("download_options", [])
        is_tv = details.get("is_tv_series", False)

        sem = asyncio.Semaphore(10)

        async def resolve_opt(opt: Dict[str, Any]):
            async with sem:
                try:
                    resolved = await cls.extract_final_download_links(opt["link_url"], impersonate=impersonate)
                    return opt, resolved
                except Exception:
                    return opt, None

        resolved_tuples = await asyncio.gather(*(resolve_opt(opt) for opt in options))

        raw_downloads_map: Dict[str, List[Dict[str, Any]]] = {}
        for opt, res in resolved_tuples:
            if not res:
                continue
            final_downloads = res.get("final_downloads", [])
            for dl in final_downloads:
                ep_tag, res_label, codec, is_batch = cls._parse_link_metadata(
                    opt=opt, 
                    dl=dl, 
                    res_filename=res.get("filename", ""), 
                    is_tv_series=is_tv
                )
                format_key = cls._generate_format_key(ep_tag, res_label, codec, is_batch)
                
                if format_key not in raw_downloads_map:
                    raw_downloads_map[format_key] = []

                dl_url = dl.get("download_url")
                if dl_url and not any(existing.get("download_url") == dl_url for existing in raw_downloads_map[format_key]):
                    raw_downloads_map[format_key].append({
                        "server_name": dl.get("server_name"),
                        "server_type": dl.get("server_type"),
                        "download_url": dl_url,
                        "file_size": res.get("file_size") or opt.get("size") or "",
                    })

        # Sort keys by batch pack priority -> Episode order -> Movie quality
        sorted_downloads_map = {
            k: raw_downloads_map[k] for k in sorted(raw_downloads_map.keys(), key=cls._sort_download_keys)
        }

        return {
            "name": details.get("title", ""),
            "url": target_url,
            "thumbnail": details.get("poster", ""),
            "synopsis": details.get("synopsis", ""),
            "category": details.get("category", []),
            "screenshots": details.get("screenshots", []),
            "downloads": sorted_downloads_map,
        }

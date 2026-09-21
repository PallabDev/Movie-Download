import asyncio
import base64
import codecs
import json
import os
import re
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple
from bs4 import BeautifulSoup
from curl_cffi.requests import AsyncSession

DEFAULT_BASE_DOMAIN = "https://hdhub4u.ms"
LANDING_PAGE_URL = "https://hdhub4u.bi/"
MODLIST_PORTAL_URL = "https://modlist.in"
VEGAMOVIES_BASE_DOMAIN = "https://vegamoviess.foo"
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

# In-memory caches
_cached_active_domain: Optional[str] = None
_cached_modlist_mirrors: Optional[Dict[str, str]] = None

def _rot13(s: str) -> str:
    return codecs.decode(s, "rot_13")

def _decode_greenmotors_payload(payload: str) -> Optional[str]:
    try:
        d1 = base64.b64decode(payload).decode("utf-8")
        d2 = base64.b64decode(d1).decode("utf-8")
        d3 = _rot13(d2)
        d4 = base64.b64decode(d3).decode("utf-8")
        data = json.loads(d4)
        if isinstance(data, dict) and "o" in data:
            return base64.b64decode(data["o"]).decode("utf-8")
    except Exception as e:
        print(f"[GREENMOTORS DECODE ERROR]: {e}")
    return None


class CloudflareScraper:
    """
    Multi-source AI-assisted scraping & direct download resolution engine:
    1. Multi-Source Scraping:
       - Source 1: HDHub4u (hdhub4u.bi -> dynamic active mirror)
       - Source 2: Modlist.in Directory (UHDMovies, MoviesMod, MoviesLeech, AnimeFlix)
       - Source 3: Vegamovies (vegamoviess.foo)
       - Custom Admin Sources
    2. Dynamic Domain Discovery & Mirror Routing
    3. AI Metadata Normalization & Quality Categorization
    4. 0s Intermediate Redirect Bypasser (HubCloud, HBLinks, ModPro, UnblockedGames, NexDrive, FastDL, V-Cloud)
    5. Direct High-Speed Download Resolver (Cloudflare R2, Google CDN, Fast CDN, Pixeldrain)
    """

    _ai_metadata_cache: Dict[str, Dict[str, Any]] = {}

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
        """Dynamically discovers the current working HDHub4u domain."""
        global _cached_active_domain
        if _cached_active_domain and not force_refresh:
            return _cached_active_domain

        headers = cls._get_browser_headers()
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
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
    async def get_modlist_mirrors(cls, impersonate: str = DEFAULT_IMPERSONATE, force_refresh: bool = False) -> Dict[str, str]:
        """Discovers active working domains from https://modlist.in."""
        global _cached_modlist_mirrors
        if _cached_modlist_mirrors and not force_refresh:
            return _cached_modlist_mirrors

        defaults = {
            "uhdmovies": "https://uhdmovies.my",
            "moviesmod": "https://moviesmod.ai.in",
            "moviesleech": "https://moviesleech.club",
            "animeflix": "https://animeflix.dad",
        }
        mirrors = dict(defaults)
        headers = cls._get_browser_headers()

        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            for portal_key, portal_type in [
                ("uhdmovies", "uhdmovies"),
                ("moviesmod", "hollywood"),
                ("moviesleech", "bollywood"),
                ("animeflix", "animeflix"),
            ]:
                try:
                    url = f"{MODLIST_PORTAL_URL}/?type={portal_type}"
                    res = await session.get(url, headers=headers, timeout=10)
                    if res.status_code == 200:
                        m_url = re.search(r'url=([^"\'\s>]+)', res.text, re.I)
                        if m_url:
                            target = m_url.group(1).rstrip('/')
                            parsed = urllib.parse.urlsplit(target)
                            mirrors[portal_key] = f"{parsed.scheme}://{parsed.netloc}"
                except Exception:
                    pass

        _cached_modlist_mirrors = mirrors
        return mirrors

    @classmethod
    def replace_domain(cls, url: str, base_domain: str) -> str:
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
        if not text:
            return None
        invalid_nums = {480, 720, 1080, 2160}
        m1 = re.search(r"\b[sS]\d{1,2}\s*[ ._-]?\s*[eE]([0-9]{1,3})\b", text)
        if m1:
            val = int(m1.group(1))
            if val not in invalid_nums and 0 < val <= 300:
                return val
        for m in re.finditer(r"\b[eE]([0-9]{1,3})\b", text):
            val = int(m.group(1))
            if val not in invalid_nums and 0 < val <= 300:
                return val
        for m in re.finditer(r"\b(?:episode|ep)\s*[-._]?\s*([0-9]{1,3})\b", text, re.I):
            val = int(m.group(1))
            end_pos = m.end()
            if end_pos < len(text) and text[end_pos:end_pos+1].lower() == 'p':
                continue
            if val not in invalid_nums and 0 < val <= 300:
                return val
        return None

    # ─────────────────────────────────────────────────────────────
    # SOURCE 1: HDHub4u Search & Details
    # ─────────────────────────────────────────────────────────────

    # ─────────────────────────────────────────────────────────────
    # SOURCE 1: HDHub4u Search & Details
    # ─────────────────────────────────────────────────────────────

    @classmethod
    async def search_hdhub4u(
        cls,
        query: str,
        page: int = 1,
        fetch_all: bool = True,
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> List[Dict[str, Any]]:
        clean_q = (query or "").strip()
        if not clean_q:
            return []

        base_domain = await cls.get_active_domain(impersonate=impersonate)
        headers = {
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": base_domain,
            "Referer": f"{base_domain}/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        }

        all_hits = []
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            # 1. Try active Pingora Typesense cluster
            try:
                pingora_url = (
                    "https://search.pingora.fyi/collections/post/documents/search"
                    f"?q={urllib.parse.quote(clean_q)}"
                    "&query_by=post_title,category,stars,director,imdb_id"
                    "&query_by_weights=4,2,2,2,4&sort_by=sort_by_date:desc&limit=15"
                    f"&highlight_fields=none&use_cache=true&page={page}"
                )
                res = await session.get(pingora_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                if res.status_code == 200:
                    data = res.json()
                    all_hits.extend(data.get("hits", []))
            except Exception as e:
                print(f"[HDHUB4U PINGORA SEARCH WARNING]: {e}")

            # 2. Fallback to secondary workers cluster if needed
            if not all_hits:
                try:
                    search_url = (
                        f"{SEARCH_BACKEND_URL}?q={urllib.parse.quote(clean_q)}"
                        f"&query_by=post_title,category,director,stars"
                        f"&page={page}&per_page=20&sort_by=post_date:desc"
                    )
                    res = await session.get(search_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                    if res.status_code == 200:
                        all_hits.extend(res.json().get("hits", []))
                except Exception as e:
                    print(f"[HDHUB4U WORKERS SEARCH WARNING]: {e}")

        items = []
        seen_urls = set()
        for h in all_hits:
            doc = h.get("document", {})
            title = doc.get("post_title") or doc.get("name") or ""
            raw_url = doc.get("permalink") or doc.get("url") or ""
            if not raw_url and doc.get("post_name"):
                raw_url = f"{base_domain.rstrip('/')}/{doc['post_name']}/"
            url = cls.replace_domain(raw_url, base_domain)

            if not url or url in seen_urls:
                continue
            seen_urls.add(url)

            # Quality tag extraction
            q_tags = []
            for q in ["4K", "2160p", "1080p", "720p", "480p", "HEVC", "Dual Audio", "Hindi", "English"]:
                if re.search(r'\b' + re.escape(q) + r'\b', title, re.I):
                    q_tags.append(q)

            thumb = doc.get("post_thumbnail") or doc.get("thumbnail") or ""

            items.append({
                "title": title,
                "name": title,
                "url": url,
                "permalink": url,
                "thumbnail": thumb,
                "source": "HDHub4u",
                "source_type": "hdhub4u",
                "category": doc.get("category", []),
                "categories": doc.get("category", []),
                "quality_tags": q_tags,
                "post_date": doc.get("post_date", ""),
                "stars": doc.get("stars", []),
            })

        return items

    # ─────────────────────────────────────────────────────────────
    # SOURCE 2: Modlist.in (UHDMovies, MoviesMod, MoviesLeech)
    # ─────────────────────────────────────────────────────────────

    @classmethod
    async def search_modlist(
        cls,
        query: str,
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> List[Dict[str, Any]]:
        clean_q = (query or "").strip()
        if not clean_q:
            return []

        q_words = [w.lower() for w in re.split(r'\s+', clean_q) if len(w) > 2]
        mirrors = await cls.get_modlist_mirrors(impersonate=impersonate)
        headers = cls._get_browser_headers()
        items = []
        seen_urls = set()

        async def search_single_mirror(name: str, domain: str, stype: str):
            res_items = []
            async with AsyncSession(impersonate=impersonate, verify=False) as session:
                try:
                    s_url = f"{domain.rstrip('/')}/?s={urllib.parse.quote(clean_q)}"
                    res = await session.get(s_url, headers=headers, timeout=15)
                    if res.status_code != 200:
                        return []
                    soup = BeautifulSoup(res.text, "html.parser")
                    cards = soup.select("article, .post-item, .latest-post, div.blog-post, .entry-title a")
                    for c in cards:
                        a = c if c.name == "a" else c.find("a")
                        if not a:
                            continue
                        href = a.get("href", "")
                        if not href or any(k in href.lower() for k in ["/category/", "/tag/", "/author/", "/page/", "#", "/genre/", "/how-to", "?type="]):
                            continue
                        if href.startswith("/"):
                            href = f"{domain.rstrip('/')}{href}"
                        title = a.get("title") or a.get_text(strip=True) or (c.get_text(strip=True) if c.name != "a" else "")
                        if len(title) < 5 or any(k in title.lower() for k in ["home", "bollywood", "hollywood", "dual audio", "search", "moviesmod team", "latest released", "imdb top"]):
                            continue

                        # Verify relevant match
                        if q_words and not any(w in title.lower() or w in href.lower() for w in q_words):
                            continue

                        img = c.find("img") if c.name != "a" else None
                        thumb = (img.get("src") or img.get("data-src")) if img else ""

                        q_tags = []
                        for q in ["4K", "2160p", "1080p", "720p", "480p", "HEVC", "Dual Audio", "Hindi", "English"]:
                            if re.search(r'\b' + re.escape(q) + r'\b', title, re.I):
                                q_tags.append(q)

                        if href not in seen_urls:
                            seen_urls.add(href)
                            res_items.append({
                                "title": title,
                                "name": title,
                                "url": href,
                                "permalink": href,
                                "thumbnail": thumb,
                                "source": name,
                                "source_type": stype,
                                "quality_tags": q_tags,
                                "categories": [name],
                            })
                except Exception as e:
                    print(f"[MODLIST {name} ERROR]: {e}")
            return res_items

        tasks = [
            search_single_mirror("UHDMovies", mirrors.get("uhdmovies", "https://uhdmovies.my"), "modlist"),
            search_single_mirror("MoviesMod", mirrors.get("moviesmod", "https://moviesmod.ai.in"), "modlist"),
            search_single_mirror("MoviesLeech", mirrors.get("moviesleech", "https://moviesleech.club"), "modlist"),
        ]
        results_nested = await asyncio.gather(*tasks, return_exceptions=True)
        for r in results_nested:
            if isinstance(r, list):
                items.extend(r)

        return items

    # ─────────────────────────────────────────────────────────────
    # SOURCE 3: Vegamovies Search & Details
    # ─────────────────────────────────────────────────────────────

    @classmethod
    async def search_vegamovies(
        cls,
        query: str,
        domain: str = VEGAMOVIES_BASE_DOMAIN,
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> List[Dict[str, Any]]:
        clean_q = (query or "").strip()
        if not clean_q:
            return []

        q_words = [w.lower() for w in re.split(r'\s+', clean_q) if len(w) > 2]
        headers = cls._get_browser_headers()
        items = []
        seen_urls = set()

        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            try:
                search_url = f"{domain.rstrip('/')}/?s={urllib.parse.quote(clean_q)}"
                res = await session.get(search_url, headers=headers, timeout=15)
                if res.status_code == 200:
                    soup = BeautifulSoup(res.text, "html.parser")
                    for card in soup.select("article, .post-item, .blog-entry"):
                        a = card.find("a")
                        if not a:
                            continue
                        href = a.get("href", "")
                        if not href or not (href.endswith(".html") or "/5" in href or "/4" in href):
                            continue
                        if any(k in href.lower() for k in ["/category/", "/tag/", "/author/", "/page/", "#", "/genre/", "/how-to", "/report"]):
                            continue
                        if href.startswith("/"):
                            href = f"{domain.rstrip('/')}{href}"
                        title = a.get("title") or a.get_text(strip=True) or card.get_text(strip=True)
                        if len(title) < 5 or any(k in title.lower() for k in ["home", "bollywood", "hollywood", "dual audio"]):
                            continue

                        # Verify relevant match
                        if q_words and not any(w in title.lower() or w in href.lower() for w in q_words):
                            continue

                        img = card.find("img")
                        thumb = (img.get("src") or img.get("data-src")) if img else ""

                        q_tags = []
                        for q in ["4K", "2160p", "1080p", "720p", "480p", "HEVC", "Dual Audio", "Hindi", "English"]:
                            if re.search(r'\b' + re.escape(q) + r'\b', title, re.I):
                                q_tags.append(q)

                        if href not in seen_urls:
                            seen_urls.add(href)
                            items.append({
                                "title": title,
                                "name": title,
                                "url": href,
                                "permalink": href,
                                "thumbnail": thumb,
                                "source": "Vegamovies",
                                "source_type": "vegamovies",
                                "quality_tags": q_tags,
                                "categories": ["Vegamovies"],
                            })
            except Exception as e:
                print(f"[VEGAMOVIES SEARCH ERROR]: {e}")

        return items

    # ─────────────────────────────────────────────────────────────
    # UNIFIED MULTI-SOURCE SEARCH ORCHESTRATOR
    # ─────────────────────────────────────────────────────────────

    @classmethod
    async def search_multi_sources(
        cls,
        query: str,
        sources: Optional[List[Dict[str, Any]]] = None,
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> List[Dict[str, Any]]:
        clean_q = (query or "").strip()
        if not clean_q:
            return []

        enabled_types = set()
        if sources:
            for s in sources:
                if s.get("enabled", True):
                    stype = s.get("type", "").lower()
                    if stype in ["hdhub4u", "modlist", "vegamovies"]:
                        enabled_types.add(stype)
        else:
            enabled_types = {"hdhub4u", "modlist", "vegamovies"}

        # Generate query variants (e.g. O'Romeo -> O Romeo, oromeo -> O Romeo)
        variants = [clean_q]
        v1 = re.sub(r"['’`:\-_.]+", " ", clean_q).strip()
        v1 = re.sub(r"\s+", " ", v1)
        if v1 and v1.lower() not in [v.lower() for v in variants]:
            variants.append(v1)

        if re.match(r"^[oO][a-zA-Z]{3,}", clean_q):
            v2 = clean_q[0] + " " + clean_q[1:]
            if v2.lower() not in [v.lower() for v in variants]:
                variants.append(v2)

        v3 = re.sub(r"['’`]+", "", clean_q).strip()
        if v3 and v3.lower() not in [v.lower() for v in variants]:
            variants.append(v3)

        seen_urls = set()
        aggregated = []

        async def run_search_for_query(q_term: str):
            tasks = []
            if "hdhub4u" in enabled_types:
                tasks.append(cls.search_hdhub4u(q_term, impersonate=impersonate))
            if "modlist" in enabled_types:
                tasks.append(cls.search_modlist(q_term, impersonate=impersonate))
            if "vegamovies" in enabled_types:
                tasks.append(cls.search_vegamovies(q_term, impersonate=impersonate))

            batch_results = await asyncio.gather(*tasks, return_exceptions=True)
            batch_items = []
            for r in batch_results:
                if isinstance(r, list):
                    batch_items.extend(r)
            return batch_items

        # Execute searches across variants
        for q_variant in variants:
            items = await run_search_for_query(q_variant)
            for item in items:
                u = item.get("url")
                if u and u not in seen_urls:
                    seen_urls.add(u)
                    aggregated.append(item)
            if len(aggregated) >= 3:
                break

        return aggregated

    # ─────────────────────────────────────────────────────────────
    # MULTI-SOURCE MOVIE & SERIES DETAILS EXTRACTOR
    # ─────────────────────────────────────────────────────────────

    GATEWAY_DOMAINS = [
        "hubcloud", "hubdrive", "hblinks", "greenmount", "greenmotors", "mediator", "search-recover",
        "leechpro", "modpro", "links.", "techmny", "fastdl", "fast-dl", "vcloud", "hubcdn", "hdstream4u",
        "nexdrive", "cloud.unblockedgames", "unblockedgames", "gdirect", "gdflix", "filepress", "pixeldrain", "drive"
    ]

    @classmethod
    def _is_valid_download_gateway_url(cls, href: str) -> bool:
        if not href:
            return False
        h = href.lower()
        if any(bad in h for bad in ["/how-to-", "telegram", "t.me", "#", "report", "/category/", "/tag/", "/author/", "/page/", "/genre/", "google.com", "whatsapp"]):
            return False
        return any(gw in h for gw in cls.GATEWAY_DOMAINS)

    @classmethod
    def _find_nearest_heading_context(cls, element) -> str:
        parent = element.parent
        if parent:
            prev_sib = parent.find_previous_sibling(["p", "h1", "h2", "h3", "h4", "h5", "h6", "div"])
            if prev_sib:
                t = prev_sib.get_text(" ", strip=True)
                if any(q in t.lower() for q in ["480p", "720p", "1080p", "4k", "2160p", "episode", "pack", "batch", "zip", "download "]):
                    return t

        parent_text = parent.get_text(" ", strip=True) if parent else ""
        if any(q in parent_text.lower() for q in ["480p", "720p", "1080p", "4k", "2160p", "episode", "pack", "batch", "zip", "season"]):
            return parent_text

        for prev in element.find_all_previous(["h1", "h2", "h3", "h4", "h5", "h6", "p", "strong"]):
            t = prev.get_text(" ", strip=True)
            if len(t) < 120 and any(q in t.lower() for q in ["480p", "720p", "1080p", "4k", "2160p", "episode", "pack", "batch", "zip", "download "]):
                return t

        return parent_text

    @classmethod
    def _find_nearest_episode_num(cls, element) -> Optional[int]:
        invalid = {480, 720, 1080, 2160}
        direct_text = element.get_text(" ", strip=True) + " " + (element.parent.get_text(" ", strip=True) if element.parent else "")
        m = re.search(r'\b(?:episode|ep)\s*[-._]?\s*([0-9]{1,3})\b', direct_text, re.I)
        if m and int(m.group(1)) not in invalid:
            return int(m.group(1))

        # Check previous siblings or headings, stopping at batch boundaries (NEVER check ancestor 'div' tags)
        for prev in element.find_all_previous(["h1", "h2", "h3", "h4", "h5", "h6", "p", "strong", "b"]):
            t = prev.get_text(" ", strip=True)
            if any(k in t.lower() for k in ["zip", "batch", "pack", "full season", "download links", "sdr web-dl", "complete series", "complete season"]):
                return None
            m = re.search(r'\b(?:episode|ep)\s*[-._]?\s*([0-9]{1,3})\b', t, re.I)
            if m and int(m.group(1)) not in invalid:
                return int(m.group(1))
        return None

    @classmethod
    def _extract_clean_size(cls, text: str) -> str:
        m = re.search(r'\[([0-9.]+\s*(?:MB|GB|mb|gb|GD|gd)(?:/[a-zA-Z]+)?)\]|\b([0-9.]+\s*(?:MB|GB|mb|gb))\b', text or '', re.I)
        if m:
            val = (m.group(1) or m.group(2)).strip()
            return val.replace('GD', 'GB').replace('gd', 'GB')
        return ''

    @classmethod
    def _extract_clean_res(cls, text: str, fallback: str = "720p") -> str:
        t = (text or '').lower()
        if '4k' in t or '2160p' in t or 'uhd' in t:
            return '4K'
        if '1080p' in t or 'fhd' in t:
            return '1080p'
        if '720p' in t or 'hd' in t:
            return '720p'
        if '480p' in t or 'sd' in t:
            return '480p'
        return fallback

    @classmethod
    async def _parse_page_download_options(
        cls, 
        html: str, 
        url: str, 
        source_name: str,
        session: Optional[AsyncSession] = None,
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> Dict[str, Any]:
        soup = BeautifulSoup(html, "html.parser")
        raw_title = soup.title.string.strip() if soup.title else ""
        for prefix in ["HDHub4u", "Vegamovies", "MoviesMod", "UHDMovies", "MoviesLeech", "– Official", "- Vegamovies", "| MoviesMod", "– HDHub4u Official", "Download"]:
            raw_title = raw_title.replace(prefix, "").strip()

        is_series = bool(re.search(r'season|\bS\d+\b|all episode|episodes', raw_title, re.I))

        options = []
        seen_hrefs = set()
        archive_tasks = []

        headers = cls._get_browser_headers(referer=url)

        for a in soup.find_all("a"):
            href = a.get("href", "").strip()
            if not cls._is_valid_download_gateway_url(href) or href in seen_hrefs:
                continue

            seen_hrefs.add(href)

            parent = a.parent
            parent_text = parent.get_text(" ", strip=True) if parent else ""
            a_text = a.get_text(" ", strip=True)
            heading_context = cls._find_nearest_heading_context(a)

            full_context = f"{heading_context} | {parent_text} | {a_text}".strip()

            res = cls._extract_clean_res(a_text, "") or cls._extract_clean_res(parent_text, "") or cls._extract_clean_res(heading_context, "720p")
            size = cls._extract_clean_size(a_text) or cls._extract_clean_size(parent_text) or cls._extract_clean_size(heading_context)

            # Check if this link in a series post is positioned before the single episode section
            prev_headings = [h.get_text(" ", strip=True).lower() for h in a.find_all_previous(["h1", "h2", "h3", "h4"])]
            is_before_single_eps = False
            for h in prev_headings:
                if any(k in h for k in ["single episode", "episode links", "episodes links"]):
                    break
                if any(k in h for k in ["download links", "zip", "batch", "pack", "full season", "full series", "complete", "season 1", "season 2", "season 3", "season 4"]):
                    is_before_single_eps = True
                    break

            has_ep_in_link = bool(re.search(r'\b(?:episode|ep)\s*[-._]?\s*([0-9]{1,3})\b', a_text + " " + parent_text, re.I))
            is_gdrive_hub = bool("g-drive" in a_text.lower() or "drive" in a_text.lower() or "episode" in a_text.lower())
            is_batch_btn = bool("batch" in a_text.lower() or "zip" in a_text.lower() or "pack" in a_text.lower() or "complete" in a_text.lower() or "full season" in a_text.lower())
            
            if is_series and is_before_single_eps and not has_ep_in_link:
                is_batch = True
            elif is_batch_btn:
                is_batch = True
            elif is_gdrive_hub:
                is_batch = False
            else:
                is_batch = bool(
                    any(k in parent_text.lower() for k in ["pack", "complete", "full season", "sdr web-dl"]) or
                    any(k in heading_context.lower() for k in ["pack", "complete", "full season", "sdr web-dl"]) or
                    ("hevc [" in parent_text.lower() and not re.search(r'\bepisode\b', parent_text, re.I))
                )

            # Deep Sub-Archive Page Expansion (LeechPro / ModPro / Archive Hubs)
            if ("leechpro.blog/archives/" in href or "links.modpro.in/archives/" in href) and is_series and not is_batch:
                archive_tasks.append((href, res, size, full_context))
                continue

            ep_num = None if is_batch else cls._find_nearest_episode_num(a)

            if is_series and ep_num:
                opt_label = f"Episode {ep_num:02d} [{res}]" + (f" [{size}]" if size else "")
                cat_type = "episode"
                ep_val = ep_num
                is_batch_val = False
            elif is_series and (is_batch or not ep_num):
                codec = "[HEVC]" if "hevc" in full_context.lower() or "x265" in full_context.lower() else "[x264]"
                opt_label = f"Full Season Batch {res} {codec}" + (f" [{size}]" if size else "")
                cat_type = "batch_pack"
                ep_val = None
                is_batch_val = True
            else:
                codec = "[HEVC]" if "hevc" in full_context.lower() or "x265" in full_context.lower() else ""
                opt_label = f"{res} {codec}" + (f" [{size}]" if size else "").strip()
                cat_type = "movie"
                ep_val = None
                is_batch_val = False

            options.append({
                "label": opt_label,
                "quality": res,
                "size": size,
                "is_batch": is_batch_val,
                "episode_num": ep_val,
                "category_type": cat_type,
                "link_url": href,
                "server_name": "Direct Fast CDN",
                "server_type": "💾 Fast Server"
            })

        # Process any sub-archive tasks concurrently
        if archive_tasks and session:
            async def fetch_archive(arch_url: str, arch_res: str, arch_sz: str, arch_ctx: str):
                try:
                    arch_res_obj = await session.get(arch_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                    arch_soup = BeautifulSoup(arch_res_obj.text, "html.parser")
                    eps = []
                    for arch_a in arch_soup.find_all("a"):
                        h = arch_a.get("href", "").strip()
                        t = arch_a.get_text(" ", strip=True)
                        m_ep = re.search(r'\b(?:episode|ep)\s*([0-9]{1,3})\b', t, re.I)
                        if m_ep and cls._is_valid_download_gateway_url(h):
                            ep_n = int(m_ep.group(1))
                            eps.append({
                                "label": f"Episode {ep_n:02d} [{arch_res}]" + (f" [{arch_sz}]" if arch_sz else ""),
                                "quality": arch_res,
                                "size": arch_sz,
                                "is_batch": False,
                                "episode_num": ep_n,
                                "category_type": "episode",
                                "link_url": h,
                                "server_name": "Direct Fast CDN",
                                "server_type": "💾 Fast Server"
                            })
                    return eps
                except Exception as e:
                    print(f"[ARCHIVE FETCH ERROR] {arch_url}: {e}")
                    return []

            results = await asyncio.gather(*[fetch_archive(u, q, s, c) for u, q, s, c in archive_tasks])
            for ep_list in results:
                options.extend(ep_list)

        # Backward compatible downloads dictionary with standardized batch_ and episode_ keys
        downloads_map = {}
        for opt in options:
            if opt.get("category_type") == "batch_pack" or opt.get("is_batch"):
                base_k = re.sub(r'[^a-zA-Z0-9_]+', '_', opt['label'].lower()).strip('_')
                k = f"batch_{base_k}" if not base_k.startswith("batch_") else base_k
            elif opt.get("episode_num"):
                ep_n = opt["episode_num"]
                q = (opt.get("quality") or "720p").lower()
                sz = re.sub(r'[^a-zA-Z0-9]+', '_', opt.get("size") or "").strip('_').lower()
                k = f"episode_{ep_n:02d}_{q}" + (f"_{sz}" if sz else "")
            else:
                k = re.sub(r'[^a-zA-Z0-9_]+', '_', opt['label'].lower()).strip('_')

            downloads_map.setdefault(k, []).append({
                "server_name": opt["server_name"],
                "server_type": opt["server_type"],
                "download_url": opt["link_url"],
                "file_size": opt["size"]
            })

        poster = ""
        img = soup.find("img", class_=lambda c: c and any(k in c for k in ["attachment", "post", "thumb", "entry"]))
        if img:
            poster = img.get("src") or img.get("data-src") or ""

        return {
            "title": raw_title,
            "name": raw_title,
            "url": url,
            "poster": poster,
            "thumbnail": poster,
            "is_tv_series": is_series,
            "download_options": options,
            "downloads": downloads_map,
            "source": source_name
        }

    @classmethod
    async def get_movie_details(
        cls,
        movie_url: str,
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> Dict[str, Any]:
        """Scrapes movie/show detail page and returns all structured download options."""
        url_lower = movie_url.lower()

        if "vegamovies" in url_lower:
            return await cls._get_vegamovies_details(movie_url, impersonate=impersonate)
        if any(k in url_lower for k in ["moviesmod", "uhdmovies", "moviesleech", "animeflix"]):
            return await cls._get_modlist_details(movie_url, impersonate=impersonate)

        return await cls._get_hdhub4u_details(movie_url, impersonate=impersonate)

    @classmethod
    async def _get_vegamovies_details(cls, movie_url: str, impersonate: str = DEFAULT_IMPERSONATE) -> Dict[str, Any]:
        headers = cls._get_browser_headers()
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            try:
                res = await session.get(movie_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                return await cls._parse_page_download_options(res.text, movie_url, "Vegamovies", session=session, impersonate=impersonate)
            except Exception as e:
                print(f"[VEGAMOVIES DETAILS ERROR]: {e}")
                return {"name": "", "title": "", "url": movie_url, "downloads": {}, "download_options": []}

    @classmethod
    async def _get_modlist_details(cls, movie_url: str, impersonate: str = DEFAULT_IMPERSONATE) -> Dict[str, Any]:
        headers = cls._get_browser_headers()
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            try:
                res = await session.get(movie_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                return await cls._parse_page_download_options(res.text, movie_url, "Modlist", session=session, impersonate=impersonate)
            except Exception as e:
                print(f"[MODLIST DETAILS ERROR]: {e}")
                return {"name": "", "title": "", "url": movie_url, "downloads": {}, "download_options": []}

    @classmethod
    async def _get_hdhub4u_details(cls, movie_url: str, impersonate: str = DEFAULT_IMPERSONATE) -> Dict[str, Any]:
        headers = cls._get_browser_headers()
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            try:
                res = await session.get(movie_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                return await cls._parse_page_download_options(res.text, movie_url, "HDHub4u", session=session, impersonate=impersonate)
            except Exception as e:
                print(f"[HDHUB4U DETAILS ERROR]: {e}")
                return {"name": "", "title": "", "url": movie_url, "downloads": {}, "download_options": []}

    # ─────────────────────────────────────────────────────────────
    # 0s INTERMEDIATE REDIRECT BYPASSER & DIRECT LINK RESOLVER
    # ─────────────────────────────────────────────────────────────

    @classmethod
    async def bypass_intermediate_link(cls, link_url: str, referer: Optional[str] = None, impersonate: str = DEFAULT_IMPERSONATE) -> str:
        """Instant 0-second bypass of mediator redirect sites (greenmotors, unblockedgames, modpro, etc.)."""
        ref = referer or cls._cached_active_domain or "https://new6.hdhub4u.cl/"
        headers = cls._get_browser_headers(referer=ref)
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            try:
                # ModPro / UnblockedGames auto-bypass
                if "unblockedgames" in link_url or "links.modpro" in link_url or "leechpro" in link_url:
                    res1 = await session.get(link_url, headers=headers, timeout=15)
                    soup1 = BeautifulSoup(res1.text, "html.parser")
                    form1 = soup1.find("form", id="landing")
                    if form1:
                        data1 = {inp.get("name"): inp.get("value") for inp in form1.find_all("input")}
                        res2 = await session.post("https://cloud.unblockedgames.world/", data=data1, headers={**headers, "Referer": link_url}, timeout=15)
                        soup2 = BeautifulSoup(res2.text, "html.parser")
                        form2 = soup2.find("form", id="landing")
                        if form2:
                            act2 = form2.get("action") or "https://cloud.unblockedgames.world/"
                            act2_url = act2 if act2.startswith("http") else urllib.parse.urljoin("https://cloud.unblockedgames.world/", act2)
                            data2 = {inp.get("name"): inp.get("value") for inp in form2.find_all("input")}
                            res3 = await session.post(act2_url, data=data2, headers={**headers, "Referer": "https://cloud.unblockedgames.world/"}, timeout=15)
                            
                            m_cookie = re.search(r"s_343\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]", res3.text)
                            m_go = re.search(r"c\.setAttribute\s*\(\s*['\"]href['\"]\s*,\s*['\"]([^'\"]+)['\"]", res3.text)
                            if m_cookie and m_go:
                                c_name, c_val = m_cookie.group(1), m_cookie.group(2)
                                res4 = await session.get(m_go.group(1), cookies={c_name: c_val}, headers={**headers, "Referer": act2_url}, timeout=15)
                                m_ref = re.search(r'url=([^"\'\s>]+)', res4.text, re.I)
                                if m_ref:
                                    return m_ref.group(1)

                # Greenmotors / Greenmount / Homelander mediator bypass (requires valid Referer)
                res = await session.get(link_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                
                # Check s('o', '...')
                m_s = re.search(r"s\s*\(\s*['\"]o['\"]\s*,\s*['\"]([A-Za-z0-9+/=]{30,})['\"]", res.text)
                if m_s:
                    target = _decode_greenmotors_payload(m_s.group(1))
                    if target:
                        return target

                # Check large base64 strings in scripts
                for m_str in re.finditer(r"['\"]([A-Za-z0-9+/=]{60,})['\"]", res.text):
                    target = _decode_greenmotors_payload(m_str.group(1))
                    if target and target.startswith("http"):
                        return target

                m_target = re.search(r'const\s+TARGET_URL\s*=\s*["\']([^"\']+)["\']', res.text)
                if m_target:
                    return m_target.group(1)
                m_href = re.search(r'href=["\']([^"\']*(?:hubcloud|hubdrive|hblinks|hubcdn)[^"\']*)["\']', res.text, re.I)
                if m_href:
                    return m_href.group(1)
            except Exception as e:
                print(f"[BYPASS ERROR] {link_url}: {e}")
        return link_url

    @classmethod
    async def extract_final_download_links(cls, link_url: str, impersonate: str = DEFAULT_IMPERSONATE) -> Dict[str, Any]:
        """Resolves intermediate URLs (HubCloud, HubDrive, HBLinks, NexDrive, FastDL, UnblockedGames) into direct streaming CDN URLs."""
        ref = cls._cached_active_domain or "https://new6.hdhub4u.cl/"
        headers = cls._get_browser_headers(referer=ref)
        target_url = link_url

        if any(k in link_url.lower() for k in ["greenmount", "greenmotors", "unblockedgames", "id=", "modpro", "leechpro"]):
            target_url = await cls.bypass_intermediate_link(link_url, referer=ref, impersonate=impersonate)

        url_lower = target_url.lower()

        # Direct CDN fast-path
        if any(k in url_lower for k in ["video-downloads.googleusercontent.com", "pixeldrain.com/api/file", "workers.dev", "r2.dev", "pub-", "r2.cloudflarestorage.com"]):
            return {
                "source_url": target_url,
                "filename": "Direct Download File",
                "final_downloads": [{
                    "server_name": "Download [Server : 10Gbps]",
                    "server_type": "⚡ Server : 10Gbps High Speed (Google CDN)",
                    "download_url": target_url,
                    "file_size": ""
                }],
                "total_servers": 1,
                "is_streamable": True
            }

        # HBLinks URL (e.g. hblinks.lol/archives/...)
        if "hblinks." in url_lower:
            try:
                async with AsyncSession(impersonate=impersonate, verify=False) as session:
                    hb_res = await session.get(target_url, headers={**headers, "Referer": link_url}, timeout=DEFAULT_TIMEOUT)
                    hb_soup = BeautifulSoup(hb_res.text, "html.parser")
                    inner_links = []
                    for a in hb_soup.find_all("a"):
                        h = a.get("href", "")
                        if any(k in h.lower() for k in ["hubcloud", "hubdrive", "hubcdn", "pixeldrain", "workers.dev", "drive"]) and not ("hblinks.lol/" in h.lower() and "/archives/" not in h.lower()):
                            inner_links.append(h)
                    
                    if inner_links:
                        hubcloud_links = [h for h in inner_links if "hubcloud." in h.lower()]
                        other_links = [h for h in inner_links if "hubcloud." not in h.lower()]
                        for candidate in (hubcloud_links + other_links):
                            candidate_res = await cls.extract_final_download_links(candidate, impersonate=impersonate)
                            if candidate_res.get("total_servers", 0) > 0:
                                return candidate_res
            except Exception as e:
                print(f"[HBLINKS EXTRACT ERROR] {target_url}: {e}")

        # NexDrive URL (Vegamovies)
        if "nexdrive." in url_lower:
            try:
                async with AsyncSession(impersonate=impersonate, verify=False) as session:
                    res = await session.get(target_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                    soup = BeautifulSoup(res.text, "html.parser")
                    filename = soup.title.string.strip() if soup.title else ""
                    raw_links = []
                    for a in soup.find_all("a"):
                        h = a.get("href", "")
                        t = a.get_text(" ", strip=True)
                        if h and ("http" in h) and not any(k in h.lower() for k in ["telegram", "t.me", "report"]):
                            raw_links.append({
                                "server_name": t or "Direct Fast CDN",
                                "server_type": "💾 Direct Fast CDN",
                                "download_url": h
                            })
                    return {
                        "source_url": target_url,
                        "filename": filename,
                        "final_downloads": raw_links,
                        "total_servers": len(raw_links)
                    }
            except Exception:
                pass

        # HubDrive / HubCDN / HDStream4u URL
        if any(k in url_lower for k in ["hubdrive.", "hubcdn.", "hdstream4u."]):
            try:
                async with AsyncSession(impersonate=impersonate, verify=False) as session:
                    res = await session.get(target_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                    soup = BeautifulSoup(res.text, "html.parser")
                    filename = soup.title.string.replace("HubDrive | ", "").replace("HubCDN | ", "").strip() if soup.title else ""
                    
                    hubcloud_url = None
                    for a in soup.find_all("a"):
                        href = a.get("href", "")
                        if "hubcloud" in href and "drive" in href:
                            hubcloud_url = href
                            break

                    if hubcloud_url:
                        return await cls.extract_final_download_links(hubcloud_url, impersonate=impersonate)

                    raw_links = []

                    # 1. Check for hubcdn script redirect (e.g. reurl with ?r= base64 payload containing ?link=)
                    m_reurl = re.search(r'reurl\s*=\s*["\']([^"\']+)["\']', res.text)
                    if m_reurl:
                        re_val = m_reurl.group(1)
                        m_r = re.search(r'[?&]r=([A-Za-z0-9+/=]+)', re_val)
                        if m_r:
                            try:
                                dec_r = base64.b64decode(m_r.group(1)).decode("utf-8")
                                m_link = re.search(r'[?&]link=([^"\'\s&]+)', dec_r)
                                direct_link = m_link.group(1) if m_link else None
                                if not direct_link:
                                    m_r2 = re.search(r'(https://[a-zA-Z0-9._-]+\.r2\.(?:dev|cloudflarestorage\.com)/[a-zA-Z0-9._-]+)', dec_r)
                                    if m_r2:
                                        direct_link = m_r2.group(1)
                                if direct_link:
                                    raw_links.append({
                                        "server_name": "Download [Cloudflare R2 Fast CDN]",
                                        "server_type": "💾 Direct Fast CDN",
                                        "download_url": direct_link
                                    })
                            except Exception as re_err:
                                print(f"[HUBCDN DECODE NOTICE]: {re_err}")

                    # 2. Check for HDStream4u / morencius download URLs
                    if "hdstream4u." in url_lower:
                        m_dl = re.search(r'(https?://[^\s"\'<>]*(?:morencius\.com|hdstream4u\.com)/download/[^\s"\'<>]+)', res.text)
                        if m_dl:
                            raw_links.append({
                                "server_name": "Download [HDStream4u Server]",
                                "server_type": "⚡ Fast Streaming Server",
                                "download_url": m_dl.group(1)
                            })

                    # 3. Check for standard anchor links (R2, Google Storage, Pixeldrain, gpdl, workers.dev)
                    for a in soup.find_all("a"):
                        h = a.get("href", "")
                        if any(x in h for x in ["r2.cloudflarestorage.com", "storage.googleapis.com", "pixeldrain", "gpdl.", "workers.dev", "r2.dev"]):
                            stype = "💾 Direct Download File (Fast CDN)"
                            sname = a.get_text(strip=True) or stype
                            if "pixeldrain" in h:
                                stype = "📦 Pixeldrain Fast Download"
                                pd_m = re.search(r"pixeldrain\.(?:dev|com)/u/([a-zA-Z0-9_-]+)", h)
                                if pd_m:
                                    h = f"https://pixeldrain.com/api/file/{pd_m.group(1)}"
                            raw_links.append({
                                "server_name": sname,
                                "server_type": stype,
                                "download_url": h
                            })
                    if raw_links:
                        return {
                            "source_url": target_url,
                            "filename": filename or "Movie Download File",
                            "final_downloads": raw_links,
                            "total_servers": len(raw_links)
                        }
            except Exception as hub_err:
                print(f"[HUBDRIVE/HUBCDN EXTRACT ERROR]: {hub_err}")

        # HubCloud URL (e.g. hubcloud.cx/drive/..., hubcloud.ist/drive/...)
        try:
            async with AsyncSession(impersonate=impersonate, verify=False) as session:
                res1 = await session.get(target_url, headers=headers, timeout=DEFAULT_TIMEOUT)
                soup1 = BeautifulSoup(res1.text, "html.parser")
                filename = soup1.title.string.strip() if soup1.title else "Movie Download File"

                gen_link = None
                for a in soup1.find_all("a"):
                    href = a.get("href", "")
                    if "hubcloud.php" in href or "token=" in href:
                        gen_link = href
                        break

                raw_downloads = []
                if gen_link:
                    if not gen_link.startswith("http"):
                        gen_link = urllib.parse.urljoin(str(res1.url), gen_link)
                    gen_headers = {**headers, "Referer": target_url}
                    res2 = await session.get(gen_link, headers=gen_headers, timeout=DEFAULT_TIMEOUT)
                    soup2 = BeautifulSoup(res2.text, "html.parser")
                    for a in soup2.find_all("a"):
                        href = a.get("href", "")
                        text = a.get_text(" ", strip=True)
                        if not href or not href.startswith("http"):
                            continue
                        if any(k in href.lower() for k in ["telegram", "t.me", "report", "#", "snvhost.com", "google.com/search", "tinyurl.com", "/admin"]):
                            continue

                        # Handle Pixel HubCloud Google 10Gbps CDN redirect
                        if "pixel.hubcloud.ist/?id=" in href:
                            try:
                                r_pixel = await session.get(href, headers={**headers, "Referer": str(res2.url)}, timeout=10)
                                if "link=" in str(r_pixel.url):
                                    g_link = urllib.parse.unquote(str(r_pixel.url).split("link=")[1])
                                    if g_link.startswith("http"):
                                        raw_downloads.append({
                                            "server_name": "Download [Server : 10Gbps High Speed]",
                                            "server_type": "⚡ Server : 10Gbps High Speed (Google CDN)",
                                            "download_url": g_link
                                        })
                                        continue
                            except Exception as pe:
                                print(f"[PIXEL RESOLVE ERROR]: {pe}")

                        # Handle Pixeldrain /u/ID -> /api/file/ID
                        if "pixeldrain" in href.lower():
                            pd_m = re.search(r"pixeldrain\.(?:dev|com)/u/([a-zA-Z0-9_-]+)", href)
                            pd_url = f"https://pixeldrain.com/api/file/{pd_m.group(1)}" if pd_m else href
                            raw_downloads.append({
                                "server_name": "Download [Pixeldrain Fast Download]",
                                "server_type": "📦 Pixeldrain Fast Download",
                                "download_url": pd_url
                            })
                            continue

                        # Handle Workers / R2 / Direct CDN streams
                        if any(k in href.lower() for k in ["workers.dev", "r2.cloudflarestorage.com", "storage.googleapis.com", "r2.dev"]):
                            stype = "💾 Direct Fast CDN"
                            raw_downloads.append({
                                "server_name": text or "Download [Direct Fast CDN]",
                                "server_type": stype,
                                "download_url": href
                            })
                else:
                    for a in soup1.find_all("a"):
                        h = a.get("href", "")
                        if any(x in h for x in ["r2.cloudflarestorage.com", "storage.googleapis.com", "pixeldrain", "gpdl.", "workers.dev"]):
                            stype = "💾 Direct Fast CDN"
                            if "pixeldrain" in h:
                                stype = "📦 Pixeldrain Fast Download"
                                pd_m = re.search(r"pixeldrain\.(?:dev|com)/u/([a-zA-Z0-9_-]+)", h)
                                if pd_m:
                                    h = f"https://pixeldrain.com/api/file/{pd_m.group(1)}"
                            raw_downloads.append({
                                "server_name": a.get_text(strip=True) or stype,
                                "server_type": stype,
                                "download_url": h
                            })

                return {
                    "source_url": target_url,
                    "filename": filename,
                    "final_downloads": raw_downloads,
                    "total_servers": len(raw_downloads)
                }
        except Exception as e:
            print(f"[EXTRACT FINAL DOWNLOADS ERROR]: {e}")

        return {
            "source_url": target_url,
            "filename": "",
            "final_downloads": [],
            "total_servers": 0
        }

    # ─────────────────────────────────────────────────────────────
    # CONNECTIVITY & SOURCE TESTER
    # ─────────────────────────────────────────────────────────────

    @classmethod
    async def test_source_connectivity(
        cls,
        url: str,
        source_type: str = "generic",
        impersonate: str = DEFAULT_IMPERSONATE
    ) -> Dict[str, Any]:
        """Tests live HTTP connectivity, response latency, and active working domain for any source."""
        start = time.time()
        headers = cls._get_browser_headers()
        async with AsyncSession(impersonate=impersonate, verify=False) as session:
            try:
                res = await session.get(url, headers=headers, timeout=12)
                elapsed_ms = int((time.time() - start) * 1000)
                if res.status_code == 200:
                    return {
                        "ok": True,
                        "success": True,
                        "status": "online",
                        "statusCode": res.status_code,
                        "latencyMs": elapsed_ms,
                        "latency_ms": elapsed_ms,
                        "finalUrl": str(res.url),
                        "message": f"Source responsive ({elapsed_ms}ms)"
                    }
                else:
                    return {
                        "ok": False,
                        "success": False,
                        "status": "warning",
                        "statusCode": res.status_code,
                        "latencyMs": elapsed_ms,
                        "latency_ms": elapsed_ms,
                        "finalUrl": str(res.url),
                        "message": f"HTTP {res.status_code}"
                    }
            except Exception as e:
                elapsed_ms = int((time.time() - start) * 1000)
                return {
                    "ok": False,
                    "success": False,
                    "status": "offline",
                    "latencyMs": elapsed_ms,
                    "latency_ms": elapsed_ms,
                    "message": str(e)
                }

    # Legacy method aliases for backward compatibility
    get_movie_page_details = get_movie_details
    scrape_movie_page = get_movie_details
    search_movies = search_hdhub4u
    resolve_movie_direct_downloads = extract_final_download_links

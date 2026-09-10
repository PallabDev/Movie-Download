from pathlib import Path
from typing import Optional
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.scraper import CloudflareScraper, DEFAULT_BASE_DOMAIN

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(
    title="HDHub4u Multi-Scraper & Direct Download Resolver",
    description="Multi-stage scraper: Dynamic domain discovery from hdhub4u.bi, Pingora search engine, movie details scraper, and 10Gbps final direct download link extractor.",
    version="2.0.0",
)

# Ensure static & templates directory exist
STATIC_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@app.get("/", response_class=HTMLResponse)
async def home_page(request: Request):
    """Clean, focused Search-First Homepage."""
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "default_domain": DEFAULT_BASE_DOMAIN,
        },
    )


@app.get("/api/domain")
async def api_get_domain(
    force_refresh: bool = Query(False, description="Force re-query of hdhub4u.bi"),
    impersonate: str = Query("chrome124", description="Browser TLS profile"),
):
    """
    Step 1: Returns the live active working domain dynamically discovered from https://hdhub4u.bi/
    """
    try:
        domain = await CloudflareScraper.get_active_domain(
            impersonate=impersonate, 
            force_refresh=force_refresh
        )
        return JSONResponse(content={"active_domain": domain, "landing_page": "https://hdhub4u.bi/"})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Domain discovery failed: {str(exc)}")


@app.get("/search")
@app.get("/api/search")
@app.get("/api/scrape/search")
async def api_search(
    param: Optional[str] = Query(None, description="Movie/show search term, e.g. param=bahubali"),
    q: Optional[str] = Query(None, description="Movie, series title or search term"),
    query: Optional[str] = Query(None, description="Movie, series title or search term"),
    search: Optional[str] = Query(None, description="Movie, series title or search term"),
    page: int = Query(1, ge=1, description="Page number", examples=[1]),
    fetch_all: bool = Query(True, description="Automatically fetch and aggregate all pages"),
    impersonate: str = Query("chrome124", description="Browser TLS profile to impersonate"),
):
    """
    Endpoint 1: /search?param={name}
    Returns all search results with image/thumbnail, permalink, cast, and categories (without download links).
    """
    search_term = param or q or query or search
    if not search_term:
        raise HTTPException(status_code=400, detail="Search term is required. Example: /search?param=bahubali")

    try:
        results = await CloudflareScraper.search_movies(
            query=search_term, 
            page=page, 
            fetch_all=fetch_all,
            impersonate=impersonate
        )

        items_list = []
        for it in results.get("items", []):
            title = it.get("title") or it.get("name") or ""
            link = it.get("permalink") or it.get("url") or ""
            items_list.append({
                "name": title,
                "title": title,
                "url": link,
                "permalink": link,
                "thumbnail": it.get("thumbnail"),
                "category": it.get("category", []),
                "director": it.get("director", []),
                "stars": it.get("stars", []),
                "imdb_id": it.get("imdb_id"),
                "post_date": it.get("post_date"),
            })

        return JSONResponse(content=items_list)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(exc)}")


@app.get("/download")
@app.get("/api/download")
@app.get("/download/search={search_query:path}")
@app.get("/download/search/{search_query:path}")
async def api_download_endpoint(
    url: Optional[str] = Query(None, description="Movie page URL / permalink to extract downloads for"),
    swap_url: Optional[str] = Query(None, description="Movie page URL / permalink (swap URL)"),
    link: Optional[str] = Query(None, description="Movie page URL / permalink"),
    param: Optional[str] = Query(None, description="Movie URL or search term"),
    search: Optional[str] = Query(None, description="Movie title if searching"),
    q: Optional[str] = Query(None, description="Movie title if searching"),
    search_query: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, description="Max number of matching movies to resolve"),
    impersonate: str = Query("chrome124", description="Browser TLS profile to impersonate"),
):
    """
    Endpoint 2: /download?param={movie_url} or /download?param={hubdrive_url}
    Takes a specific movie page URL or HubDrive/HubCloud link and returns all final direct download links (10Gbps, Fast CDN, etc.).
    """
    target_url = url or swap_url or link
    
    # Case A: If user passed a movie page URL or file URL (via param, url, swap_url, or link)
    if not target_url and param and ("http://" in param or "https://" in param or "/" in param):
        target_url = param

    if target_url:
        try:
            if any(k in target_url.lower() for k in ["hubdrive.", "hubcloud.", "hblinks.", "greenmount"]):
                result = await CloudflareScraper.extract_final_download_links(
                    link_url=target_url,
                    impersonate=impersonate
                )
                return JSONResponse(content=result)
            else:
                result = await CloudflareScraper.resolve_movie_direct_downloads(
                    movie_url=target_url,
                    impersonate=impersonate
                )
                return JSONResponse(content=result)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Download extraction failed: {str(exc)}")


    # Case B: If user passed a search term to /download (e.g. /download?param=bahubali or /download/search=bahubali)
    search_term = search_query or search or q or param
    if search_term:
        if search_term.startswith("search="):
            search_term = search_term[len("search="):]

        try:
            results = await CloudflareScraper.search_and_resolve_downloads(
                query=search_term,
                limit=limit,
                impersonate=impersonate
            )
            return JSONResponse(content=results)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Download extraction failed: {str(exc)}")

    raise HTTPException(
        status_code=400, 
        detail="Movie URL or search parameter is required. Example: /download?param=https://new5.hdhub4u.cl/movie-page/ or /download?url=..."
    )


@app.get("/api/movie")
@app.get("/api/scrape/movie")
async def api_scrape_movie(
    url: str = Query(
        ...,
        description="Movie detail page URL to extract download links from",
        examples=["https://new5.hdhub4u.cl/bahubali-2-the-conclusion-2017-hindi-bluray-full-movie/"],
    ),
    impersonate: str = Query("chrome124", description="Browser TLS profile to impersonate"),
):
    """
    Scrapes the movie detail page and extracts storyline, screenshots, and all available download options & qualities.
    """
    try:
        movie_data = await CloudflareScraper.get_movie_details(
            movie_url=url,
            impersonate=impersonate
        )
        return JSONResponse(content=movie_data)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Movie scraping failed: {str(exc)}")


@app.get("/api/resolve")
@app.get("/api/scrape/resolve")
async def api_resolve_link(
    url: str = Query(
        ...,
        description="HubCloud, HBLinks, or intermediate URL to resolve to final 10Gbps/CDN direct download link",
        examples=["https://hubcloud.cx/drive/sghe8tiglsgw8sl", "https://hblinks.co/archives/70461"],
    ),
    impersonate: str = Query("chrome124", description="Browser TLS profile to impersonate"),
):
    """
    Resolves any HubCloud, HBLinks, or intermediate redirect URL directly to final 10Gbps High-Speed Server & Fast CDN (.mkv) URLs.
    """
    try:
        resolved_data = await CloudflareScraper.extract_final_download_links(
            link_url=url, 
            impersonate=impersonate
        )
        return JSONResponse(content=resolved_data)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Link resolution failed: {str(exc)}")


@app.get("/api/scrape/url")
async def api_fetch_url(
    url: str = Query(..., description="Full URL to fetch directly"),
    fetch_all: bool = Query(True, description="If URL is a search URL, fetch all pages"),
    impersonate: str = Query("chrome124", description="Browser TLS profile to impersonate"),
):
    """Legacy endpoint for direct URL fetching."""
    try:
        data = await CloudflareScraper.fetch_url(
            url=url, 
            impersonate=impersonate,
            fetch_all_pages=fetch_all
        )
        return JSONResponse(content=data)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Fetch failed: {str(exc)}")


@app.get("/api/health")
async def health_check():
    """Health status endpoint."""
    return {"status": "ok", "service": "hdhub4u-multi-scraper", "engine": "curl_cffi"}



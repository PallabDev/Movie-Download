from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, HTTPException, Query, Request, Body
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.scraper import CloudflareScraper, DEFAULT_BASE_DOMAIN

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(
    title="CineGrab Multi-Source AI Scraper & Direct Download Resolver",
    description="Intelligent multi-source movie & web series scraping engine (HDHub4u, Modlist/UHDMovies/MoviesMod, Vegamovies).",
    version="3.0.0",
)

STATIC_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@app.get("/", response_class=HTMLResponse)
async def home_page(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"default_domain": DEFAULT_BASE_DOMAIN},
    )


@app.get("/api/domain")
async def api_get_domain(
    force_refresh: bool = Query(False, description="Force re-query of active domain"),
    impersonate: str = Query("chrome124", description="Browser TLS profile"),
):
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
    param: Optional[str] = Query(None, description="Movie/show search term"),
    q: Optional[str] = Query(None, description="Movie, series title or search term"),
    query: Optional[str] = Query(None, description="Movie, series title or search term"),
    search: Optional[str] = Query(None, description="Movie, series title or search term"),
    source: Optional[str] = Query(None, description="Target specific source (hdhub4u, modlist, vegamovies, all)"),
    page: int = Query(1, ge=1, description="Page number"),
    fetch_all: bool = Query(True, description="Fetch all pages"),
    impersonate: str = Query("chrome124", description="Browser TLS profile"),
):
    """
    Search across enabled sources (HDHub4u, Modlist.in / UHDMovies / MoviesMod, Vegamovies).
    """
    search_term = param or q or query or search
    if not search_term:
        raise HTTPException(status_code=400, detail="Search term is required. Example: /search?param=bahubali")

    try:
        sources_filter = None
        if source and source.lower() != "all":
            sources_filter = [{"type": source.lower(), "enabled": True}]

        items_list = await CloudflareScraper.search_multi_sources(
            query=search_term,
            sources=sources_filter,
            impersonate=impersonate
        )

        return JSONResponse(content=items_list)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(exc)}")


@app.post("/api/scrape/multi-search")
async def api_multi_search(
    body: Dict[str, Any] = Body(...),
    impersonate: str = Query("chrome124", description="Browser TLS profile"),
):
    """
    Multi-source search endpoint accepting a query and a dynamic list of enabled sources.
    """
    query = body.get("query") or body.get("q") or body.get("param") or ""
    sources = body.get("sources")

    if not query:
        raise HTTPException(status_code=400, detail="Query string is required")

    try:
        items = await CloudflareScraper.search_multi_sources(
            query=query,
            sources=sources,
            impersonate=impersonate
        )
        return JSONResponse(content=items)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Multi-source search failed: {str(exc)}")


@app.get("/details")
@app.get("/api/details")
@app.get("/api/movie/details")
async def api_movie_details(
    url: Optional[str] = Query(None, description="Movie page URL"),
    param: Optional[str] = Query(None, description="Movie page URL"),
    impersonate: str = Query("chrome124", description="Browser TLS profile"),
):
    target_url = url or param
    if not target_url:
        raise HTTPException(status_code=400, detail="URL or param is required")
    try:
        details = await CloudflareScraper.get_movie_details(
            movie_url=target_url,
            impersonate=impersonate
        )
        return JSONResponse(content=details)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Details extraction failed: {str(exc)}")


@app.get("/download")
@app.get("/api/download")
async def api_download_endpoint(
    url: Optional[str] = Query(None, description="Movie page URL / permalink"),
    swap_url: Optional[str] = Query(None, description="Movie page URL"),
    link: Optional[str] = Query(None, description="Movie page URL"),
    param: Optional[str] = Query(None, description="Movie URL or search term"),
    link_url: Optional[str] = Query(None, description="Target intermediate or final link URL to resolve"),
    impersonate: str = Query("chrome124", description="Browser TLS profile"),
):
    target_url = url or swap_url or link or param
    if not target_url:
        raise HTTPException(status_code=400, detail="URL parameter is required")

    try:
        # If link_url is provided, or target_url is an intermediate download service
        eval_url = link_url or target_url
        if any(k in eval_url.lower() for k in ["hubdrive.", "hubcloud.", "hblinks.", "greenmount", "nexdrive", "vgmlinks", "unblockedgames", "links.modpro", "fast-dl", "vcloud"]):
            result = await CloudflareScraper.extract_final_download_links(
                link_url=eval_url,
                impersonate=impersonate
            )
            return JSONResponse(content=result)
        else:
            # Otherwise, extract all options from the movie detail page
            details = await CloudflareScraper.get_movie_details(
                movie_url=target_url,
                impersonate=impersonate
            )
            return JSONResponse(content=details)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Download extraction failed: {str(exc)}")


@app.get("/api/resolve")
@app.get("/api/scrape/resolve")
async def api_resolve_link(
    url: str = Query(..., description="Intermediate URL to resolve to final 10Gbps/CDN direct download link"),
    impersonate: str = Query("chrome124", description="Browser TLS profile"),
):
    try:
        resolved_data = await CloudflareScraper.extract_final_download_links(
            link_url=url, 
            impersonate=impersonate
        )
        return JSONResponse(content=resolved_data)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Link resolution failed: {str(exc)}")


@app.post("/api/sources/test")
@app.get("/api/sources/test")
async def api_test_source(
    url: Optional[str] = Query(None),
    baseUrl: Optional[str] = Query(None),
    base_url: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    source_type: Optional[str] = Query(None),
    body: Optional[Dict[str, Any]] = Body(None),
    impersonate: str = Query("chrome124", description="Browser TLS profile"),
):
    target_url = url or baseUrl or base_url
    if not target_url and body:
        target_url = body.get("url") or body.get("baseUrl") or body.get("base_url")
    
    stype = type or source_type
    if not stype and body:
        stype = body.get("source_type") or body.get("type") or "generic"
    if not stype:
        stype = "generic"

    if not target_url:
        raise HTTPException(status_code=400, detail="Target URL is required for testing")

    result = await CloudflareScraper.test_source_connectivity(
        url=target_url,
        source_type=stype,
        impersonate=impersonate
    )
    return JSONResponse(content=result)


@app.get("/api/health")
async def health_check():
    return {
        "status": "ok", 
        "service": "cinegrab-multi-scraper", 
        "sources": ["HDHub4u", "Modlist (UHDMovies/MoviesMod)", "Vegamovies"], 
        "engine": "curl_cffi"
    }

import asyncio
import json
from app.scraper import CloudflareScraper

async def test():
    url = "https://new5.hdhub4u.cl/panchayat-season-4-hindi-webrip-all-episodes/"
    res = await CloudflareScraper.resolve_movie_direct_downloads(url)
    print("Name:", res.get("name"))
    print("Download keys:")
    for k, srvs in res.get("downloads", {}).items():
        print(f"\n[{k}] ({len(srvs)} servers):")
        for s in srvs:
            print(f"  - {s.get('server_name')} | {s.get('server_type')} | {s.get('file_size')} | {s.get('download_url')[:60]}...")

if __name__ == "__main__":
    asyncio.run(test())

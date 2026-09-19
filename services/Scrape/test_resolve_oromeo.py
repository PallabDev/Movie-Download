import asyncio
from curl_cffi.requests import AsyncSession
from bs4 import BeautifulSoup
import re

async def main():
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://hdhub4u.cl/'
    }
    gm_url = 'https://greenmotors.club/?id=eUI4RVJEbFkxOGpkL0JhdExwWkFZZlBqMnRzWkgreTZEckhxMHRSc0NoS3dyeXE1dGhmUDEwT3ZlOVlWVnQzOE5ZSEVTMDVGRktYTmZxa0VVMFpMY3dwaXJVRDRLdysvVzZtM2xFMThmOTA9'
    async with AsyncSession(impersonate='chrome120', verify=False) as session:
        r1 = await session.get(gm_url, headers=headers, timeout=20)
        print("GreenMotors status:", r1.status_code)
        m_target = re.search(r'const\s+TARGET_URL\s*=\s*["\']([^"\']+)["\']', r1.text)
        print("TARGET_URL:", m_target.group(1) if m_target else "None")
        m_href = re.search(r'href=["\']([^"\']*(?:hubcloud|hubdrive|hblinks|hubcdn)[^"\']*)["\']', r1.text, re.I)
        print("m_href:", m_href.group(1) if m_href else "None")
        
        hub_url = m_target.group(1) if m_target else (m_href.group(1) if m_href else None)
        if hub_url:
            print("\nHub URL:", hub_url)
            r2 = await session.get(hub_url, headers={**headers, 'Referer': gm_url}, timeout=20)
            print("Hub page status:", r2.status_code)
            soup2 = BeautifulSoup(r2.text, 'html.parser')
            print("Hub page title:", soup2.title.string if soup2.title else "None")
            
            print("\nAll <a> tags on Hub page:")
            for a in soup2.find_all('a'):
                h = a.get('href', '')
                t = a.get_text(' ', strip=True)
                print(f"  - text='{t}' href='{h}'")
                
            gen_link = None
            for a in soup2.find_all('a'):
                h = a.get('href', '')
                if 'hubcloud.php' in h or 'token=' in h:
                    gen_link = h
                    break
            
            if gen_link:
                print(f"\nFound gen_link: {gen_link}")
                r3 = await session.get(gen_link, headers={**headers, 'Referer': hub_url}, timeout=20)
                print("Gen page status:", r3.status_code)
                soup3 = BeautifulSoup(r3.text, 'html.parser')
                print("All <a> tags on Gen page:")
                for a in soup3.find_all('a'):
                    h = a.get('href', '')
                    t = a.get_text(' ', strip=True)
                    print(f"  - text='{t}' href='{h}'")

asyncio.run(main())

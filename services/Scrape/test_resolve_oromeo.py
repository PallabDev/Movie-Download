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
        # 1. Base64 decode test
        import base64
        m_b64 = re.search(r"s\s*\(\s*['\"]o['\"]\s*,\s*['\"]([^'\"]+)['\"]", r1.text)
        if m_b64:
            val = m_b64.group(1)
            print("Raw base64 in script:", val[:60])
            cur = val
            for step in range(5):
                try:
                    decoded = base64.b64decode(cur).decode('utf-8')
                    print(f"Decoded step {step+1}:", decoded[:120])
                    cur = decoded
                except Exception as e:
                    break

            # 2. Homelander redirect test
        m_redir = re.search(r"window\.location\.href\s*=\s*['\"]([^'\"]+)['\"]", r1.text)
        if m_redir:
            redir_url = m_redir.group(1)
            print("\nRedirecting to:", redir_url)
            r_homelander = await session.get(redir_url, cookies={'xla': 's4t'}, headers={**headers, 'Referer': gm_url}, timeout=20)
            print("Homelander status:", r_homelander.status_code)
            soup_hl = BeautifulSoup(r_homelander.text, 'html.parser')
            print("Homelander title:", soup_hl.title.string if soup_hl.title else "None")
            print("Forms on Homelander:")
            for f in soup_hl.find_all('form'):
                print(" - Action:", f.get('action'), "Inputs:", [(i.get('name'), i.get('value')) for i in f.find_all('input')])
            print("Links on Homelander:")
            for a in soup_hl.find_all('a'):
                print(" - Link:", a.get('href'), "| Text:", a.get_text(strip=True))
            print("Scripts on Homelander:")
            for s in soup_hl.find_all('script'):
                if s.string and len(s.string.strip()) > 0:
                    print("Script:\n", s.string[:600])
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

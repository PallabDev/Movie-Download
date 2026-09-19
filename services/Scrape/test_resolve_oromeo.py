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
            print("--- ALL SCRIPTS ON HOMELANDER ---")
            for i, s in enumerate(soup_hl.find_all('script')):
                if s.string:
                    print(f"\n================ [Script {i}] ================\n{s.string}\n")

asyncio.run(main())

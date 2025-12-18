import os
import time
import datetime as dt
from typing import List, Dict
import requests
from bs4 import BeautifulSoup
from supabase import create_client, Client

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

# We use a formatted string for the URL to inject the page number dynamically
# page={page} will be replaced in the loop
KTC_BASE_URL = "https://keeptradecut.com/dynasty-rankings?page={page}&filters=QB|WR|RB|TE&format=2"
KTC_FORMAT = "superflex"

# How many pages to scrape? (0-9 covers top 1000 players, which is plenty)
MAX_PAGES = 10 

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    print("WARNING: Supabase credentials not found in env.")

supabase: Client = None
if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# -----------------------------------------------------------------------------
# Scraper
# -----------------------------------------------------------------------------

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}

def fetch_ktc_page(page_num: int) -> str:
    url = KTC_BASE_URL.format(page=page_num)
    print(f"[ktc] fetching page {page_num}: {url}")
    resp = requests.get(url, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    return resp.text

def parse_ktc_table(html: str) -> List[Dict]:
    soup = BeautifulSoup(html, "html.parser")
    results: List[Dict] = []
    today = dt.date.today()

    # 1. Find the main container
    container = soup.select_one("#rankings-page-rankings")
    if not container:
        print("[ktc] WARNING: Could not find #rankings-page-rankings container")
        return []

    # 2. Find direct children divs (The players) safely
    player_rows = container.find_all("div", recursive=False)

    for row in player_rows:
        # Check if this div is actually a player row (it should have a name)
        name_el = row.select_one(".player-name a")
        if not name_el:
            continue

        # --- Extract Data ---
        player_name = name_el.get_text(strip=True)
        
        # Team
        team_el = row.select_one(".player-team")
        nfl_team = team_el.get_text(strip=True) if team_el else "FA"

        # Position
        pos_el = row.select_one("p.position")
        position = pos_el.get_text(strip=True) if pos_el else "UNK"

        # Value
        value_el = row.select_one(".value p")
        if not value_el: 
            continue
        try:
            ktc_value = int(value_el.get_text(strip=True).replace(",", ""))
        except ValueError:
            continue

        # Rank
        rank_el = row.select_one(".rank-number p")
        try:
            ktc_rank = int(rank_el.get_text(strip=True)) if rank_el else 999
        except ValueError:
            ktc_rank = 999

        # ID Generation (Slug)
        href = name_el.get("href", "")
        slug = href.split("/")[-1] if href else f"{player_name}_{position}"
        ktc_player_id = slug.lower()

        results.append({
            "ktc_player_id": ktc_player_id,
            "player_name": player_name,
            "position": position,
            "nfl_team": nfl_team,
            "format": KTC_FORMAT,
            "ktc_rank": ktc_rank,
            "ktc_value": ktc_value,
            "as_of_date": today.isoformat(),
        })

    return results

# -----------------------------------------------------------------------------
# Supabase upsert
# -----------------------------------------------------------------------------

def upsert_ktc_values(rows: List[Dict]) -> None:
    if not rows:
        print("[ktc] no rows to upsert")
        return
    
    if not supabase:
        print("[ktc] Supabase client not initialized, skipping upsert.")
        return

    print(f"[ktc] upserting {len(rows)} rows to supabase...")

    # Batch upsert to handle larger datasets (500+ rows) smoothly
    batch_size = 200
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        try:
            supabase.table("ktc_values").upsert(
                batch, on_conflict="ktc_player_id,format,as_of_date"
            ).execute()
            print(f"   - batch {i} to {i+len(batch)} success")
        except Exception as e:
            print(f"[ktc] Error upserting batch {i}: {e}")

    print("[ktc] finished.")

def main():
    all_rows = []
    
    try:
        # Loop through pages
        for page in range(MAX_PAGES):
            html = fetch_ktc_page(page)
            page_rows = parse_ktc_table(html)
            
            if not page_rows:
                print(f"[ktc] Page {page} returned 0 rows. Stopping.")
                break
            
            print(f"[ktc] Page {page} parsed {len(page_rows)} rows.")
            all_rows.extend(page_rows)
            
            # Be polite to KTC server
            time.sleep(2)

        print(f"[ktc] Total rows collected: {len(all_rows)}")
        upsert_ktc_values(all_rows)

    except Exception as e:
        print(f"[ktc] CRITICAL ERROR: {e}")
        exit(1)

if __name__ == "__main__":
    main()
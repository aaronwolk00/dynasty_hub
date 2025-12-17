import os
import time
import datetime as dt
from typing import List, Dict, Optional

import requests
from bs4 import BeautifulSoup
from supabase import create_client, Client

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

# KTC rankings URL – point this at the exact page you want (1QB, SF, etc.)
KTC_RANKINGS_URL = "https://keeptradecut.com/dynasty-rankings"  # adjust if needed

# Label for the format you’re scraping (you’ll use this in your app)
KTC_FORMAT = "superflex"

SUPABASE_URL = "https://mugfsmqcrkfsehdyoruy.supabase.co",
SUPABASE_SERVICE_ROLE_KEY = "sb_publishable_z6H9o_SOKq4VngF2JD3Peg_5NmwjMfW",

# Supabase env (BACKEND ONLY – this script should never run in the browser)
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# -----------------------------------------------------------------------------
# Scraper
# -----------------------------------------------------------------------------

HEADERS = {
    "User-Agent": "DynastyPlayoffHub/1.0 (contact: youremail@example.com)",
    "Accept-Language": "en-US,en;q=0.9",
}


def fetch_ktc_html() -> str:
    """Fetch raw HTML from KTC rankings page."""
    print(f"[ktc] fetching {KTC_RANKINGS_URL}")
    resp = requests.get(KTC_RANKINGS_URL, headers=HEADERS, timeout=20)
    resp.raise_for_status()
    # Be polite – if you ever fan this out to multiple pages, keep a delay
    time.sleep(2.0)
    return resp.text


def _clean_int(text: Optional[str], default: int = 0) -> int:
    if not text:
        return default
    try:
        return int(text.replace(",", "").strip())
    except ValueError:
        return default


def parse_ktc_table(html: str) -> List[Dict]:
    """
    Parse the rankings list out of the KTC HTML.

    This version is intentionally defensive:
      - It supports both the current structure and likely small changes.
      - It logs and bails if we obviously got the wrong number of rows.
    """
    soup = BeautifulSoup(html, "html.parser")
    results: List[Dict] = []
    today = dt.date.today()

    # Main container (current site uses this ID)
    container = soup.select_one("#rankings-page-rankings")
    if not container:
        print("[ktc] WARNING: #rankings-page-rankings not found – using generic row selector")
        # Fallback: look for common player row class
        player_rows = soup.select("div.onePlayer, div.player-row")
    else:
        # Rows are usually direct children or have a specific row class under this container
        rows_direct = container.select("> div")
        rows_players = container.select(".onePlayer, .player-row")
        player_rows = rows_players or rows_direct

    print(f"[ktc] candidate rows: {len(player_rows)}")

    for row in player_rows:
        # 1. PLAYER LINK / NAME
        # Prefer a named class, but fall back to any player-detail link.
        name_el = row.select_one(".player-name a") or row.select_one(
            "a[href*='/dynasty-rankings/players/']"
        )
        if not name_el:
            continue

        player_name = name_el.get_text(strip=True)
        if not player_name:
            continue

        # 2. TEAM
        team_el = row.select_one(".player-team, .team")
        nfl_team = team_el.get_text(strip=True) if team_el else "FA"

        # 3. POSITION
        pos_el = row.select_one("p.position, .position")
        position_raw = pos_el.get_text(strip=True) if pos_el else "UNK"
        # Often looks like "WR1" – peel off letters
        position = "".join(ch for ch in position_raw if ch.isalpha()) or position_raw

        # 4. VALUE
        value_el = row.select_one(".value p, .player-value, [data-col='value']")
        ktc_value = _clean_int(value_el.get_text() if value_el else None, default=0)
        if ktc_value <= 0:
            # Treat 0 as "couldn't parse" – usually means markup mismatch
            continue

        # 5. RANK
        rank_el = row.select_one(".rank-number p, .rank, [data-col='rank']")
        ktc_rank = _clean_int(rank_el.get_text() if rank_el else None, default=999)

        # 6. STABLE ID (slug from URL)
        href = name_el.get("href", "") or ""
        # Expected pattern: /dynasty-rankings/players/justin-jefferson-1
        slug = href.rstrip("/").split("/")[-1] if "/" in href else None
        if not slug:
            slug = f"{player_name}_{position}".replace(" ", "-")

        ktc_player_id = slug.lower()

        results.append(
            {
                "ktc_player_id": ktc_player_id,
                "player_name": player_name,
                "position": position,
                "nfl_team": nfl_team,
                "format": KTC_FORMAT,
                "ktc_rank": ktc_rank,
                "ktc_value": ktc_value,
                "as_of_date": today.isoformat(),
            }
        )

    print(f"[ktc] parsed {len(results)} rows")

    # Basic sanity check: if we got suspiciously few rows, fail hard so
    # GitHub Actions will show a red run and you’ll notice.
    if len(results) < 50:
        raise RuntimeError(
            f"[ktc] parsed only {len(results)} players – page structure may have changed."
        )

    return results


# -----------------------------------------------------------------------------
# Supabase upsert
# -----------------------------------------------------------------------------

def upsert_ktc_values(rows: List[Dict]) -> None:
    if not rows:
        print("[ktc] no rows to upsert")
        return

    print(f"[ktc] upserting {len(rows)} rows to Supabase…")
    res = (
        supabase.table("ktc_values")
        .upsert(rows, on_conflict=["ktc_player_id", "format", "as_of_date"])
        .execute()
    )
    count = len(res.data or [])
    print(f"[ktc] upserted {count} rows")


def main() -> None:
    html = fetch_ktc_html()
    rows = parse_ktc_table(html)
    upsert_ktc_values(rows)


if __name__ == "__main__":
    main()

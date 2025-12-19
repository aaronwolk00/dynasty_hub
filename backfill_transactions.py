import time
import datetime # Added import
import requests
from supabase import create_client, Client

# ---------- CONFIG ----------

STARTING_LEAGUE_ID = "1180559121900638208" 
SUPABASE_URL = "https://mugfsmqcrkfsehdyoruy.supabase.co"
SUPABASE_SERVICE_KEY = "sb_publishable_z6H9o_SOKq4VngF2JD3Peg_5NmwjMfW" 

TRANSACTIONS_TABLE = "transactions" 
WEEKS_TO_FETCH = 18 

# ---------- SCRIPT LOGIC ----------

if "YOUR_SERVICE_ROLE_KEY" in SUPABASE_SERVICE_KEY:
    print("ERROR: You must paste your Supabase Service Role Key into the script.")
    exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

def get_league_details(league_id):
    url = f"https://api.sleeper.app/v1/league/{league_id}"
    resp = requests.get(url)
    if resp.status_code != 200:
        print(f"  [Error] Could not find league {league_id}")
        return None
    return resp.json()

def fetch_transactions(league_id, week):
    url = f"https://api.sleeper.app/v1/league/{league_id}/transactions/{week}"
    resp = requests.get(url)
    if resp.status_code != 200:
        return []
    return resp.json()

def upsert_batch(rows):
    if not rows: return
    try:
        supabase.table(TRANSACTIONS_TABLE).upsert(rows).execute()
    except Exception as e:
        print(f"    [DB Error] {e}")

def process_season(league_id):
    meta = get_league_details(league_id)
    if not meta: return None

    season_year = meta.get("season")
    prev_id = meta.get("previous_league_id")
    name = meta.get("name", "Unknown League")

    print(f"\nProcessing {season_year} Season...")
    print(f"  League: {name} (ID: {league_id})")

    total_season_tx = 0

    for week in range(1, WEEKS_TO_FETCH + 1):
        txs = fetch_transactions(league_id, week)
        
        if not txs:
            continue

        rows = []
        for t in txs:
            # Timestamp fallback
            raw_ts = t.get("status_updated") or t.get("created") or int(time.time() * 1000)
            
            # Fix: Convert ms integer to ISO string
            dt_obj = datetime.datetime.fromtimestamp(raw_ts / 1000.0)
            iso_ts = dt_obj.isoformat()

            rows.append({
                "league_id": league_id,
                "season": season_year,
                "week": week,
                "type": t.get("type", "unknown"),
                "executed_at": iso_ts, # Correct format for timestamp column
                "data": t
            })

        if rows:
            upsert_batch(rows)
            total_season_tx += len(rows)
            print(f"    Week {week}: Saved {len(rows)} transactions")
        
        time.sleep(0.2)

    print(f"  > Finished {season_year}: {total_season_tx} total transactions.")
    return prev_id

def main():
    print("=== STARTING FULL HISTORY BACKFILL ===")
    
    current_id = STARTING_LEAGUE_ID
    
    while current_id:
        prev_id = process_season(current_id)
        
        if prev_id and prev_id != "0":
            print(f"  Found previous season! Walking back to {prev_id}...")
            current_id = prev_id
        else:
            print("\nReached the beginning of the league (no previous ID found).")
            break

    print("\n=== HISTORY COMPLETE ===")

if __name__ == "__main__":
    main()
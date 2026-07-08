#!/usr/bin/env python3
"""Report how many matters were closed in each of the last N calendar years
using the Clio API v4.

Two independent counting methods are run and cross-checked:

  1. Server-side per-year (authoritative): one bounded query per year using
     ANDed close_date[] filters, counting via meta.records when present or by
     paging through the results.
  2. Single-pull bucket (validation): fetch every closed matter once, bucket
     locally by close_date year; null/missing close_date goes to "unknown".

Environment:
  CLIO_ACCESS_TOKEN                       bearer token (preferred)
  CLIO_CLIENT_ID / CLIO_CLIENT_SECRET /
  CLIO_REFRESH_TOKEN                      refresh-token flow fallback
  CLIO_API_BASE_URL                       regional API host override
                                          (default https://app.clio.com/api/v4)
  CLIO_BASE_URL                           regional app host for the OAuth token
                                          endpoint (default https://app.clio.com)

Usage:
  python3 scripts/closed_matters_by_year.py [--start-year YYYY] [--end-year YYYY]
"""

import argparse
import csv
import logging
import os
import sys
import time
from collections import Counter
from datetime import date

import requests

DEFAULT_API_BASE_URL = "https://app.clio.com/api/v4"
DEFAULT_APP_BASE_URL = "https://app.clio.com"
TOKEN_PATH = "/oauth/token"

MATTER_FIELDS = "id,display_number,close_date,status"
PAGE_LIMIT = 200
PAGE_DELAY_SECONDS = 0.3  # small courtesy delay between pages
MAX_RETRIES_429 = 8
CSV_FILENAME = "closed_matters_by_year.csv"

log = logging.getLogger("closed_matters_by_year")


class ClioApiError(RuntimeError):
    pass


def get_access_token(session: requests.Session) -> str:
    """Return a bearer token: CLIO_ACCESS_TOKEN if set, else refresh flow."""
    token = os.environ.get("CLIO_ACCESS_TOKEN", "").strip()
    if token:
        return token

    client_id = os.environ.get("CLIO_CLIENT_ID", "").strip()
    client_secret = os.environ.get("CLIO_CLIENT_SECRET", "").strip()
    refresh_token = os.environ.get("CLIO_REFRESH_TOKEN", "").strip()
    if not (client_id and client_secret and refresh_token):
        raise ClioApiError(
            "No credentials: set CLIO_ACCESS_TOKEN, or all of CLIO_CLIENT_ID, "
            "CLIO_CLIENT_SECRET and CLIO_REFRESH_TOKEN."
        )

    token_url = os.environ.get("CLIO_BASE_URL", DEFAULT_APP_BASE_URL).rstrip("/") + TOKEN_PATH
    log.info("No CLIO_ACCESS_TOKEN set; exchanging refresh token at %s", token_url)
    resp = session.post(
        token_url,
        data={
            "grant_type": "refresh_token",
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
        },
        timeout=30,
    )
    if resp.status_code != 200:
        raise ClioApiError(
            f"Token refresh failed: HTTP {resp.status_code}: {resp.text[:500]}"
        )
    access_token = resp.json().get("access_token")
    if not access_token:
        raise ClioApiError("Token refresh response contained no access_token.")
    return access_token


def api_get(session: requests.Session, url: str, params=None) -> dict:
    """GET with 429 backoff honoring Retry-After; raises on other non-200s."""
    for attempt in range(MAX_RETRIES_429 + 1):
        resp = session.get(url, params=params, timeout=60)
        if resp.status_code == 429:
            retry_after = resp.headers.get("Retry-After")
            try:
                wait = max(float(retry_after), 1.0) if retry_after else 2.0 ** attempt
            except ValueError:
                wait = 2.0 ** attempt
            log.warning("HTTP 429 rate-limited; waiting %.1fs (attempt %d/%d)",
                        wait, attempt + 1, MAX_RETRIES_429)
            time.sleep(wait)
            continue
        if resp.status_code != 200:
            raise ClioApiError(
                f"GET {resp.url} failed: HTTP {resp.status_code}: {resp.text[:500]}"
            )
        try:
            return resp.json()
        except ValueError as exc:
            raise ClioApiError(f"GET {resp.url} returned non-JSON body") from exc
    raise ClioApiError(f"GET {url} still rate-limited after {MAX_RETRIES_429} retries.")


def iter_matters(session: requests.Session, base_url: str, extra_params=None):
    """Yield closed-matter records, following meta.paging.next until absent."""
    url = base_url.rstrip("/") + "/matters.json"
    params = {
        "status": "closed",
        "fields": MATTER_FIELDS,
        "limit": PAGE_LIMIT,
        "order": "close_date(asc)",
    }
    if extra_params:
        params.update(extra_params)

    page = 0
    while True:
        payload = api_get(session, url, params=params)
        page += 1
        for record in payload.get("data", []):
            yield record
        next_url = (payload.get("meta") or {}).get("paging", {}).get("next")
        if not next_url:
            break
        # meta.paging.next is a fully-qualified cursor URL; use it verbatim.
        url, params = next_url, None
        time.sleep(PAGE_DELAY_SECONDS)


def count_for_range(session: requests.Session, base_url: str,
                    start: date, end: date) -> int:
    """Authoritative count for a close_date range via ANDed close_date[] filters.

    Uses meta.records from the first page when the API returns it; otherwise
    pages through and counts.
    """
    url = base_url.rstrip("/") + "/matters.json"
    params = {
        "status": "closed",
        "fields": MATTER_FIELDS,
        "limit": PAGE_LIMIT,
        "order": "close_date(asc)",
        # Multiple close_date[] values are ANDed by the API (documented).
        "close_date[]": [f">={start.isoformat()}", f"<={end.isoformat()}"],
    }
    payload = api_get(session, url, params=params)
    meta = payload.get("meta") or {}
    if isinstance(meta.get("records"), int):
        return meta["records"]

    # No total in meta — fall back to paging through and counting.
    count = len(payload.get("data", []))
    next_url = meta.get("paging", {}).get("next")
    while next_url:
        time.sleep(PAGE_DELAY_SECONDS)
        payload = api_get(session, next_url)
        count += len(payload.get("data", []))
        next_url = (payload.get("meta") or {}).get("paging", {}).get("next")
    return count


def bucket_all_closed(session: requests.Session, base_url: str):
    """Single full pull of closed matters, bucketed by close_date year.

    Returns (Counter[int year] -> count, unknown_count, total_fetched).
    """
    by_year = Counter()
    unknown = 0
    total = 0
    for record in iter_matters(session, base_url):
        total += 1
        close_date = record.get("close_date")
        year = None
        if close_date:
            try:
                year = int(str(close_date)[:4])
            except ValueError:
                pass
        if year is None:
            unknown += 1
        else:
            by_year[year] += 1
        if total % 1000 == 0:
            log.info("Fetched %d closed matters so far...", total)
    return by_year, unknown, total


def parse_args(argv=None) -> argparse.Namespace:
    current_year = date.today().year
    parser = argparse.ArgumentParser(
        description="Count Clio matters closed per calendar year (Clio API v4)."
    )
    parser.add_argument("--start-year", type=int, default=current_year - 9,
                        help="first calendar year to report (default: current year - 9)")
    parser.add_argument("--end-year", type=int, default=current_year,
                        help="last calendar year to report (default: current year)")
    args = parser.parse_args(argv)
    if args.start_year > args.end_year:
        parser.error("--start-year must be <= --end-year")
    return args


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = parse_args(argv)
    years = list(range(args.start_year, args.end_year + 1))

    base_url = os.environ.get("CLIO_API_BASE_URL", DEFAULT_API_BASE_URL).rstrip("/")
    log.info("Using Clio API base URL: %s", base_url)

    session = requests.Session()
    try:
        token = get_access_token(session)
    except ClioApiError as exc:
        log.error("%s", exc)
        return 1
    session.headers.update({
        "Authorization": f"Bearer {token}",
        "X-API-VERSION": "4.0.10",
        "Accept": "application/json",
    })

    try:
        # Method 1: authoritative server-side per-year counts.
        server_counts = {}
        for year in years:
            n = count_for_range(session, base_url, date(year, 1, 1), date(year, 12, 31))
            server_counts[year] = n
            log.info("Server-side count for %d: %d", year, n)
            time.sleep(PAGE_DELAY_SECONDS)

        # Method 2: single full pull, bucketed locally.
        log.info("Starting single-pull validation fetch of all closed matters...")
        bucket_counts, unknown, total_fetched = bucket_all_closed(session, base_url)
        log.info("Total closed-matter records fetched in single pull: %d", total_fetched)
    except (ClioApiError, requests.RequestException) as exc:
        log.error("%s", exc)
        return 1

    # Cross-check the two methods (unknowns excluded — they have no year).
    mismatches = {
        y: (server_counts[y], bucket_counts.get(y, 0))
        for y in years
        if server_counts[y] != bucket_counts.get(y, 0)
    }
    if mismatches:
        for year, (server_n, bucket_n) in sorted(mismatches.items()):
            log.warning(
                "Count mismatch for %d: server-side=%d, single-pull bucket=%d",
                year, server_n, bucket_n,
            )
    else:
        log.info("Cross-check passed: both methods agree for all %d years.", len(years))

    # stdout table (authoritative server-side numbers).
    print()
    print(f"{'Year':<6} | {'Matters Closed':>14}")
    print(f"{'-' * 6}-+-{'-' * 14}")
    for year in years:
        print(f"{year:<6} | {server_counts[year]:>14}")

    total_closed = sum(server_counts.values())
    print()
    print(f"Total closed {years[0]}-{years[-1]}: {total_closed}")
    print(f"Annual average: {total_closed / len(years):.1f}")
    print(f"Matters with unknown/missing close_date (all-time, excluded above): {unknown}")

    with open(CSV_FILENAME, "w", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["Year", "Matters Closed"])
        for year in years:
            writer.writerow([year, server_counts[year]])
    log.info("Wrote %s", CSV_FILENAME)

    return 0


if __name__ == "__main__":
    sys.exit(main())

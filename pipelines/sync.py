"""Loads the synced copy the command center reads from.

    uv run python -m sync appfolio zoho      # live
    uv run python -m sync zoho --seed        # from data/seed, for local setup

Each source is loaded with dlt into the `raw` schema, then folded into the
tables the app reads. Zoho stays the system of record; this is a copy.
"""

from __future__ import annotations

import os
import re
import sys
from typing import Any

import dlt
import httpx
import psycopg2

from sources import appfolio_listings, zoho_source

DATABASE_URL = os.environ.get("DATABASE_URL", "postgres://localhost/email_agent")

LISTING_COLUMNS: dict[str, Any] = {
    name: {"data_type": kind, "nullable": True}
    for name, kind in {
        "city": "text", "zip": "text", "rent": "bigint", "rent_text": "text", "beds": "double", "baths": "double",
        "sqft": "bigint", "available": "text", "title": "text", "description": "text", "pets": "text",
        "photo_url": "text", "tour_url": "text", "flags": "text",
    }.items()
}

ZOHO_COLUMNS: dict[str, dict[str, Any]] = {
    "zoho_campaigns": {
        n: {"data_type": k, "nullable": True}
        for n, k in {"type": "text", "created_at": "timestamp", "updated_at": "timestamp", "sent": "bigint", "opens": "bigint",
                     "clicks": "bigint", "send_date": "text", "series": "text", "email_number": "bigint", "theme": "text"}.items()
    },
    "zoho_reports": {
        n: {"data_type": "bigint", "nullable": True}
        for n in ["sent", "opens", "opens_reliable", "opens_mpp", "opens_bot", "clicks", "clicks_bot", "hard_bounced", "soft_bounced", "optout", "spam"]
    },
    "zoho_campaign_details": {
        n: {"data_type": "text", "nullable": True}
        for n in ["subject", "preheader", "sender_email", "sender_name", "list_ids", "list_names", "topic_id", "topic_name"]
    },
    "zoho_lists": {n: {"data_type": "bigint", "nullable": True} for n in ["active", "bounced", "unsubscribed"]},
}


def parse_campaign_name(name: str) -> dict[str, Any]:
    """ "2026-11-06 Fall 2026 Email 9 Available Homes" -> date, series, number, theme."""
    name = name.strip()
    dated = re.match(r"^(\d{4}-\d{2}-\d{2})\s+(.*)$", name)
    rest = dated.group(2) if dated else name
    numbered = re.match(r"^(.*?)\s*[-–]?\s*Email\s+(\d+)\s*[-–:]?\s*(.*)$", rest, re.I)
    if numbered:
        return {
            "send_date": dated.group(1) if dated else None,
            "series": numbered.group(1).strip() or None,
            "email_number": int(numbered.group(2)),
            "theme": numbered.group(3).strip() or None,
        }
    return {"send_date": dated.group(1) if dated else None, "series": None, "email_number": None, "theme": rest if dated else None}


def dlt_url() -> str:
    """dlt insists on a username and password; a local trust-auth address has neither."""
    from urllib.parse import urlsplit, urlunsplit
    import getpass

    parts = urlsplit(DATABASE_URL.replace("postgres://", "postgresql://", 1))
    if parts.username and parts.password:
        return urlunsplit(parts)
    user = parts.username or getpass.getuser()
    host = parts.hostname or "localhost"
    port = f":{parts.port}" if parts.port else ""
    return urlunsplit(parts._replace(netloc=f"{user}:{parts.password or 'unused'}@{host}{port}"))


def pipeline() -> dlt.Pipeline:
    return dlt.pipeline(
        pipeline_name="email_agent",
        destination=dlt.destinations.postgres(dlt_url()),
        dataset_name="raw",
    )


def connect():
    return psycopg2.connect(DATABASE_URL)


FOLD_LISTINGS = """
insert into listings (id, url, address, city, rent, rent_text, beds, baths, sqft, available, title, description,
                      pets, photo_url, tour_url, flags, active, synced_at)
select id, url, address, city, rent, rent_text, beds, baths, sqft, available, title, description,
       pets, photo_url, tour_url, coalesce(flags, '[]')::jsonb, true, now()
from raw.appfolio_listings
on conflict (id) do update set
  url = excluded.url, address = excluded.address, city = excluded.city, rent = excluded.rent,
  rent_text = excluded.rent_text, beds = excluded.beds, baths = excluded.baths, sqft = excluded.sqft,
  available = excluded.available, title = excluded.title, description = excluded.description,
  pets = excluded.pets, photo_url = excluded.photo_url, tour_url = excluded.tour_url,
  flags = excluded.flags, active = true, synced_at = now();
update listings set active = false where active and id not in (select id from raw.appfolio_listings);
"""

FOLD_CAMPAIGNS = """
insert into zoho_campaigns (id, name, status, type, created_at, updated_at, send_date, series, email_number, theme, synced_at)
select id, name, status, type, created_at, updated_at, send_date::date, series, email_number, theme, now()
from raw.zoho_campaigns
on conflict (id) do update set
  name = excluded.name, status = excluded.status, type = excluded.type, created_at = excluded.created_at,
  updated_at = excluded.updated_at, send_date = excluded.send_date, series = excluded.series,
  email_number = excluded.email_number, theme = excluded.theme, synced_at = now();

-- Every campaign gets the summary from the list; a detailed report, when present, replaces it below.
insert into zoho_reports (campaign_id, sent, opens, clicks, detailed, synced_at)
select id, coalesce(sent, 0), coalesce(opens, 0), coalesce(clicks, 0), false, now()
from raw.zoho_campaigns where status = 'sent'
on conflict (campaign_id) do update set
  sent = excluded.sent, opens = excluded.opens, clicks = excluded.clicks, synced_at = now()
  where not zoho_reports.detailed;
"""

FOLD_REPORTS = """
insert into zoho_reports (campaign_id, sent, opens, opens_reliable, opens_mpp, opens_bot, clicks, clicks_bot,
                          hard_bounced, soft_bounced, optout, spam, detailed, synced_at)
select r.campaign_id, coalesce(r.sent, 0), coalesce(r.opens, 0), r.opens_reliable, r.opens_mpp, r.opens_bot,
       coalesce(r.clicks, 0), r.clicks_bot, coalesce(r.hard_bounced, 0), coalesce(r.soft_bounced, 0),
       coalesce(r.optout, 0), coalesce(r.spam, 0), true, now()
from raw.zoho_reports r join zoho_campaigns c on c.id = r.campaign_id
on conflict (campaign_id) do update set
  sent = excluded.sent, opens = excluded.opens, opens_reliable = excluded.opens_reliable, opens_mpp = excluded.opens_mpp,
  opens_bot = excluded.opens_bot, clicks = excluded.clicks, clicks_bot = excluded.clicks_bot,
  hard_bounced = excluded.hard_bounced, soft_bounced = excluded.soft_bounced, optout = excluded.optout,
  spam = excluded.spam, detailed = true, synced_at = now();
"""

FOLD_LINKS = """
delete from zoho_links where campaign_id in (select distinct campaign_id from raw.zoho_links);
insert into zoho_links (campaign_id, link_id, url, unique_clicks)
select l.campaign_id, l.link_id, l.url, coalesce(l.unique_clicks, 0)
from raw.zoho_links l join zoho_campaigns c on c.id = l.campaign_id
on conflict do nothing;
"""

FOLD_DETAILS = """
update zoho_campaigns c set
  subject = d.subject, preheader = d.preheader, sender_email = d.sender_email, sender_name = d.sender_name,
  list_ids = coalesce(d.list_ids, '[]')::jsonb, list_names = coalesce(d.list_names, '[]')::jsonb,
  topic_id = d.topic_id, topic_name = d.topic_name
from raw.zoho_campaign_details d where d.id = c.id;
"""

FOLD_LISTS = """
insert into zoho_lists (id, name, active, bounced, unsubscribed, synced_at)
select id, name, active, bounced, unsubscribed, now() from raw.zoho_lists
on conflict (id) do update set name = excluded.name, active = excluded.active, bounced = excluded.bounced,
  unsubscribed = excluded.unsubscribed, synced_at = now();
"""


def fold(statements: str) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(statements)


def sync_appfolio() -> int:
    pipeline().run(appfolio_listings.apply_hints(columns=LISTING_COLUMNS))
    fold(FOLD_LISTINGS)
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select count(*) from listings where active")
        return cur.fetchone()[0]


def sync_zoho(seed: bool) -> int:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select campaign_id from zoho_reports where detailed")
        detailed = {row[0] for row in cur.fetchall()}
        cur.execute("select id from zoho_campaigns where subject is not null")
        with_subject = {row[0] for row in cur.fetchall()}

    resources = zoho_source(seed, detailed, with_subject)
    names = set()
    for resource in resources:
        if resource.name == "zoho_campaigns":
            resource.add_map(lambda row: {**row, **parse_campaign_name(row["name"])})
        resource.apply_hints(columns=ZOHO_COLUMNS.get(resource.name, {}))
        names.add(resource.name)
    pipeline().run(resources)

    fold(FOLD_CAMPAIGNS)
    if "zoho_reports" in names:
        fold(FOLD_REPORTS)
    if "zoho_links" in names:
        fold(FOLD_LINKS)
    if "zoho_campaign_details" in names:
        fold(FOLD_DETAILS)
    if "zoho_lists" in names:
        fold(FOLD_LISTS)
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select count(*) from zoho_campaigns")
        return cur.fetchone()[0]


def record(source: str, status: str, detail: str | None, rows: int | None) -> None:
    """Tells the switchboard how the run went, or writes the row directly when it is not running."""
    try:
        httpx.post(
            f"{os.environ.get('SWITCHBOARD_URL', 'http://127.0.0.1:8787')}/agent/sync/record",
            json={"source": source, "status": status, "detail": detail, "rows": rows},
            headers={"Authorization": f"Bearer {os.environ.get('AGENT_TOKEN', '')}"},
            timeout=10,
        ).raise_for_status()
    except Exception:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "insert into sync_runs (source, status, detail, rows, finished_at) values (%s, %s, %s, %s, now())",
                (source, status, detail, rows),
            )


def main(argv: list[str]) -> int:
    seed = "--seed" in argv
    sources = [a for a in argv if not a.startswith("--")] or ["appfolio", "zoho"]
    failed = False
    for source in sources:
        name = "zoho_campaigns" if source == "zoho" else source
        try:
            rows = sync_appfolio() if source == "appfolio" else sync_zoho(seed)
            record(name, "ok", "Loaded from seed files." if seed and source == "zoho" else None, rows)
            print(f"{source}: ok, {rows} rows")
        except Exception as error:  # noqa: BLE001 - report every failure, then carry on with the next source
            failed = True
            record(name, "failed", str(error)[:500], None)
            print(f"{source}: failed: {error}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

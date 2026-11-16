"""dlt sources: the public AppFolio listings page and Zoho Campaigns.

Zoho is read through the switchboard (which holds the sign-in), or from seed
files in data/seed when run with --seed. Nothing here writes to Zoho.
"""

from __future__ import annotations

import html as html_lib
import json
import os
import re
from pathlib import Path
from typing import Any, Iterator

import dlt
import httpx
from selectolax.lexbor import LexborHTMLParser as HTMLParser

LISTINGS_URL = os.environ.get("LISTINGS_URL", "")
USER_AGENT = "Mozilla/5.0 (compatible; listings-sync/1.0)"
SEED_DIR = Path(__file__).resolve().parent.parent / "data" / "seed"

# --- AppFolio ---------------------------------------------------------------------


def _money(text: str | None) -> int | None:
    match = re.search(r"\$\s*([\d,]+)", text or "")
    return int(match.group(1).replace(",", "")) if match else None


def _clean(text: str | None) -> str | None:
    if text is None:
        return None
    text = re.sub(r"\s+", " ", html_lib.unescape(text)).strip()
    return text or None


def parse_listings(page: str, base: str = LISTINGS_URL) -> list[dict[str, Any]]:
    """Turns the listings page into one record per home."""
    origin = re.match(r"https?://[^/]+", base).group(0)  # type: ignore[union-attr]
    out: list[dict[str, Any]] = []
    for item in HTMLParser(page).css("div.js-listing-item"):
        link = item.css_first("h2.js-listing-title a") or item.css_first("a[href*='/listings/detail/']")
        if link is None:
            continue
        href = link.attributes.get("href") or ""
        match = re.search(r"/listings/detail/([0-9a-f-]{36})", href)
        if not match:
            continue
        listing_id = match.group(1)

        facts: dict[str, str] = {}
        for box in item.css("div.detail-box__item"):
            label = _clean(box.css_first("dt").text() if box.css_first("dt") else None)
            value = _clean(box.css_first("dd").text() if box.css_first("dd") else None)
            if label and value:
                facts[label.lower()] = value

        address = _clean(item.css_first(".js-listing-address").text() if item.css_first(".js-listing-address") else None)
        title = _clean(link.text())
        description_node = item.css_first(".js-listing-description")
        description = _clean(description_node.text() if description_node else None)

        tour = None
        if description_node is not None:
            for a in description_node.css("a"):
                target = a.attributes.get("href") or ""
                if "matterport" in target or "tour" in target.lower():
                    tour = target
                    break
        if description:
            description = _clean(re.sub(r"^Virtual Tour:\s*\S+\s*", "", description))

        image = item.css_first("img.js-listing-image")
        photo = (image.attributes.get("data-original") if image else None) or None
        if photo and "place_holder" in photo:
            photo = None
        if photo:
            photo = re.sub(r"/medium\.(png|jpe?g)$", r"/large.\1", photo)

        bed_bath = facts.get("bed / bath", "")
        beds_match = re.search(r"([\d.]+)\s*bd", bed_bath)
        baths_match = re.search(r"([\d.]+)\s*ba", bed_bath)
        beds = float(beds_match.group(1)) if beds_match else (0.0 if "studio" in bed_bath.lower() else None)
        sqft_match = re.search(r"([\d,]+)", facts.get("square feet", ""))

        rent_text = facts.get("rent")
        rent = _money(rent_text)
        city_match = re.search(r",\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})?", address or "")

        amenities = None
        for p in item.css("p"):
            text = _clean(p.text())
            if text and text.startswith("Amenities:"):
                amenities = text
        pets = None
        pet_match = re.search(r"(no pets[^.]*|pets? (?:allowed|welcome|friendly|considered|ok)[^.]*|cats?[^.]*allowed[^.]*|dogs?[^.]*allowed[^.]*)", (description or "") + " " + (amenities or ""), re.I)
        if pet_match:
            pets = pet_match.group(1).strip()[:120]

        # Things on the page that disagree with each other, for a person to check.
        flags: list[str] = []
        if rent is not None:
            others = {int(m.replace(",", "")) for m in re.findall(r"\$\s*([\d,]{3,6})(?!\d)", f"{title or ''} {description or ''}")}
            others = {o for o in others if 400 <= o <= 10000 and o != rent}
            if others:
                flags.append(f"Card says {rent_text} but the description mentions ${sorted(others)[0]:,}.")
        if photo is None:
            flags.append("No photo on the listings page.")

        out.append(
            {
                "id": listing_id,
                "url": f"{origin}/listings/detail/{listing_id}",
                "address": address or title or "Address not shown",
                "city": city_match.group(1).strip() if city_match else None,
                "zip": city_match.group(3) if city_match else None,
                "rent": rent,
                "rent_text": rent_text,
                "beds": beds,
                "baths": float(baths_match.group(1)) if baths_match else None,
                "sqft": int(sqft_match.group(1).replace(",", "")) if sqft_match else None,
                "available": facts.get("available"),
                "title": title,
                "description": description,
                "pets": pets,
                "photo_url": photo,
                "tour_url": tour,
                "flags": json.dumps(flags),
            }
        )
    return out


@dlt.resource(name="appfolio_listings", write_disposition="replace", primary_key="id")
def appfolio_listings() -> Iterator[list[dict[str, Any]]]:
    if not LISTINGS_URL:
        raise RuntimeError("Set your public AppFolio listings URL in Settings before syncing listings.")
    response = httpx.get(LISTINGS_URL, headers={"User-Agent": USER_AGENT}, follow_redirects=True, timeout=60)
    response.raise_for_status()
    listings = parse_listings(response.text)
    if not listings:
        raise RuntimeError("The listings page loaded but no listings were found. Its layout may have changed.")
    yield listings


# --- Zoho Campaigns -----------------------------------------------------------------


class Zoho:
    """Reads Zoho through the switchboard, or from seed files."""

    def __init__(self, seed: bool):
        self.seed = seed
        self.base = os.environ.get("SWITCHBOARD_URL", "http://127.0.0.1:8787")
        self.token = os.environ.get("AGENT_TOKEN", "")

    def call(self, tool: str, args: dict[str, Any]) -> Any:
        response = httpx.post(
            f"{self.base}/agent/zoho/call",
            json={"server": "zoho_campaigns", "tool": tool, "args": args},
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=150,
        )
        body = response.json()
        if response.status_code != 200 or "error" in body:
            raise RuntimeError(f"{tool}: {body.get('error', response.status_code)}")
        return body["data"]

    def campaigns(self) -> Iterator[dict[str, Any]]:
        if self.seed:
            for path in sorted((SEED_DIR / "campaign_pages").glob("*.json")):
                data = json.loads(path.read_text())
                yield from (data.get("data", data) if isinstance(data, dict) else data)
            return
        after: str | None = None
        while True:
            page = self.call(
                "ZohoCampaigns_listCampaigns",
                {"query_params": {"limit": 200, "sort_by": "created_on", "sort_order": "desc", **({"after": after} if after else {})}},
            )
            yield from page.get("data", [])
            pagination = (page.get("meta") or {}).get("pagination") or {}
            if not pagination.get("has_more") or not pagination.get("next_cursor"):
                return
            after = pagination["next_cursor"]

    def report(self, campaign_id: str) -> dict[str, Any]:
        data = self.call(
            "ZohoCampaigns_getEmailCampaignFullReport",
            {"path_variables": {"campaign_id": campaign_id}, "query_params": {"fields": "summary,engagement,links"}},
        )["data"]
        summary, engagement = data.get("summary", {}), data.get("engagement", {})
        opens, clicks = engagement.get("opens", {}), engagement.get("clicks", {})
        return {
            "campaign_id": campaign_id,
            "sent": summary.get("sent", 0),
            "opens": opens.get("unique", summary.get("opens", 0)),
            "opens_reliable": opens.get("reliable"),
            "opens_mpp": opens.get("mpp"),
            "opens_bot": opens.get("bot"),
            "clicks": clicks.get("unique", summary.get("clicks", 0)),
            "clicks_bot": clicks.get("bot"),
            "hard_bounced": summary.get("hard_bounced", 0),
            "soft_bounced": summary.get("soft_bounced", 0),
            "optout": summary.get("optout") or 0,
            "spam": summary.get("spam") or 0,
            "links": [
                {"link_id": str(l["link_id"]), "url": l["url"], "unique_clicks": l.get("unique_clicks", 0)}
                for l in data.get("links", [])
            ],
        }

    def detail(self, campaign_id: str) -> dict[str, Any]:
        data = self.call("ZohoCampaigns_getCampaign", {"path_variables": {"campaign_id": campaign_id}})["data"]
        lists = (data.get("recipient") or {}).get("list_info_array") or []
        return {
            "id": campaign_id,
            "subject": data.get("subject"),
            "preheader": data.get("preheader"),
            "sender_email": data.get("sender_email"),
            "sender_name": data.get("sender_name"),
            "list_ids": [str(l["list_id"]) for l in lists],
            "list_names": [l["list_name"] for l in lists],
            "topic_id": data.get("topic_id"),
            "topic_name": data.get("topic_name"),
        }


def _seed_json(name: str) -> list[dict[str, Any]]:
    path = SEED_DIR / name
    return json.loads(path.read_text()) if path.exists() else []


def zoho_source(seed: bool, known_detailed: set[str], known_with_subject: set[str], report_limit: int = 40, detail_limit: int = 60):
    """Campaign list in full; detailed reports and settings for recent sends and any not seen before."""
    zoho = Zoho(seed)
    campaigns = [
        {
            "id": str(c["id"]),
            "name": c["name"],
            "status": c["status"],
            "type": c.get("type"),
            "created_at": c.get("created_at"),
            "updated_at": c.get("updated_at"),
            "sent": (c.get("reports_summary") or {}).get("sent"),
            "opens": (c.get("reports_summary") or {}).get("opens"),
            "clicks": (c.get("reports_summary") or {}).get("clicks"),
        }
        for c in zoho.campaigns()
    ]
    sent = [c for c in campaigns if c["status"] == "sent" and (c["sent"] or 0) > 0]

    if seed:
        reports = _seed_json("reports.json")
        details = _seed_json("campaign_details.json")
    else:
        # Results keep moving for a while after a send, so the newest ten are always refreshed.
        wanted = [c["id"] for c in sent[:10]] + [c["id"] for c in sent[10:] if c["id"] not in known_detailed]
        reports = [zoho.report(cid) for cid in dict.fromkeys(wanted[:report_limit])]
        missing = [c["id"] for c in campaigns if c["id"] not in known_with_subject]
        details = [zoho.detail(cid) for cid in missing[:detail_limit]]

    links = [{"campaign_id": r["campaign_id"], **l} for r in reports for l in r.get("links", [])]
    reports = [{k: v for k, v in r.items() if k != "links"} for r in reports]
    for d in details:
        d["list_ids"] = json.dumps(d.get("list_ids") or [])
        d["list_names"] = json.dumps(d.get("list_names") or [])

    def resource(name: str, rows: list[dict[str, Any]], key: Any):
        return dlt.resource(rows, name=name, write_disposition="replace", primary_key=key)

    out = [resource("zoho_campaigns", campaigns, "id")]
    if reports:
        out.append(resource("zoho_reports", reports, "campaign_id"))
    if links:
        out.append(resource("zoho_links", links, ["campaign_id", "link_id"]))
    if details:
        out.append(resource("zoho_campaign_details", details, "id"))

    lists = _seed_json("lists.json") if seed else _live_lists(zoho)
    if lists:
        out.append(resource("zoho_lists", [{**l, "id": str(l["id"])} for l in lists], "id"))
    return out


def _live_lists(zoho: Zoho) -> list[dict[str, Any]]:
    try:
        page = zoho.call("ZohoCampaigns_listMailingLists", {"query_params": {"limit": 100}})
    except RuntimeError:
        return []
    rows = []
    for l in page.get("data", []):
        counts = l.get("contact_counts") or l.get("counts") or l
        rows.append(
            {
                "id": str(l.get("id") or l.get("list_id")),
                "name": l.get("name") or l.get("list_name"),
                "active": counts.get("active") or counts.get("active_count"),
                "bounced": counts.get("bounced") or counts.get("bounce_count"),
                "unsubscribed": counts.get("unsubscribed") or counts.get("unsubscribe_count"),
            }
        )
    return rows

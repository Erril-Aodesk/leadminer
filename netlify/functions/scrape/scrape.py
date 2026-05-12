import json
import time
import random
import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
    "Connection": "keep-alive",
}

def scrape_page(keyword, location, page, fields):
    url = "https://www.yellowpages.com.au/search/listings"
    params = {"clue": keyword, "locationClue": location, "pageNumber": page}
    try:
        resp = requests.get(url, params=params, headers=HEADERS, timeout=20)
        resp.raise_for_status()
    except Exception as e:
        return [], str(e)

    soup = BeautifulSoup(resp.text, "lxml")
    cards = soup.select("div.listing-content, div[class*='listing-item'], div.search-result-content")
    if not cards:
        cards = soup.select("div[data-listing-id], div.natural")

    leads = []
    for card in cards:
        lead = {}

        if "name" in fields:
            el = card.select_one("a.listing-name, .listing-name, h3.listing-name, [class*='listing-name'], h2 a, h3 a")
            lead["Business Name"] = el.get_text(strip=True) if el else ""

        if "phone" in fields:
            el = card.select_one("a[href^='tel:'], .contact-phone, [class*='phone']")
            if el:
                ph = el.get("href", "") or el.get_text(strip=True)
                lead["Phone"] = ph.replace("tel:", "").strip()
            else:
                lead["Phone"] = ""

        if "website" in fields:
            el = card.select_one("a.website-link, a[href*='yellowpages.com.au/jump'], [class*='website']")
            lead["Website"] = el.get("href", "") if el else ""

        if "address" in fields:
            el = card.select_one(".listing-address, [class*='address'], .location")
            lead["Address"] = el.get_text(" ", strip=True) if el else ""

        if "suburb" in fields:
            el = card.select_one(".listing-address .locality, [class*='suburb'], [class*='locality']")
            lead["Suburb/State"] = el.get_text(strip=True) if el else ""

        if "category" in fields:
            el = card.select_one(".listing-categories a, [class*='categor'] a, .category")
            lead["Category"] = el.get_text(strip=True) if el else ""

        if "email" in fields:
            el = card.select_one('a[href^="mailto:"]')
            lead["Email"] = el.get("href", "").replace("mailto:", "").strip() if el else ""

        if "yp_url" in fields:
            el = card.select_one("a.listing-name, h3.listing-name a, h2 a")
            if el:
                href = el.get("href", "")
                lead["YP Listing URL"] = href if href.startswith("http") else "https://www.yellowpages.com.au" + href
            else:
                lead["YP Listing URL"] = ""

        if lead.get("Business Name"):
            leads.append(lead)

    return leads, None


def handler(event, context):
    cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json",
    }
    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 200, "headers": cors, "body": ""}

    try:
        body = json.loads(event.get("body", "{}"))
    except Exception:
        return {"statusCode": 400, "headers": cors, "body": json.dumps({"error": "Invalid JSON"})}

    keyword  = body.get("keyword", "").strip()
    location = body.get("location", "").strip()
    pages    = min(int(body.get("pages", 1)), 10)
    fields   = body.get("fields", ["name", "phone", "website", "address", "suburb"])

    if not keyword or not location:
        return {"statusCode": 400, "headers": cors, "body": json.dumps({"error": "keyword and location are required"})}

    all_leads, errors = [], []
    for page in range(1, pages + 1):
        leads, err = scrape_page(keyword, location, page, fields)
        if err:
            errors.append(f"Page {page}: {err}")
        all_leads.extend(leads)
        if page < pages:
            time.sleep(random.uniform(2, 4))

    return {
        "statusCode": 200,
        "headers": cors,
        "body": json.dumps({"leads": all_leads, "total": len(all_leads), "pages": pages, "errors": errors}),
    }

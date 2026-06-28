from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from curl_cffi import requests as curl_requests
import os, time

app = FastAPI(title="Vinted Search API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DOMAIN = os.getenv("VINTED_DOMAIN", "https://www.vinted.co.uk")
BASE_URL = f"{DOMAIN}/api/v2/catalog/items"

_session = None
_last_cookie_fetch = 0

def get_session():
    global _session, _last_cookie_fetch
    now = time.time()
    if _session is None or now - _last_cookie_fetch > 600:
        s = curl_requests.Session()
        s.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-GB,en;q=0.9",
        })
        r = s.get(DOMAIN, impersonate="chrome120")
        if r.status_code != 200:
            raise RuntimeError(f"Failed to fetch session cookie from {DOMAIN}, status: {r.status_code}")
        _session = s
        _last_cookie_fetch = now
    return _session

STATUS_MAP = {
    "new_with_tags": 1,
    "new_with_box": 2,
    "new_without_tags": 3,
    "very_good": 4,
    "good": 5,
    "satisfactory": 6,
}

@app.get("/api/search")
def search_items(
    query: str = Query("", description="Search term"),
    page: int = Query(1, ge=1),
    per_page: int = Query(48, ge=1, le=96),
    price_from: float = Query(None, ge=0),
    price_to: float = Query(None, ge=0),
    order: str = Query("newest_first", pattern="^(relevance|newest_first|price_low_to_high|price_high_to_low)$"),
    condition: str = Query(None, description="Comma-separated status keys: new_with_tags, very_good, etc."),
    min_likes: int = Query(None, ge=0),
    max_likes: int = Query(None, ge=0),
    catalog_ids: str = Query(None, description="Comma-separated category IDs"),
    brand_ids: str = Query(None, description="Comma-separated brand IDs"),
    size_ids: str = Query(None, description="Comma-separated size IDs"),
):
    params = {"search_text": query, "page": page, "per_page": per_page}

    if price_from is not None:
        params["price_from"] = price_from
    if price_to is not None:
        params["price_to"] = price_to
    if order:
        params["order"] = order

    if condition:
        ids = []
        for key in condition.split(","):
            key = key.strip().lower().replace(" ", "_")
            if key in STATUS_MAP:
                ids.append(str(STATUS_MAP[key]))
        if ids:
            params["status_ids"] = ",".join(ids)

    for param_name, val in [("catalog_ids", catalog_ids), ("brand_ids", brand_ids), ("size_ids", size_ids)]:
        if val:
            params[param_name] = val

    session = get_session()
    r = session.get(BASE_URL, params=params, impersonate="chrome120")
    if r.status_code != 200:
        return {"error": f"Vinted API returned status {r.status_code}", "items": [], "total": 0, "page": page, "per_page": per_page}

    data = r.json()
    raw_items = data.get("items", [])

    items = []
    for item in raw_items:
        fav_count = item.get("favourite_count") or 0
        if min_likes is not None and fav_count < min_likes:
            continue
        if max_likes is not None and fav_count > max_likes:
            continue

        price_info = item.get("price", {})
        photo_obj = item.get("photo") or {}
        user_obj = item.get("user") or {}

        items.append({
            "id": item.get("id"),
            "title": item.get("title"),
            "price": price_info.get("amount"),
            "currency": price_info.get("currency_code"),
            "url": item.get("url"),
            "image": photo_obj.get("url"),
            "condition": item.get("status"),
            "likes": fav_count,
            "views": item.get("view_count") or 0,
            "brand": item.get("brand_title"),
            "size": item.get("size_title"),
            "seller": {"username": user_obj.get("login")},
        })

    return {"items": items, "total": len(items), "page": page, "per_page": per_page}


@app.get("/api/conditions")
def get_conditions():
    return {
        "new_with_tags": "New with tags",
        "new_with_box": "New with box",
        "new_without_tags": "New without tags",
        "very_good": "Very good",
        "good": "Good",
        "satisfactory": "Satisfactory",
    }


@app.get("/")
def root():
    return {"status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)

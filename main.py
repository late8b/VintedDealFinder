from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from vinted_scraper import VintedScraper
import os

app = FastAPI(title="Vinted Search API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DOMAIN = os.getenv("VINTED_DOMAIN", "https://www.vinted.co.uk")
scraper = VintedScraper(DOMAIN)

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
        status_ids = []
        for key in condition.split(","):
            key = key.strip().lower().replace(" ", "_")
            if key in STATUS_MAP:
                status_ids.append(STATUS_MAP[key])
        if status_ids:
            params["status_ids"] = ",".join(str(s) for s in status_ids)

    if catalog_ids:
        params["catalog_ids"] = catalog_ids
    if brand_ids:
        params["brand_ids"] = brand_ids
    if size_ids:
        params["size_ids"] = size_ids

    raw_items = scraper.search(params)

    items = []
    for item in raw_items:
        fav_count = item.favourite_count or 0
        if min_likes is not None and fav_count < min_likes:
            continue
        if max_likes is not None and fav_count > max_likes:
            continue

        photo_url = None
        if isinstance(item.photo, dict):
            photo_url = item.photo.get("url")

        seller_info = {}
        if item.user:
            if hasattr(item.user, "login"):
                seller_info["username"] = item.user.login
            elif isinstance(item.user, dict):
                seller_info = item.user

        items.append({
            "id": item.id,
            "title": item.title,
            "price": item.price,
            "currency": item.currency,
            "url": item.url,
            "image": photo_url,
            "condition": item.status,
            "likes": fav_count,
            "views": item.view_count,
            "brand": item.brand_title,
            "size": item.size_title,
            "seller": seller_info,
            "created_at": None,
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

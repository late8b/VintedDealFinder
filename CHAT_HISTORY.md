# Chat History - Vinted Deal Finder

## Project: VintedDealFinder
**Repo:** https://github.com/late8b/VintedDealFinder  
**Deployed at:** https://vinteddealfinder.onrender.com

## What was done

### Session 1 (initial)
- Created Python FastAPI backend for Vinted search
- Created WordPress-embeddable frontend widget
- Deploy guide (DEPLOY.md)

### Session 2 (switch to Node.js)
- Python version had issues (Vinted blocking)
- Switched to Node.js/Express with curl-impersonate
- Created `VintedDealFinder/` project
- Set up for Render deployment with Procfile

### Session 3 (fix deployment)
- Fixed `build.sh` — removed `apt-get` (not available on Render)
- Added explicit root route to `server.js`
- Made build script non-fatal on curl-impersonate download failure
- Set up git permanently on this machine at `C:\Users\Windows\VintedDealFinder`
- Installed Git 2.54 via winget
- Cloned repo with credentials stored

### Session 4 (build still failing)
- Added `.gitattributes` to fix line endings
- Removed build script entirely (no build step needed)
- Uses Node.js native `fetch` as fallback when curl unavailable
- Fixed build by setting Render's Build Command to `npm install`

### Session 5 (search returning no results)
- Added cookie-based session management
- Session initialized by fetching Vinted homepage first
- Cookie jar maintained in memory
- Auto-retry on 403/503

### Session 6 (UI improvements)
- Added max price filter to search UI
- Fixed item URL doubling bug (Vinted returns full URLs)
- Merged Search and Best Deals tabs into single page
- Added category and size dropdowns (from Vinted API)
- Added deal mode checkbox (scans multiple pages)
- Added min/max likes, condition, price filters

### Session 7 (category/size API issues)
- Vinted's `/api/v2/catalog/filters` endpoint returns lazy-loaded filters
- Size options are loaded lazily (no easy API to get them)
- `/api/v2/catalog/sizes` endpoint doesn't exist (404)
- Removed category dropdown
- Size dropdown now populated from `size_title` values extracted from Vinted search results
- Size filter is server-side (filters results by `size_title` after fetching from Vinted)
- Removed "new with box" condition option

## Git repo
- **Location:** `C:\Users\Windows\VintedDealFinder`
- **Remote:** `https://github.com/late8b/VintedDealFinder.git`

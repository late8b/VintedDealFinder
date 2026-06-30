const express = require('express');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.VINTED_DOMAIN || 'https://www.vinted.co.uk';
const API_BASE = `${DOMAIN}/api/v2/catalog/items`;
const CURL_BIN = path.join(__dirname, 'bin', 'curl-impersonate-chrome');

let cookieJar = {};

app.use(express.static(path.join(__dirname, 'public')));

const STATUS_MAP = {
  new_with_tags: 1, new_without_tags: 3,
  very_good: 4, good: 5, satisfactory: 6,
};

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer': `${DOMAIN}/`,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'x-requested-with': 'XMLHttpRequest',
};

function parseCookies(resp) {
  const setCookie = resp.headers.get('set-cookie');
  if (!setCookie) return;
  setCookie.split(',').forEach(c => {
    const m = c.match(/^([^=]+)=([^;]+)/);
    if (m) cookieJar[m[1].trim()] = m[2].trim();
  });
}

function formatCookies() {
  return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function initSession() {
  try {
    const res = await fetch(DOMAIN, {
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    parseCookies(res);
  } catch {}
}

async function nodeFetch(url) {
  if (!cookieJar || Object.keys(cookieJar).length === 0) {
    await initSession();
  }
  try {
    const headers = { ...BROWSER_HEADERS, 'Cookie': formatCookies() };
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000), redirect: 'follow' });
    parseCookies(res);
    if (!res.ok) {
      if (res.status === 403 || res.status === 503) {
        await initSession();
        headers['Cookie'] = formatCookies();
        const retry = await fetch(url, { headers, signal: AbortSignal.timeout(20000), redirect: 'follow' });
        if (!retry.ok) return { error: `HTTP ${retry.status}` };
        parseCookies(retry);
        return await retry.json();
      }
      return { error: `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

function curlFetch(url) {
  let c = null;
  if (process.platform === 'linux' && fs.existsSync(CURL_BIN)) {
    c = { bin: CURL_BIN, flag: true };
  } else {
    const r = spawnSync('curl', ['--version'], { timeout: 5000, encoding: 'utf-8' });
    if (r.status === 0) c = { bin: 'curl', flag: false };
  }
  if (!c) return null;

  const args = ['-s', '-L', '--max-time', '20'];
  if (c.flag) args.push('--impersonate', 'chrome120');
  Object.entries(BROWSER_HEADERS).forEach(([k, v]) => args.push('-H', `${k}: ${v}`));
  if (formatCookies()) args.push('-H', `Cookie: ${formatCookies()}`);
  args.push(url);

  const r = spawnSync(c.bin, args, { timeout: 30000, encoding: 'utf-8' });
  if (r.error || r.status !== 0) return null;
  try {
    const data = JSON.parse(r.stdout || '{}');
    const setCookie = (r.stderr || '').match(/Set-Cookie:\s*([^=\s]+)=([^\s;]+)/);
    if (setCookie) cookieJar[setCookie[1]] = setCookie[2];
    return data;
  } catch { return null; }
}

async function vintedFetch(url) {
  if (Object.keys(cookieJar).length === 0) {
    await initSession();
  }
  let data = curlFetch(url);
  if (data) return data;
  data = await nodeFetch(url);
  return data || { error: 'Failed to fetch from Vinted' };
}

function buildUrl(qs) {
  const p = new URLSearchParams();
  Object.entries(qs).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  return `${API_BASE}?${p}`;
}

function formatItems(raw, minLikes, maxLikes, sizeFilter, priceFrom, priceTo) {
  return (raw || []).reduce((acc, item) => {
    const likes = item.favourite_count || 0;
    if (minLikes !== undefined && likes < minLikes) return acc;
    if (maxLikes !== undefined && likes > maxLikes) return acc;
    const price = item.price?.amount;
    if (priceFrom !== undefined && (price === undefined || price < priceFrom)) return acc;
    if (priceTo !== undefined && (price === undefined || price > priceTo)) return acc;
    if (sizeFilter) {
      const st = (item.size_title || '').toLowerCase().trim();
      const ss = sizeFilter.toLowerCase().trim();
      const tokens = st.split(/[\s\/\-]+/).filter(Boolean);
      if (!tokens.some(t => t === ss) && st !== ss) return acc;
    }
    acc.push({
      id: item.id, title: item.title,
      price: item.price?.amount, currency: item.price?.currency_code,
      url: item.url, image: item.photo?.url,
      condition: item.status, likes, views: item.view_count || 0,
      brand: item.brand_title, size: item.size_title,
      seller: { username: item.user?.login },
    });
    return acc;
  }, []);
}

app.get('/api/search', async (req, res) => {
  const query = req.query.query || '';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(parseInt(req.query.per_page) || 48, 96);
  const order = req.query.order || 'newest_first';
  const minLikes = req.query.min_likes !== undefined ? parseInt(req.query.min_likes) : undefined;
  const maxLikes = req.query.max_likes !== undefined ? parseInt(req.query.max_likes) : undefined;

  const params = { search_text: query, page, per_page: perPage, order };
  if (req.query.price_from) params.price_from = req.query.price_from;
  if (req.query.price_to) params.price_to = req.query.price_to;
  if (req.query.catalog_ids) params.catalog_ids = req.query.catalog_ids;
  if (req.query.brand_ids) params.brand_ids = req.query.brand_ids;
  if (req.query.condition) {
    const ids = req.query.condition.split(',').map(k => STATUS_MAP[k.trim().toLowerCase().replace(/\s+/g, '_')]).filter(Boolean);
    if (ids.length) params.status_ids = ids.join(',');
  }

  const priceFrom = req.query.price_from !== undefined ? parseFloat(req.query.price_from) : undefined;
  const priceTo = req.query.price_to !== undefined ? parseFloat(req.query.price_to) : undefined;

  const data = await vintedFetch(buildUrl(params));
  if (data.error) return res.json({ error: data.error, items: [], total: 0, page, per_page: perPage });

  const items = formatItems(data.items, minLikes, maxLikes, req.query.size, priceFrom, priceTo);
  res.json({ items, total: items.length, page, per_page: perPage });
});

app.get('/api/deals', async (req, res) => {
  const query = req.query.query || '';
  const maxLikes = parseInt(req.query.max_likes) || 3;
  const pages = Math.min(parseInt(req.query.pages) || 5, 20);
  const perPage = 96;
  const strict = req.query.strict === 'true';

  const params = { search_text: query, page: 1, per_page: perPage, order: 'newest_first' };
  if (req.query.price_from) params.price_from = req.query.price_from;
  if (req.query.price_to) params.price_to = req.query.price_to;
  if (req.query.catalog_ids) params.catalog_ids = req.query.catalog_ids;
  if (req.query.brand_ids) params.brand_ids = req.query.brand_ids;
  if (req.query.condition) {
    const ids = req.query.condition.split(',').map(k => STATUS_MAP[k.trim().toLowerCase().replace(/\s+/g, '_')]).filter(Boolean);
    if (ids.length) params.status_ids = ids.join(',');
  }
  const allItems = [];
  for (let p = 1; p <= pages; p++) {
    params.page = p;
    const data = await vintedFetch(buildUrl(params));
    if (data.error) break;
    allItems.push(...(data.items || []));
  }

  let filtered = allItems.filter(item => (item.favourite_count || 0) <= maxLikes);

  const priceFrom = req.query.price_from !== undefined ? parseFloat(req.query.price_from) : undefined;
  const priceTo = req.query.price_to !== undefined ? parseFloat(req.query.price_to) : undefined;
  if (priceFrom !== undefined) filtered = filtered.filter(item => (item.price?.amount || 0) >= priceFrom);
  if (priceTo !== undefined) filtered = filtered.filter(item => (item.price?.amount || 0) <= priceTo);

  const sizeFilter = req.query.size;
  if (sizeFilter) {
    const ss = sizeFilter.toLowerCase().trim();
    filtered = filtered.filter(item => {
      const st = (item.size_title || '').toLowerCase().trim();
      const tokens = st.split(/[\s\/\-]+/).filter(Boolean);
      return tokens.some(t => t === ss) || st === ss;
    });
  }

  if (strict && query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = filtered.filter(item => {
      const title = (item.title || '').toLowerCase();
      return terms.every(t => title.includes(t));
    });
  }

  filtered.sort((a, b) => (a.id || 0) - (b.id || 0));

  const items = filtered.map(item => ({
    id: item.id, title: item.title,
    price: item.price?.amount, currency: item.price?.currency_code,
    url: item.url, image: item.photo?.url,
    condition: item.status, likes: item.favourite_count || 0,
    views: item.view_count || 0, brand: item.brand_title, size: item.size_title,
    seller: { username: item.user?.login },
  }));

  res.json({ items, total: items.length });
});

app.get('/api/sizes', async (req, res) => {
  const q = req.query.q || 'nike';
  const data = await vintedFetch(`${API_BASE}?search_text=${encodeURIComponent(q)}&per_page=96`);
  if (data.error) return res.json({ error: data.error, sizes: [] });
  const seen = {};
  const sizes = [];
  (data.items || []).forEach(item => {
    const t = item.size_title;
    if (t && !seen[t]) { seen[t] = true; sizes.push({ title: t }); }
  });
  sizes.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  res.json({ sizes });
});

app.get('/api/conditions', (req, res) => res.json(STATUS_MAP));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => console.log('Vinted Deal Finder running on port', PORT));
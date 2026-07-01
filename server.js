const express = require('express');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.VINTED_DOMAIN || 'https://www.vinted.co.uk';
const API_BASE = `${DOMAIN}/api/v2/catalog/items`;
const CURL_BIN = path.join(__dirname, 'bin', 'curl-impersonate-chrome');
const COUNTRY_DOMAINS = {
  uk: 'https://www.vinted.co.uk', fr: 'https://www.vinted.fr',
  de: 'https://www.vinted.de', es: 'https://www.vinted.es',
  it: 'https://www.vinted.it', nl: 'https://www.vinted.nl',
  us: 'https://www.vinted.com',
};

let cookieJars = {};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const STATUS_MAP = {
  new_with_tags: 1, new_without_tags: 3,
  very_good: 4, good: 5, satisfactory: 6,
};

function parseStatusIds(raw) {
  if (!raw) return '';
  return raw.split(',').map(k => STATUS_MAP[k.trim().toLowerCase().replace(/\s+/g, '_')]).filter(Boolean).join(',');
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'x-requested-with': 'XMLHttpRequest',
};

function domainKey(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'default'; }
}

function jar(k) {
  if (!cookieJars[k]) cookieJars[k] = {};
  return cookieJars[k];
}

function parseCookies(resp, dk) {
  const setCookie = resp.headers.get('set-cookie');
  if (!setCookie) return;
  const j = jar(dk);
  setCookie.split(',').forEach(c => {
    const m = c.match(/^([^=]+)=([^;]+)/);
    if (m) j[m[1].trim()] = m[2].trim();
  });
}

function formatCookies(dk) {
  const j = jar(dk);
  return Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function initSession(domain) {
  try {
    const res = await fetch(domain || DOMAIN, {
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const dk = domainKey(domain || DOMAIN);
    parseCookies(res, dk);
  } catch (e) {
    console.error('initSession failed for', domain, e.message);
  }
}

async function nodeFetch(url, dk) {
  if (!dk) dk = domainKey(url);
  const origin = url.startsWith('http') ? new URL(url).origin : DOMAIN;
  if (!cookieJars[dk] || Object.keys(cookieJars[dk]).length === 0) {
    await initSession(origin);
    dk = domainKey(origin);
  }
  try {
    const hdrs = { ...BROWSER_HEADERS, 'Referer': `${origin}/`, 'Cookie': formatCookies(dk) };
    const res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(20000), redirect: 'follow' });
    parseCookies(res, dk);
    if (!res.ok) {
      if (res.status === 403 || res.status === 503) {
        await initSession(origin);
        const dk2 = domainKey(origin);
        hdrs['Cookie'] = formatCookies(dk2);
        const retry = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(20000), redirect: 'follow' });
        if (!retry.ok) return { error: `HTTP ${retry.status}` };
        parseCookies(retry, dk2);
        return await retry.json();
      }
      return { error: `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

function curlFetch(url, dk) {
  let c = null;
  if (process.platform === 'linux' && fs.existsSync(CURL_BIN)) {
    c = { bin: CURL_BIN, flag: true };
  } else {
    const r = spawnSync('curl', ['--version'], { timeout: 5000, encoding: 'utf-8' });
    if (r.status === 0) c = { bin: 'curl', flag: false };
  }
  if (!c) return null;
  if (!dk) dk = domainKey(url);
  const origin = url.startsWith('http') ? new URL(url).origin : DOMAIN;
  const args = ['-s', '-L', '--max-time', '20'];
  if (c.flag) args.push('--impersonate', 'chrome120');
  Object.entries(BROWSER_HEADERS).forEach(([k, v]) => args.push('-H', `${k}: ${v}`));
  args.push('-H', `Referer: ${origin}/`);
  if (formatCookies(dk)) args.push('-H', `Cookie: ${formatCookies(dk)}`);
  args.push(url);
  const r = spawnSync(c.bin, args, { timeout: 30000, encoding: 'utf-8' });
  if (r.error || r.status !== 0) return null;
  try {
    const data = JSON.parse(r.stdout || '{}');
    const setCookie = (r.stderr || '').match(/Set-Cookie:\s*([^=\s]+)=([^\s;]+)/);
    if (setCookie) jar(dk)[setCookie[1]] = setCookie[2];
    return data;
  } catch { return null; }
}

async function vintedFetch(url) {
  const dk = domainKey(url);
  const origin = url.startsWith('http') ? new URL(url).origin : DOMAIN;
  if (!cookieJars[dk] || Object.keys(cookieJars[dk]).length === 0) {
    await initSession(origin);
  }
  let data = curlFetch(url, dk);
  if (data) return data;
  data = await nodeFetch(url, dk);
  return data || { error: 'Failed to fetch from Vinted' };
}

function buildUrl(qs, domain) {
  const base = domain ? `${domain}/api/v2/catalog/items` : API_BASE;
  const p = new URLSearchParams();
  Object.entries(qs).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  return `${base}?${p}`;
}

function formatItems(raw, minLikes, maxLikes, sizeFilter, priceFrom, priceTo, exclude) {
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
    if (exclude) {
      const title = (item.title || '').toLowerCase();
      const words = exclude.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
      if (words.some(w => title.includes(w))) return acc;
    }
    acc.push({
      id: item.id, title: item.title,
      price: item.price?.amount, currency: item.price?.currency_code,
      url: item.url, image: item.photo?.url,
      condition: item.status, likes, views: item.view_count || 0,
      brand: item.brand_title, size: item.size_title,
      seller: { username: item.user?.login },
      ago: item.item_box?.second_line || null,
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
  const ids = parseStatusIds(req.query.condition);
  if (ids) params.status_ids = ids;

  const priceFrom = req.query.price_from !== undefined ? parseFloat(req.query.price_from) : undefined;
  const priceTo = req.query.price_to !== undefined ? parseFloat(req.query.price_to) : undefined;
  const exclude = req.query.exclude || '';
  const domain = COUNTRY_DOMAINS[req.query.country] || null;

  const data = await vintedFetch(buildUrl(params, domain));
  if (data.error) return res.json({ error: data.error, items: [], total: 0, page, per_page: perPage });

  const items = formatItems(data.items, minLikes, maxLikes, req.query.size, priceFrom, priceTo, exclude);
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
  const ids = parseStatusIds(req.query.condition);
  if (ids) params.status_ids = ids;
  const domain = COUNTRY_DOMAINS[req.query.country] || null;
  const allItems = [];
  for (let p = 1; p <= pages; p++) {
    params.page = p;
    const data = await vintedFetch(buildUrl(params, domain));
    if (data.error) break;
    allItems.push(...(data.items || []));
  }

  let filtered = allItems.filter(item => (item.favourite_count || 0) <= maxLikes);

  const priceFrom = req.query.price_from !== undefined ? parseFloat(req.query.price_from) : undefined;
  const priceTo = req.query.price_to !== undefined ? parseFloat(req.query.price_to) : undefined;
  if (priceFrom !== undefined) filtered = filtered.filter(item => (item.price?.amount || 0) >= priceFrom);
  if (priceTo !== undefined) filtered = filtered.filter(item => (item.price?.amount || 0) <= priceTo);

  const exclude = req.query.exclude || '';
  if (exclude) {
    const words = exclude.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    if (words.length) filtered = filtered.filter(item => !words.some(w => (item.title || '').toLowerCase().includes(w)));
  }

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
      const brand = (item.brand_title || '').toLowerCase();
      return terms.every(t => title.includes(t) || brand.includes(t));
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
    ago: item.item_box?.second_line || null,
  }));

  res.json({ items, total: items.length });
});

app.get('/api/sizes', async (req, res) => {
  const q = req.query.q || 'nike';
  const domain = COUNTRY_DOMAINS[req.query.country] || null;
  const data = await vintedFetch(buildUrl({ search_text: q, per_page: 96 }, domain));
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

app.post('/api/refresh-basket', async (req, res) => {
  const { item_ids, domains } = req.body;
  if (!Array.isArray(item_ids) || item_ids.length === 0) {
    return res.json({ items: [] });
  }
  const results = await Promise.allSettled(
    item_ids.map(async (id, i) => {
      const domain = domains && domains[i] ? (COUNTRY_DOMAINS[domains[i]] || DOMAIN) : DOMAIN;
      try {
        const url = `${domain}/api/v2/items/${id}`;
        const data = await vintedFetch(url);
        if (data && !data.error && data.price) {
          return { id: data.id, price: data.price.amount, currency: data.price.currency_code, title: data.title };
        }
      } catch {}
      return { id, error: 'unavailable' };
    })
  );
  const items = results.map(r => r.status === 'fulfilled' ? r.value : { error: 'fetch failed' });
  res.json({ items });
});

app.post('/api/saved-search-check', async (req, res) => {
  const { searches } = req.body;
  if (!Array.isArray(searches) || searches.length === 0) return res.json({ results: [] });
  const results = await Promise.allSettled(
    searches.map(async (s) => {
      const params = { search_text: s.query || '', page: 1, per_page: 96, order: 'newest_first' };
      if (s.price_from) params.price_from = s.price_from;
      if (s.price_to) params.price_to = s.price_to;
      if (s.condition) params.status_ids = s.condition;
      const domain = COUNTRY_DOMAINS[s.country] || null;
      const data = await vintedFetch(buildUrl(params, domain));
      const items = (data.items || []).filter(i => i.id > (s.last_id || 0));
      const latestId = items.length > 0 ? Math.max(...items.map(i => i.id)) : (s.last_id || 0);
      return {
        query: s.query, filters: s.filters || {},
        new_count: items.length, latest_id: latestId,
        price_from: s.price_from, price_to: s.price_to,
        condition: s.condition, country: s.country,
        items: items.slice(0, 10).map(i => ({
          id: i.id, title: i.title, price: i.price?.amount,
          currency: i.price?.currency_code, url: i.url, image: i.photo?.url,
          ago: i.item_box?.second_line || null,
        })),
      };
    })
  );
  const good = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  res.json({ results: good });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => console.log('Vinted Deal Finder running on port', PORT));
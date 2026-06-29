const express = require('express');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.VINTED_DOMAIN || 'https://www.vinted.co.uk';
const API_BASE = `${DOMAIN}/api/v2/catalog/items`;
const COOKIE_FILE = path.join(__dirname, '.vinted_cookies');
const CURL_BIN = path.join(__dirname, 'bin', 'curl-impersonate-chrome');

app.use(express.static(path.join(__dirname, 'public')));

const STATUS_MAP = {
  new_with_tags: 1, new_with_box: 2, new_without_tags: 3,
  very_good: 4, good: 5, satisfactory: 6,
};

function findCurl() {
  if (process.platform === 'linux' && fs.existsSync(CURL_BIN)) {
    return { bin: CURL_BIN, flag: true };
  }
  const r = spawnSync('curl', ['--version'], { timeout: 5000, encoding: 'utf-8' });
  if (r.status === 0) {
    return { bin: 'curl', flag: false };
  }
  return null;
}

function vintedFetch(url) {
  const c = findCurl();
  if (!c) return { error: 'No curl binary available' };

  const args = ['-s', '-L', '--max-time', '20'];
  if (c.flag) args.push('--impersonate', 'chrome120');
  args.push('-c', COOKIE_FILE, '-b', COOKIE_FILE);
  args.push(
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-H', 'Accept: application/json, text/plain, */*',
    '-H', 'Accept-Language: en-GB,en;q=0.9',
    '-H', `Referer: ${DOMAIN}/`,
    '-H', 'Sec-Fetch-Dest: empty',
    '-H', 'Sec-Fetch-Mode: cors',
    '-H', 'Sec-Fetch-Site: same-origin',
    '-H', 'x-requested-with: XMLHttpRequest',
  );
  args.push(url);

  const r = spawnSync(c.bin, args, { timeout: 30000, encoding: 'utf-8' });
  if (r.error) return { error: r.error.message };
  if (r.status !== 0) return { error: `curl status ${r.status}`, stderr: (r.stderr || '').slice(0, 300) };

  try { return JSON.parse(r.stdout || '{}'); }
  catch { return { error: 'Non-JSON response from Vinted', snippet: (r.stdout || '').slice(0, 300) }; }
}

function refreshCookies() {
  const c = findCurl();
  if (!c) return false;
  const args = ['-s', '-L', '--max-time', '15'];
  if (c.flag) args.push('--impersonate', 'chrome120');
  args.push('-c', COOKIE_FILE, '-b', COOKIE_FILE,
    '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: en-GB,en;q=0.9',
    DOMAIN);
  const r = spawnSync(c.bin, args, { timeout: 20000, encoding: 'utf-8' });
  return r.status === 0;
}

function buildUrl(qs) {
  const p = new URLSearchParams();
  Object.entries(qs).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  return `${API_BASE}?${p}`;
}

function formatItems(raw, minLikes, maxLikes) {
  return (raw || []).reduce((acc, item) => {
    const likes = item.favourite_count || 0;
    if (minLikes !== undefined && likes < minLikes) return acc;
    if (maxLikes !== undefined && likes > maxLikes) return acc;
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

function tryFetch(url) {
  let data = vintedFetch(url);
  if (data.error) { refreshCookies(); data = vintedFetch(url); }
  return data;
}

// ---- Routes ----

app.get('/api/search', (req, res) => {
  const query = req.query.query || '';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(parseInt(req.query.per_page) || 48, 96);
  const order = req.query.order || 'newest_first';
  const minLikes = req.query.min_likes !== undefined ? parseInt(req.query.min_likes) : undefined;
  const maxLikes = req.query.max_likes !== undefined ? parseInt(req.query.max_likes) : undefined;

  const params = { search_text: query, page, per_page: perPage, order };
  if (req.query.price_from) params.price_from = req.query.price_from;
  if (req.query.price_to) params.price_to = req.query.price_to;
  if (req.query.condition) {
    const ids = req.query.condition.split(',').map(k => STATUS_MAP[k.trim().toLowerCase().replace(/\s+/g, '_')]).filter(Boolean);
    if (ids.length) params.status_ids = ids.join(',');
  }

  const data = tryFetch(buildUrl(params));
  if (data.error) return res.json({ error: data.error, items: [], total: 0, page, per_page: perPage });

  const items = formatItems(data.items, minLikes, maxLikes);
  res.json({ items, total: items.length, page, per_page: perPage });
});

app.get('/api/deals', (req, res) => {
  const query = req.query.query || '';
  const maxLikes = parseInt(req.query.max_likes) || 3;
  const pages = Math.min(parseInt(req.query.pages) || 5, 20);
  const perPage = 96;

  const allItems = [];
  for (let p = 1; p <= pages; p++) {
    const data = tryFetch(buildUrl({ search_text: query, page: p, per_page: perPage, order: 'newest_first' }));
    if (data.error) break;
    allItems.push(...(data.items || []));
  }

  const filtered = allItems.filter(item => (item.favourite_count || 0) <= maxLikes);
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

app.get('/api/conditions', (req, res) => res.json(STATUS_MAP));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '0.0.0.0', () => console.log('Vinted Deal Finder running on port', PORT));

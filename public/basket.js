function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

const BASE_DOMAINS = { uk: 'https://www.vinted.co.uk', fr: 'https://www.vinted.fr', de: 'https://www.vinted.de', es: 'https://www.vinted.es', it: 'https://www.vinted.it', nl: 'https://www.vinted.nl', us: 'https://www.vinted.com' };

const BasketManager = {
  STORAGE_KEY: 'vintedDealBasket',

  get() {
    return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
  },

  save(basket) {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(basket));
    this.updateBadge();
    this.render();
  },

  add(item) {
    const basket = this.get();
    if (basket.find(i => i.id === item.id)) {
      this.toast('Already in basket');
      return;
    }
    basket.push({
      id: item.id,
      title: item.title,
      thumbnail_url: item.image,
      price: item.price,
      currency: item.currency,
      url: item.url.startsWith('http') ? item.url : (BASE_DOMAINS[item.country] || 'https://www.vinted.co.uk') + item.url,
      added_at: Date.now(),
      discount_percent: 20,
      last_price: item.price,
      price_dropped: false,
      country: item.country || 'uk',
    });
    this.save(basket);
    this.toast('Added to basket');
  },

  remove(id) {
    let basket = this.get();
    basket = basket.filter(i => i.id !== id);
    this.save(basket);
  },

  setDiscount(id, percent) {
    const basket = this.get();
    const item = basket.find(i => i.id === id);
    if (item) {
      item.discount_percent = Math.min(100, Math.max(0, parseInt(percent) || 0));
      this.save(basket);
    }
  },

  targetPrice(item) {
    return (item.last_price * (1 - (item.discount_percent || 20) / 100)).toFixed(2);
  },

  count() {
    return this.get().length;
  },

  updateBadge() {
    const badge = document.getElementById('basketBadge');
    if (!badge) return;
    const c = this.count();
    badge.textContent = c;
    badge.style.display = c > 0 ? 'flex' : 'none';
  },

  toggle() {
    const panel = document.getElementById('basketPanel');
    const overlay = document.getElementById('basketOverlay');
    if (!panel) return;
    const open = panel.classList.toggle('open');
    overlay.classList.toggle('show', open);
    if (open) this.render();
    document.body.style.overflow = open ? 'hidden' : '';
  },

  close() {
    const panel = document.getElementById('basketPanel');
    const overlay = document.getElementById('basketOverlay');
    if (panel) panel.classList.remove('open');
    if (overlay) overlay.classList.remove('show');
    document.body.style.overflow = '';
  },

  render() {
    const container = document.getElementById('basketItems');
    const countEl = document.getElementById('basketCountLabel');
    if (!container) return;
    const basket = this.get();
    if (countEl) countEl.textContent = basket.length + ' item' + (basket.length !== 1 ? 's' : '');

    if (basket.length === 0) {
      container.innerHTML = '<div class="basket-empty">Your basket is empty</div>';
      return;
    }

    container.innerHTML = basket.map(item => {
      const target = this.targetPrice(item);
      const curr = item.currency === 'GBP' ? '£' : '€';
      const dropped = item.price_dropped ? '<span class="badge badge-dropped">Price Dropped!</span>' : '';
      return `<div class="basket-item${item.price_dropped ? ' price-dropped' : ''}">
        <img class="basket-item-img" src="${item.thumbnail_url || ''}" alt="" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2264%22 height=%2264%22><rect fill=%22%23eee%22 width=%2264%22 height=%2264%22/><text x=%2232%22 y=%2232%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%23999%22 font-size=%2210%22>No img</text></svg>'">
        <div class="basket-item-body">
          <div class="basket-item-title">${this.esc(item.title)} ${dropped}</div>
          <div class="basket-item-price">${curr}${item.last_price}</div>
          <div class="basket-offer-row">
            <label class="basket-discount-label">Offer:
              <input type="range" min="0" max="70" value="${item.discount_percent || 20}" oninput="BasketManager.setDiscount(${item.id}, this.value)">
              <span class="basket-discount-val">${item.discount_percent || 20}%</span>
            </label>
          </div>
          <div class="basket-target-row">
            <span>Target: <strong>${curr}${target}</strong></span>
            <button class="btn-sm btn-copy" onclick="BasketManager.copyPrice(${item.id})">Copy</button>
            <button class="btn-sm btn-offer" onclick="BasketManager.makeOffer(${item.id})">Offer on Vinted</button>
            <button class="btn-sm btn-remove" onclick="BasketManager.remove(${item.id})">✕</button>
          </div>
        </div>
      </div>`;
    }).join('');
  },

  esc,

  copyPrice(id) {
    const item = this.get().find(i => i.id === id);
    if (!item) return;
    const target = this.targetPrice(item);
    navigator.clipboard.writeText(target).then(() => {
      this.toast('Copied ' + target + ' to clipboard!');
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = target;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.toast('Copied ' + target + ' to clipboard!');
    });
  },

  makeOffer(id) {
    const item = this.get().find(i => i.id === id);
    if (!item) return;
    const target = this.targetPrice(item);
    navigator.clipboard.writeText(target).then(() => {
      this.toast('Price ' + target + ' copied! Paste into Vinted.');
    }).catch(() => {});
    window.open(item.url, '_blank');
  },

  async refreshPrices() {
    const basket = this.get();
    if (basket.length === 0) return;
    const ids = basket.map(i => i.id);
    const domains = basket.map(i => i.country || 'uk');
    try {
      const res = await fetch('/api/refresh-basket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_ids: ids, domains }),
      });
      const data = await res.json();
      if (!data.items) return;
      let changed = false;
      const current = this.get();
      data.items.forEach(update => {
        if (!update || update.error) return;
        const item = current.find(i => i.id === update.id);
        if (item && update.price !== undefined && update.price !== item.last_price) {
          item.price_dropped = update.price < item.last_price;
          item.last_price = update.price;
          changed = true;
        }
      });
      if (changed) {
        this.save(current);
        this.toast('Basket prices updated!');
      }
    } catch (e) {
      // silently ignore refresh failures
    }
  },

  toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  },
};

document.addEventListener('DOMContentLoaded', () => {
  BasketManager.updateBadge();
  BasketManager.refreshPrices();
});

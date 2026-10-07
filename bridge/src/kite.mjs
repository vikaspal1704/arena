// Kite Connect, the small part Arena needs, with Node built-ins only.
//
// Endpoints, headers and the binary tick layout follow Zerodha's official
// client (github.com/zerodha/kiteconnectjs, MIT): dist/lib/connect.js and
// dist/lib/ticker.js. test/kite.test.mjs checks the tick parser against the
// official parser byte for byte.

import { createHash } from 'node:crypto';

export const LOGIN_URL = 'https://kite.zerodha.com/connect/login';
export const API_ROOT = 'https://api.kite.trade';
export const WS_ROOT = 'wss://ws.kite.trade/';
const KITE_VERSION = '3';

/** The login page. `state` comes back on the redirect and protects against login CSRF. */
export function loginUrl(apiKey, state) {
  const params = new URLSearchParams({ api_key: apiKey, v: KITE_VERSION, redirect_params: `state=${state}` });
  return `${LOGIN_URL}?${params}`;
}

/** sha256(api_key + request_token + api_secret), hex. The secret itself is never sent. */
export function checksum(apiKey, requestToken, apiSecret) {
  return createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex');
}

export class KiteError extends Error {
  constructor(message, { status, type } = {}) {
    super(message);
    this.name = 'KiteError';
    this.status = status;
    /** e.g. 'TokenException' when the session has expired. */
    this.type = type;
  }
}

export class KiteClient {
  constructor({ apiKey, accessToken = null, root = API_ROOT, fetchImpl = globalThis.fetch }) {
    if (!apiKey) throw new Error('apiKey is required');
    this.apiKey = apiKey;
    this.accessToken = accessToken;
    this.root = root;
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', query, form } = {}) {
    const url = new URL(path, this.root);
    for (const [k, v] of Object.entries(query ?? {})) for (const one of [v].flat()) url.searchParams.append(k, one);
    const headers = { 'X-Kite-Version': KITE_VERSION };
    if (this.accessToken) headers.Authorization = `token ${this.apiKey}:${this.accessToken}`;
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const res = await this.fetch(url, { method, headers, body, signal: AbortSignal.timeout(15_000) });
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/csv')) {
      if (!res.ok) throw new KiteError(`Kite ${path}: HTTP ${res.status}`, { status: res.status });
      return res.text();
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.status !== 'success') {
      throw new KiteError(json?.message ?? `Kite ${path}: HTTP ${res.status}`, { status: res.status, type: json?.error_type });
    }
    return json.data;
  }

  /** Exchanges the one-time request_token for the day's access token. */
  async createSession(requestToken, apiSecret) {
    const data = await this.request('/session/token', {
      method: 'POST',
      form: { api_key: this.apiKey, request_token: requestToken, checksum: checksum(this.apiKey, requestToken, apiSecret) },
    });
    this.accessToken = data.access_token;
    return data;
  }

  profile() {
    return this.request('/user/profile');
  }

  async instruments(exchange) {
    return parseInstrumentsCsv(await this.request(`/instruments/${exchange}`));
  }

  /** Last traded price for `EXCHANGE:SYMBOL` keys, in paise. */
  async ltpPaise(keys) {
    const data = await this.request('/quote/ltp', { query: { i: keys } });
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, rupeesToPaise(v.last_price)]));
  }

  /**
   * Candles for one instrument, oldest first, prices in paise.
   * `from` and `to` are 'YYYY-MM-DD HH:MM:SS' in India time; `interval` is e.g. '5minute'.
   */
  async historical(token, interval, from, to) {
    const data = await this.request(`/instruments/historical/${token}/${interval}`, { query: { from, to } });
    return data.candles.map(([ts, o, h, l, c]) => ({
      // Kite writes the offset as +0530; ISO 8601 parsing wants +05:30.
      at: Date.parse(String(ts).replace(/([+-]\d\d)(\d\d)$/, '$1:$2')),
      o: rupeesToPaise(o),
      h: rupeesToPaise(h),
      l: rupeesToPaise(l),
      c: rupeesToPaise(c),
    }));
  }

  // ---- Orders. Only the trading bot calls these, and only in live mode. ----

  /** Places a regular order; returns the order id. Prices are paise and sent as rupees. */
  async placeOrder({ exchange, symbol, side, qty, orderType, price, trigger, product, tag }) {
    const form = {
      exchange,
      tradingsymbol: symbol,
      transaction_type: side,
      quantity: String(qty),
      product,
      order_type: orderType,
      validity: 'DAY',
      price: paiseToRupees(price),
    };
    if (trigger !== undefined) form.trigger_price = paiseToRupees(trigger);
    if (tag) form.tag = tag;
    const data = await this.request('/orders/regular', { method: 'POST', form });
    return String(data.order_id);
  }

  async modifyOrder(orderId, { qty, orderType, price, trigger }) {
    const form = { quantity: String(qty), order_type: orderType, validity: 'DAY', price: paiseToRupees(price) };
    if (trigger !== undefined) form.trigger_price = paiseToRupees(trigger);
    await this.request(`/orders/regular/${encodeURIComponent(orderId)}`, { method: 'PUT', form });
  }

  async cancelOrder(orderId) {
    await this.request(`/orders/regular/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
  }

  /** The order's latest state: { status, filledQty, avgPrice (paise), message }. */
  async orderStatus(orderId) {
    const history = await this.request(`/orders/${encodeURIComponent(orderId)}`);
    const last = history.at(-1) ?? {};
    return {
      status: last.status ?? 'UNKNOWN',
      filledQty: Number(last.filled_quantity ?? 0),
      avgPrice: rupeesToPaise(last.average_price ?? 0),
      message: last.status_message ?? null,
    };
  }

  /** Net positions: [{ exchange, symbol, qty }]. */
  async positions() {
    const data = await this.request('/portfolio/positions');
    return (data.net ?? []).map((p) => ({ exchange: p.exchange, symbol: p.tradingsymbol, qty: Number(p.quantity) }));
  }

  /** Cash available for trading in the equity segment, in paise. */
  async availableCash() {
    const data = await this.request('/user/margins/equity');
    return rupeesToPaise(data.net);
  }
}

/** Kite prices are decimals in rupees; Arena uses integer paise. */
export function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

/** Integer paise to the 'rupees.paise' string Kite expects in order forms. */
export function paiseToRupees(paise) {
  if (!Number.isSafeInteger(paise) || paise < 0) throw new Error(`Bad price: ${paise}`);
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

/** RFC 4180 CSV (quoted fields may contain commas and quotes) to objects keyed by the header row. */
export function parseInstrumentsCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Today's date in India, 'YYYY-MM-DD' (contracts expire on Indian dates). */
export function istDate(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * The nearest-expiry future on `name` (e.g. NIFTY) that hasn't expired.
 * Returns a plain description in paise, or null if there is none.
 */
export function frontMonthFuture(rows, name, today) {
  const futures = rows
    .filter((r) => r.name === name && r.instrument_type === 'FUT' && r.segment === 'NFO-FUT' && r.expiry >= today)
    .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
  const f = futures[0];
  if (!f) return null;
  return {
    token: Number(f.instrument_token),
    exchange: f.exchange || 'NFO',
    symbol: f.tradingsymbol,
    name: f.name,
    expiry: f.expiry,
    tickPaise: rupeesToPaise(f.tick_size),
    lot: Number.parseInt(f.lot_size, 10),
  };
}

// ---- Binary ticks --------------------------------------------------------

const FULL_FNO_PACKET = 184;
const FULL_INDEX_PACKET = 32;
/** Segment (low byte of the instrument token) → divisor that turns wire integers into rupees. */
const DIVISOR = { 3: 10_000_000, 6: 10_000 }; // currency segments; everything else is 100

/**
 * Parses one binary frame from the Kite ticker into ticks with prices in
 * integer paise. Full-mode packets are returned: F&O contracts (184 bytes,
 * with 5-level depth) and indices (32 bytes, `index: true`, no depth).
 * Heartbeats and other packet types are skipped.
 * Frame: [u16 count] then per packet [u16 length][packet], big-endian.
 */
export function parseTicks(buffer) {
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  if (view.byteLength < 4) return [];
  const out = [];
  let offset = 2;
  const count = view.getUint16(0);
  for (let n = 0; n < count && offset + 2 <= view.byteLength; n++) {
    const size = view.getUint16(offset);
    const start = offset + 2;
    offset = start + size;
    if ((size !== FULL_FNO_PACKET && size !== FULL_INDEX_PACKET) || offset > view.byteLength) continue;
    const u32 = (at) => view.getUint32(start + at);
    const token = u32(0);
    const divisor = DIVISOR[token & 0xff] ?? 100;
    // Wire integers are rupees × divisor; with the usual divisor of 100 they already are paise.
    const paise = (raw) => (divisor === 100 ? raw : Math.round((raw * 100) / divisor));
    if (size === FULL_INDEX_PACKET) {
      const ts = u32(28);
      out.push({ token, index: true, ltp: paise(u32(4)), close: paise(u32(20)), ts: ts ? ts * 1000 : null });
      continue;
    }
    const level = (i) => ({ qty: u32(64 + i * 12), price: paise(u32(64 + i * 12 + 4)), orders: view.getUint16(start + 64 + i * 12 + 8) });
    const exchangeTs = u32(60);
    out.push({
      token,
      ltp: paise(u32(4)),
      lastQty: u32(8),
      volume: u32(16),
      close: paise(u32(40)),
      ts: exchangeTs ? exchangeTs * 1000 : null,
      bids: [0, 1, 2, 3, 4].map(level).filter((l) => l.qty > 0),
      asks: [5, 6, 7, 8, 9].map(level).filter((l) => l.qty > 0),
    });
  }
  return out;
}

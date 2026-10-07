# Real-market mode (local only)

Trade in Arena against the live NIFTY futures price. A small bridge on your own computer logs in to Kite Connect, streams the front-month NIFTY future (last price and the 5-level order book) and serves Arena at `http://127.0.0.1:8765`. The bots' hidden fair value follows the real price, so they quote around the real market. Your orders are simulated: they never reach the exchange.

The public site at vikaspal1704.github.io/arena never connects to Kite. This mode exists only on your machine.

## Setup (about five minutes)

1. **A Kite Connect app.** At [developers.kite.trade](https://developers.kite.trade/apps), open your app and set the redirect URL to:

   ```
   http://127.0.0.1:8765/kite/callback
   ```

   Live ticks need a plan that includes market data. If your app doesn't have it, the bridge shows Kite's error message.

2. **Credentials, on your machine only.**

   ```bash
   cd bridge
   cp .env.example .env      # .env is gitignored
   # edit .env: KITE_API_KEY=...  KITE_API_SECRET=...
   ```

   Or export `KITE_API_KEY` and `KITE_API_SECRET` in your shell instead.

3. **Build and run.**

   ```bash
   (cd web && npm ci && npm run build)   # needs Rust with the wasm32-unknown-unknown target
   cd bridge && npm ci && npm start
   ```

4. Open `http://127.0.0.1:8765/`, press **Log in with Kite**, and log in. You're sent back to Arena with live prices. The session lasts until Kite expires it early the next morning; after that, log in again.

No Kite account? `npm run mock` in `bridge/` streams synthetic prices with the same messages.

## How your credentials are handled

| What | Where it goes |
|------|---------------|
| API secret | Read from `bridge/.env` or the environment. Used once a day, inside the bridge, to make `sha256(key + request_token + secret)`. The secret itself is never sent anywhere, logged, or given to the browser. |
| Access token | Saved in `bridge/.kite-session.json` (gitignored, permissions 0600), so you don't log in on every restart. |
| Network | The bridge listens on `127.0.0.1` only. It talks to `api.kite.trade` and `ws.kite.trade`, and to nothing else. |
| Other websites | The bridge answers only requests addressed to `127.0.0.1` or `localhost` (DNS-rebinding guard), and accepts feed connections only from its own page (Origin check). |
| Login | A random one-time `state` travels through Kite's login and must come back unchanged, so another site can't log your bridge into a different account (login CSRF). |

The bridge talks to Kite with Node's built-ins only: its single runtime dependency is `ws`. The binary tick parser follows Zerodha's official client and is tested byte for byte against it (`bridge/test/kite.test.mjs`).

## Limits

- **Personal use.** Exchange data from Kite is for you. Don't record it and publish it, and don't host this mode for others.
- **Prices are real; the book and fills are simulated.** The NSE panel shows the real top 5 levels for reference. Arena's own book is made by bots around the real price, so queue position and fills are not what the exchange would give you.
- **Outside market hours** there are no ticks, and the bots trade around the last price.
- **Replays.** The journal still replays a real-market session exactly and verifies its fingerprint. The seed alone does not reproduce it, because the bots followed live prices.

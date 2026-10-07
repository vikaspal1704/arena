# Options bot (NIFTY and SENSEX)

`bot/` trades NIFTY and SENSEX index options through your own Kite Connect app. It paper trades on live prices by default. Real orders are locked until you have a paper record and have switched them on yourself.

> **Read this first.** No set of rules makes options buying profitable by default. SEBI's 2024 study found that about 9 in 10 individual F&O traders lost money over three years. These rules are designed to keep each loss small and to stop the bot on bad days. They do not promise profit. With ₹10,000 the bot risks up to ₹800 on a trade (8% of capital) and up to ₹1,200 a day (12%). Two bad days can take a fifth of the account. Only use money you can afford to lose, and keep paper trading until the record says otherwise.

## What it does, in one paragraph

Every 5 minutes it looks at the NIFTY and SENSEX index. After the first 15 minutes have set the day's opening range, a 5-minute close that breaks out of that range in the direction of the trend is a signal. The bot then buys one lot of a liquid call (on an upward break) or put (on a downward break) for next week's expiry. An SL-limit stop sits at the exchange from the moment the position exists. The bot raises that stop to breakeven, then trails it, and sells at twice the risk, when the breakout fails, after 30 minutes without progress, or at 15:15. Account limits decide whether it may trade at all.

## The rules

All of them are in `bot/src/config.mjs` with their defaults, and can be changed in `bot/config.json`. Every decision in the log lists each rule with pass or fail and the numbers behind it.

**Signal** (index, 5-minute closes, `strategy.mjs`)

| Rule | Default | Why |
|---|---|---|
| Opening range | 09:15 to 09:30 high and low | The first 15 minutes are noisy; the range they leave is a level the market reacts to. |
| Breakout | close beyond the range by 0.1 ATR | A close, not a touch: fewer false breaks. |
| Fresh | the previous candle had not broken out | Enter on the break, not an hour later. |
| Trend | EMA 20 above EMA 50 and close above EMA 20 (mirror for puts) | Trade only in the direction the market is already going. |
| Not chasing | close at most 1.5 ATR past the range | A far entry means a far stop. |
| Calm candle | candle range at most 2 ATR | Skip news spikes, which often reverse. |
| Moving | ATR at least 0.03% of price | Dead markets bleed option premium. |
| Once per direction | one call and one put trade a day at most | No revenge trades on the same idea. |

**Which option** (`chain.mjs`)

| Rule | Default |
|---|---|
| Expiry | nearest weekly expiry, but next week's on expiry day (no same-day expiry gamma) |
| Strike | at the money first, then up to 4 strikes out of the money, first one that passes |
| Liquidity | spread at most 1.5%, at least 2 lots offered at the best price, quote under 5 s old |
| Stop size | 15% to 30% of premium. Tighter than 15% is noise, so that strike is skipped. |
| Money | premium plus charges within capital; risk (stop × quantity + charges) within the risk budget |

**Why it often buys slightly out of the money.** One lot of an at-the-money NIFTY option (65 units at about ₹140) costs about ₹9,000, nearly the whole ₹10,000. A 15% stop on that is about ₹1,400, far above the ₹800 limit. A cheaper strike (about ₹60) allows a 19% stop inside ₹800. The log shows this reasoning for every strike it skips. More capital, or a higher `riskPerTrade`, lets it trade closer to the money.

**Exits** (`position.mjs`), measured in R, the money at risk per unit at entry

| Exit | Default |
|---|---|
| Stop | at entry minus R, as an SL-limit order at the exchange |
| Breakeven | at +1R the stop moves to entry plus charges |
| Trailing | from +1.5R the stop follows 1R below the best price |
| Target | sell at +2R |
| Failed breakout | the index closes back inside the opening range |
| Time stop | 30 minutes without reaching +0.5R |
| Square-off | 15:15 |

**Account limits** (`risk.mjs`)

| Limit | Default |
|---|---|
| Entry window | 09:30 to 14:30; 13:00 on a contract's expiry day |
| Risk per trade | ₹800, and never more than what is left of the daily cap |
| Daily loss cap | ₹1,200, then no more trades today |
| Trades a day | 2, one position at a time |
| Losing streak | 2 losses in a row stops the day |
| Cooldown | 15 minutes after a loss |
| Capital floor | below ₹7,000 of equity it stops trading altogether |
| Volatility | no entries when India VIX is above 22, or unknown |
| Event days | dates you list in `risk.eventDays` (budget, RBI policy, election results) |
| Kill switch | create the file `bot/STOP`: it closes any position and stops for the day |

The config refuses unsafe values, for example a risk per trade above 10% of capital or a daily cap above 20%.

## Run it

You need the bridge set up as in [REAL_MARKET.md](REAL_MARKET.md) (your Kite Connect app, `bridge/.env`). Each trading day:

```bash
cd bridge && npm start           # then open http://127.0.0.1:8765 and log in with Kite
cd bot && npm ci && npm run paper
```

Start it before 09:15. It prints one line per signal, order and stop move, and a status line every 5 minutes. It closes everything by 15:15 and stops at 15:31. Ctrl-C closes any position first.

```bash
npm run report        # paper record: win rate, average win and loss, per trade, drawdown
npm run demo          # two synthetic days, no Kite needed
npm run paper -- --record              # also save today's ticks (bot/recordings/, personal use only)
npm run replay -- recordings/2026-10-07.jsonl.gz   # rerun that day with changed rules
```

A replay feeds the recorded ticks through the same code with a simulated clock, so it shows exactly what the bot would have done. Use replays to check that a rule change does what you meant. Tuning rules until old days look good is curve fitting, and it does not carry over to new days.

## From paper to live

`npm run live` refuses to start until all of these are true (`report.mjs`, `liveGate`):

1. `"live": { "enabled": true }` in `bot/config.json`.
2. `"live": { "acknowledge": "I understand this places real orders and I can lose money" }` in the same file.
3. At least 20 paper trading days and 20 paper trades.
4. The paper record makes money after charges.
5. You start it from a terminal and type `LIVE` when asked.

It also checks that Kite shows at least your configured capital as available cash, and lists any positions you already hold. It uses MIS (intraday) and limit orders only: entries at the ask plus 2 ticks, cancelled if unfilled after 10 s. Exits cancel the exchange stop first and wait for it to settle, then sell at the bid, two ticks lower on each retry. Because the stop is cancelled first, the bot can never sell twice. If an exit still fails after 20 tries, or anything unexpected happens, the bot stops trading and tells you exactly what to close in Kite. If it restarts while holding a live position, it does not touch it: the exchange stop stays in place and you take over.

Before going live, check:

- **SEBI's retail algo rules.** Under SEBI's framework for retail algorithmic trading, brokers apply conditions to API orders, such as a registered static IP, order-rate limits and algo tagging. Check Zerodha's current requirements on [developers.kite.trade](https://developers.kite.trade). If live orders are rejected, start there.
- **Charges.** P&L in the logs is after brokerage, STT (0.15% of sell premium from April 2026), exchange, SEBI, stamp and GST, using F&O Wrapped's rate table. Your contract notes are the final word.
- **Start with the defaults**, one lot, and compare live fills with the paper record for a few weeks.

## What stays on your machine

Your API secret stays in `bridge/.env`, and the day's token in `bridge/.kite-session.json`, as for the bridge. The bot's settings (`bot/config.json`), state (`bot/state/`), logs (`bot/logs/`) and recordings (`bot/recordings/`) are gitignored. The bot talks only to `api.kite.trade` and `ws.kite.trade`. Recorded exchange data is for your own use: do not publish it.

## Tests

`npm test` in `bot/` runs 35 tests:

- the indicators, candles, config limits and charges, against hand calculations;
- every risk gate and every exit;
- option selection with its reasons;
- the paper broker against depth, including stops that gap through their limit;
- the live broker against a scripted Kite: cancel before sell, partial fills, repricing, rejected stops;
- the ticker against a local WebSocket server;
- the live gate;
- whole-day replays: trend days up and down, a failed breakout, the kill switch, event days, losing streaks and restarts.

CI runs them on every push, along with `npm run demo`.

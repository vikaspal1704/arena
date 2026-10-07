//! A small market that keeps the book alive: a hidden "fair value" that
//! drifts, and bots that trade around it. The player is owner 0.
//!
//! Bots are deterministic: all randomness comes from one seeded generator, and
//! their commands go through the sequencer like anyone else's. Replaying the
//! journal therefore needs no bot logic at all.

use std::collections::BTreeMap;

use crate::engine::EngineConfig;
use crate::exchange::Exchange;
use crate::types::{Command, Event, OrderId, Owner, Price, Qty, Side};

pub const PLAYER: Owner = 0;
pub const MARKET_MAKER: Owner = 1;
pub const MOMENTUM: Owner = 2;
/// Noise traders are owners NOISE_FIRST.. NOISE_FIRST + noise_traders - 1.
pub const NOISE_FIRST: Owner = 10;

/// xorshift64*: small, fast, and the same sequence on every platform.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// Uniform in 0..n (n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n
    }

    /// True with probability `per_mille` / 1000.
    pub fn chance(&mut self, per_mille: u64) -> bool {
        self.below(1000) < per_mille
    }
}

/// An event with the journal sequence number and time of the command that caused it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamped {
    pub seq: u64,
    pub ts_ms: u64,
    pub event: Event,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SimConfig {
    pub seed: u64,
    /// Price step (e.g. 5 paise).
    pub tick: Price,
    pub start_price: Price,
    /// Contract size: every bot order is a multiple of this.
    pub lot: Qty,
    pub noise_traders: u32,
    /// Market maker's half-spread, in ticks.
    pub mm_half_spread: i64,
    pub mm_lots: Qty,
}

impl Default for SimConfig {
    /// A NIFTY-futures-like instrument: ₹24,000.00, ₹0.05 tick, lot of 75.
    fn default() -> Self {
        SimConfig {
            seed: 42,
            tick: 5,
            start_price: 2_400_000,
            lot: 75,
            noise_traders: 4,
            mm_half_spread: 2,
            mm_lots: 4,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Sim {
    config: SimConfig,
    exchange: Exchange,
    rng: Rng,
    now_ms: u64,
    /// Hidden fair value, in ticks.
    fair_ticks: i64,
    /// Live bot orders: order id → owner.
    live: BTreeMap<OrderId, Owner>,
    /// Signed net position per bot, in units.
    positions: BTreeMap<Owner, i64>,
    mm_quoted_at: Option<i64>,
    last_trade: Option<Price>,
    /// Recent trade prices, for the momentum bot.
    recent: Vec<Price>,
    /// When set, fair value follows this external price (in ticks) instead
    /// of its random walk: "real-market mode". Bot commands still go through
    /// the journal, so replays need neither the bots nor the external feed.
    anchor: Option<i64>,
}

impl Sim {
    pub fn new(config: SimConfig) -> Self {
        let engine = EngineConfig {
            tick: config.tick,
            ..EngineConfig::default()
        };
        let mut sim = Sim {
            config,
            exchange: Exchange::new(engine),
            rng: Rng::new(config.seed),
            now_ms: 0,
            fair_ticks: config.start_price / config.tick,
            live: BTreeMap::new(),
            positions: BTreeMap::new(),
            mm_quoted_at: None,
            last_trade: None,
            recent: Vec::new(),
            anchor: None,
        };
        // Seed a few levels each side so the first screen isn't empty.
        for i in 1..=5i64 {
            let lots = 1 + sim.rng.below(4);
            let (b, a) = (sim.price_at(-i - 2), sim.price_at(i + 2));
            sim.send(
                NOISE_FIRST,
                Command::Limit {
                    owner: NOISE_FIRST,
                    side: Side::Buy,
                    price: b,
                    qty: lots * config.lot,
                },
            );
            sim.send(
                NOISE_FIRST + 1,
                Command::Limit {
                    owner: NOISE_FIRST + 1,
                    side: Side::Sell,
                    price: a,
                    qty: lots * config.lot,
                },
            );
        }
        sim.quote_market_maker();
        sim
    }

    pub fn config(&self) -> SimConfig {
        self.config
    }

    pub fn exchange(&self) -> &Exchange {
        &self.exchange
    }

    pub fn now_ms(&self) -> u64 {
        self.now_ms
    }

    /// Pins fair value to an external price (rounded to the tick), or
    /// releases it back to the random walk with `None`. Takes effect from the
    /// next step.
    pub fn anchor(&mut self, price: Option<Price>) {
        let tick = self.config.tick;
        self.anchor = price
            .filter(|p| *p > 0)
            .map(|p| ((p + tick / 2) / tick).max(1));
    }

    pub fn anchored(&self) -> bool {
        self.anchor.is_some()
    }

    pub fn fair_price(&self) -> Price {
        self.fair_ticks * self.config.tick
    }

    pub fn last_trade(&self) -> Option<Price> {
        self.last_trade
    }

    /// The player's command, sequenced at the current time. Returns its events.
    pub fn player(&mut self, cmd: Command) -> Vec<Stamped> {
        self.send(PLAYER, cmd)
    }

    /// Advances the clock by `dt_ms` and lets the market move. Returns every
    /// event produced, in sequence order.
    pub fn step(&mut self, dt_ms: u64) -> Vec<Stamped> {
        self.now_ms += dt_ms;
        let mut out = Vec::new();
        // Fair value: the external price when anchored, else a random walk
        // with rare jumps ("news"). The unanchored draws are unchanged, so
        // every seed still gives the same market as before.
        if let Some(a) = self.anchor {
            self.fair_ticks = a;
        } else {
            if self.rng.chance(350) {
                let step = 1 + self.rng.below(2) as i64;
                self.fair_ticks += if self.rng.chance(500) { step } else { -step };
            }
            if self.rng.chance(4) {
                let jump = 10 + self.rng.below(30) as i64;
                self.fair_ticks += if self.rng.chance(500) { jump } else { -jump };
            }
        }
        self.fair_ticks = self.fair_ticks.max(100);

        // Requote when fair value moves, when a side was taken out, and now and then.
        let one_sided = self.orders_of(MARKET_MAKER).len() < 2;
        if one_sided || self.mm_quoted_at != Some(self.fair_ticks) || self.rng.chance(50) {
            out.extend(self.quote_market_maker());
        }
        for i in 0..self.config.noise_traders {
            if self.rng.chance(120) {
                out.extend(self.noise(NOISE_FIRST + i));
            }
        }
        if self.rng.chance(60) {
            out.extend(self.momentum());
        }
        out
    }

    fn price_at(&self, ticks_from_fair: i64) -> Price {
        ((self.fair_ticks + ticks_from_fair).max(1)) * self.config.tick
    }

    fn send(&mut self, owner: Owner, cmd: Command) -> Vec<Stamped> {
        let events = self.exchange.submit(self.now_ms, cmd).to_vec();
        let (seq, ts_ms) = (self.exchange.seq(), self.now_ms);
        for e in &events {
            match *e {
                Event::Accepted {
                    order_id,
                    owner: o,
                    market: false,
                    ..
                } if o != PLAYER => {
                    self.live.insert(order_id, o);
                }
                Event::Done { order_id, .. } => {
                    self.live.remove(&order_id);
                }
                Event::Trade {
                    price,
                    qty,
                    maker_owner,
                    taker_owner,
                    aggressor,
                    ..
                } => {
                    let q = qty as i64;
                    let (taker_sign, maker_sign) = if aggressor == Side::Buy {
                        (1, -1)
                    } else {
                        (-1, 1)
                    };
                    *self.positions.entry(taker_owner).or_default() += taker_sign * q;
                    *self.positions.entry(maker_owner).or_default() += maker_sign * q;
                    self.last_trade = Some(price);
                    self.recent.push(price);
                    if self.recent.len() > 20 {
                        self.recent.remove(0);
                    }
                }
                _ => {}
            }
        }
        let _ = owner;
        events
            .into_iter()
            .map(|event| Stamped { seq, ts_ms, event })
            .collect()
    }

    fn orders_of(&self, owner: Owner) -> Vec<OrderId> {
        self.live
            .iter()
            .filter(|(_, o)| **o == owner)
            .map(|(id, _)| *id)
            .collect()
    }

    /// Two-sided quote around fair value, skewed against inventory.
    fn quote_market_maker(&mut self) -> Vec<Stamped> {
        let mut out = Vec::new();
        for id in self.orders_of(MARKET_MAKER) {
            out.extend(self.send(
                MARKET_MAKER,
                Command::Cancel {
                    owner: MARKET_MAKER,
                    order_id: id,
                },
            ));
        }
        let inventory_lots =
            self.positions.get(&MARKET_MAKER).copied().unwrap_or(0) / self.config.lot as i64;
        let skew = -(inventory_lots / 4).clamp(-3, 3);
        let h = self.config.mm_half_spread;
        let qty = self.config.mm_lots * self.config.lot;
        let (bid, ask) = (self.price_at(-h + skew), self.price_at(h + skew));
        out.extend(self.send(
            MARKET_MAKER,
            Command::Limit {
                owner: MARKET_MAKER,
                side: Side::Buy,
                price: bid,
                qty,
            },
        ));
        out.extend(self.send(
            MARKET_MAKER,
            Command::Limit {
                owner: MARKET_MAKER,
                side: Side::Sell,
                price: ask,
                qty,
            },
        ));
        self.mm_quoted_at = Some(self.fair_ticks);
        out
    }

    /// Random limit orders near fair value, the odd market order, and cancels.
    fn noise(&mut self, owner: Owner) -> Vec<Stamped> {
        let mine = self.orders_of(owner);
        if mine.len() > 3 || (!mine.is_empty() && self.rng.chance(250)) {
            return self.send(
                owner,
                Command::Cancel {
                    owner,
                    order_id: mine[0],
                },
            );
        }
        let side = if self.rng.chance(500) {
            Side::Buy
        } else {
            Side::Sell
        };
        let qty = (1 + self.rng.below(3)) * self.config.lot;
        if self.rng.chance(200) {
            return self.send(owner, Command::Market { owner, side, qty });
        }
        let away = self.rng.below(6) as i64 - 1; // mostly passive, sometimes crossing
        let price = match side {
            Side::Buy => self.price_at(-away),
            Side::Sell => self.price_at(away),
        };
        self.send(
            owner,
            Command::Limit {
                owner,
                side,
                price,
                qty,
            },
        )
    }

    /// Chases the recent trend with a market order, within a position cap.
    fn momentum(&mut self) -> Vec<Stamped> {
        if self.recent.len() < 10 {
            return Vec::new();
        }
        let first = self.recent[0];
        let last = *self.recent.last().expect("non-empty");
        let pos = self.positions.get(&MOMENTUM).copied().unwrap_or(0);
        let cap = 10 * self.config.lot as i64;
        let side = if last > first && pos < cap {
            Side::Buy
        } else if last < first && pos > -cap {
            Side::Sell
        } else {
            return Vec::new();
        };
        let qty = self.config.lot;
        self.send(
            MOMENTUM,
            Command::Market {
                owner: MOMENTUM,
                side,
                qty,
            },
        )
    }
}

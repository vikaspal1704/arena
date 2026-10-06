# Product requirements

**Product:** Arena · **Owner:** Vikas Pal · **Status:** phase 1 built

## 1. One-liner

A stock exchange in the browser: trade against bots on a real matching engine, then replay and verify every order.

## 2. Who it is for

| Who | What they get |
|-----|---------------|
| **Hiring teams at trading firms and fintechs** | In under a minute, a working exchange; in ten, evidence of matching, sequencing, determinism, market-data recovery, performance work and testing discipline |
| **Retail traders and students** | A safe place to feel the spread, the queue and Indian charges before risking money |
| **Engineers** | A small, readable reference for price-time matching, event-sourced exchanges and feed recovery |

## 3. Requirements

| ID | Requirement |
|----|-------------|
| R-1 | Price-time priority matching with limit, market (IOC) and cancel; trades at the resting price; book never crossed after a command |
| R-2 | Every command sequenced and journalled before it is applied; any prefix replayable to the same state |
| R-3 | A fingerprint after every command; the UI can rebuild any point and show whether it matches |
| R-4 | Matching results identical to the reference engine (mini-matching-engine) on random streams, checked in CI |
| R-5 | A living market without external data: seeded bots around a hidden fair value |
| R-6 | Market data as numbered deltas with gap detection and snapshot recovery, and a switch to drop packets on purpose |
| R-7 | The player's orders on a reliable channel, separate from market data |
| R-8 | Queue position for resting orders |
| R-9 | End-of-session Wrapped: net P&L after real Indian index-futures charges, win rate, edge against fair value, maker share, audit trail |
| R-10 | Runs entirely in the browser on static hosting; no third-party requests; works on a phone |
| R-11 | Published benchmark numbers, reproducible with one command, and runnable in the browser |
| R-12 | WCAG 2.1 AA (axe) on every screen |

## 4. Non-goals (phase 1)

Real market data, real money, accounts, multiple instruments, multiplayer, advice.

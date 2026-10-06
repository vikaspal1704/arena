//! # arena-engine
//!
//! A deterministic, single-instrument exchange core:
//!
//! * [`engine::Engine`]: price-time priority matching (limit, market/IOC, cancel)
//!   with integer prices and lazy cancels;
//! * [`exchange::Exchange`]: the sequencer, which journals every command and
//!   fingerprints the state after each one, so any prefix can be replayed
//!   and verified;
//! * [`sim::Sim`]: a seeded market of bots around a drifting fair value.
//!
//! No dependencies, no floats, no clocks, no randomness outside the seeded
//! generator: the same inputs give the same bytes on every platform,
//! including WebAssembly.

pub mod book;
pub mod engine;
pub mod exchange;
pub mod hash;
pub mod sim;
pub mod types;

pub use engine::{Engine, EngineConfig};
pub use exchange::{Exchange, JournalEntry};
pub use sim::{Sim, SimConfig};
pub use types::*;

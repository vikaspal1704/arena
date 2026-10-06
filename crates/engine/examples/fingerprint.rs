//! Prints the fingerprint after `steps` steps of a seeded session. CI compares
//! this native result with the WebAssembly build's.
use arena_engine::{Sim, SimConfig};

fn main() {
    let mut a = std::env::args()
        .skip(1)
        .map(|s| s.parse::<u64>().expect("number"));
    let (seed, steps) = (a.next().unwrap_or(42), a.next().unwrap_or(2000));
    let mut sim = Sim::new(SimConfig {
        seed,
        ..SimConfig::default()
    });
    for _ in 0..steps {
        sim.step(100);
    }
    println!(
        "seq {} fingerprint {:016x}",
        sim.exchange().seq(),
        sim.exchange().fingerprint()
    );
}

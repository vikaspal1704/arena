//! FNV-1a over 64-bit words: tiny, dependency-free and identical on every
//! platform (native and WebAssembly), which is all a state fingerprint needs.
//! It is not a cryptographic hash and is not used as one.

#[derive(Clone, Copy, Debug)]
pub struct Fnv(u64);

const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const PRIME: u64 = 0x0000_0100_0000_01b3;

impl Fnv {
    pub fn new() -> Self {
        Fnv(OFFSET)
    }

    pub fn with_seed(seed: u64) -> Self {
        let mut h = Fnv::new();
        h.write(seed);
        h
    }

    pub fn write(&mut self, word: u64) {
        for byte in word.to_le_bytes() {
            self.0 ^= byte as u64;
            self.0 = self.0.wrapping_mul(PRIME);
        }
    }

    pub fn finish(&self) -> u64 {
        self.0
    }
}

impl Default for Fnv {
    fn default() -> Self {
        Fnv::new()
    }
}

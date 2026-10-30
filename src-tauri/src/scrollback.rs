#![allow(dead_code)] // API consumed by the session manager (Task 8)

use std::collections::VecDeque;

pub const SCROLLBACK_CAP: usize = 2 * 1024 * 1024;

/// Byte buffer that keeps only the most recent `cap` bytes.
pub struct Scrollback {
    cap: usize,
    buf: VecDeque<u8>,
}

impl Scrollback {
    pub fn new(cap_bytes: usize) -> Self {
        Self { cap: cap_bytes, buf: VecDeque::new() }
    }
    pub fn push(&mut self, data: &[u8]) {
        let data = if data.len() > self.cap { &data[data.len() - self.cap..] } else { data };
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        self.buf.drain(..overflow);
        self.buf.extend(data);
    }
    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
    pub fn len(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn scrollback_keeps_all_under_cap() { let mut s = Scrollback::new(10); s.push(b"abc"); assert_eq!(s.snapshot(), b"abc"); }
    #[test] fn scrollback_caps_bytes() { let mut s = Scrollback::new(4); s.push(b"abcdef"); s.push(b"gh"); assert_eq!(s.snapshot(), b"efgh"); assert_eq!(s.len(), 4); }
}

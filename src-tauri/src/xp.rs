//! XP and house levels. XP depends only on whether a finished session was closed, never on
//! how the session was configured (spec §4).

/// XP for each finished session that is closed.
pub const XP_PER_SESSION: u32 = 100;

/// XP needed to leave `level`: `round(100 * 1.4^(level - 1))`.
pub fn need(level: u32) -> u32 {
    (100.0 * 1.4f64.powi(level.saturating_sub(1) as i32)).round() as u32
}

/// Adds `gain` to `xp` at `level`, carrying over into as many levels as it pays for.
pub fn award(level: u32, xp: u32, gain: u32) -> (u32, u32) {
    let (mut level, mut xp) = (level.max(1), xp.saturating_add(gain));
    while xp >= need(level) {
        xp -= need(level);
        level += 1;
    }
    (level, xp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn need_curve() {
        let got: Vec<u32> = (1..=5).map(need).collect();
        assert_eq!(got, vec![100, 140, 196, 274, 384]);
    }

    #[test]
    fn award_levels_up_across_thresholds() {
        assert_eq!(award(1, 50, 100), (2, 50));
        assert_eq!(award(1, 0, 100), (2, 0));
        assert_eq!(award(2, 139, 100), (3, 99));
        assert_eq!(award(1, 0, 500), (4, 64));
    }
}

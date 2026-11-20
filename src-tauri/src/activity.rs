//! How busy a workspace is: its house's look follows the sessions accepted there lately, not a
//! lifetime total. Mirrored in `src/village/activity.ts` (same table in both tests).

const DAY_MS: i64 = 24 * 3600 * 1000;
/// A ship counts half as much after this long.
pub const HALF_LIFE_MS: i64 = 3 * DAY_MS;
/// Ships older than this are forgotten (they would count for under 4%).
pub const KEEP_MS: i64 = 14 * DAY_MS;
pub const WEEK_MS: i64 = 7 * DAY_MS;

/// The score each stage needs: Stirring, Active, Busy, Booming (below the first is Quiet).
const THRESHOLDS: [f64; 4] = [0.5, 2.0, 4.0, 7.0];

/// Each ship's weight halves every `HALF_LIFE_MS`; a time in the future (clock skew) counts as now.
pub fn score(ships: &[i64], now: i64) -> f64 {
    ships.iter().map(|&at| 0.5f64.powf((now - at).max(0) as f64 / HALF_LIFE_MS as f64)).sum()
}

/// The house stage 0-4 (Quiet, Stirring, Active, Busy, Booming).
pub fn stage(ships: &[i64], now: i64) -> u8 {
    let s = score(ships, now);
    THRESHOLDS.iter().filter(|&&t| s >= t).count() as u8
}

/// Ships in the last `span_ms`.
pub fn shipped_within(ships: &[i64], now: i64, span_ms: i64) -> u32 {
    ships.iter().filter(|&&at| now - at < span_ms).count() as u32
}

/// A level that apps before activity houses draw as `stage` (their `houseStage`).
pub fn legacy_level(stage: u8) -> u32 {
    [1, 2, 4, 6, 8][stage.min(4) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: i64 = 86_400_000;

    #[test]
    fn stage_table() {
        let now = 100 * D;
        let cases: Vec<(Vec<i64>, u8)> = vec![
            (vec![], 0),
            (vec![now], 1),
            (vec![now - 4 * D], 0),
            (vec![now - 2 * D, now - 3 * D], 1),
            (vec![now, now - D, now - 2 * D], 2),
            ((0..8).map(|i| now - i * D).collect(), 3),
            ((0..14).map(|i| now - i * D / 2).collect(), 4),
            (vec![now + 5 * D], 1),
        ];
        for (ships, want) in cases {
            assert_eq!(stage(&ships, now), want, "{ships:?} (score {})", score(&ships, now));
        }
    }

    #[test]
    fn shipped_within_a_week() {
        let now = 100 * D;
        assert_eq!(shipped_within(&[now, now - 6 * D, now - 7 * D], now, WEEK_MS), 2);
    }

    #[test]
    fn legacy_levels_map_back_to_the_same_stage() {
        assert_eq!((0..5).map(legacy_level).collect::<Vec<_>>(), vec![1, 2, 4, 6, 8]);
    }
}

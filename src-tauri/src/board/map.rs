//! When the village's map (`snapshot.rs`) is written to the board. No I/O: `tick` says what to
//! write, the publisher's message queue writes it.
use super::cli::MsgWrite;
use super::snapshot::{same_but_seen, text, Snapshot};

/// A change is written at most this often.
pub const CHANGE_MS: i64 = 10_000;
/// With no change, the map is still written this often: its `seen` is the Mac's heartbeat for visitors.
pub const SEEN_MS: i64 = 300_000;

#[derive(Default)]
pub struct MapWriter {
    /// Which board and owner the root below is on.
    key: String,
    /// The map's message, once posted.
    root: Option<String>,
    posting: bool,
    /// What the board has, and when it got it.
    written: Option<(Snapshot, i64)>,
    /// An edit is in the publisher's queue: nothing more is queued behind it, however long the
    /// board takes (a board that is down for hours must not come back to hundreds of stale maps).
    flying: Option<(Snapshot, i64)>,
}

fn kv(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

impl MapWriter {
    /// What to write now, if anything. `key`: the board and owner the app publishes to; a new
    /// one starts a new root.
    pub fn tick(&mut self, key: &str, snap: &Snapshot, now: i64) -> Option<MsgWrite> {
        if self.key != key {
            *self = MapWriter { key: key.to_string(), ..Default::default() };
        }
        let Some(root) = self.root.clone() else {
            if self.posting {
                return None;
            }
            self.posting = true;
            return Some(MsgWrite::Post {
                channel: format!("v/{}/village", snap.owner),
                text: text(snap),
                labels: vec![kv("coc.kind", "village-map"), kv("coc.host", &snap.host)],
                key: format!("coc-map-{}", snap.host),
            });
        };
        if self.flying.is_some() {
            return None;
        }
        let due = match &self.written {
            // The board gives back the same root for the same key, with whatever text it had: write over it.
            None => true,
            Some((last, at)) => (!same_but_seen(last, snap) && now - at >= CHANGE_MS) || now - at >= SEEN_MS,
        };
        if !due {
            return None;
        }
        self.flying = Some((snap.clone(), now));
        Some(MsgWrite::Edit { id: root, text: text(snap) })
    }

    /// The edit handed out by `tick` ended: delivered, or given up (then the next tick writes
    /// what the village is by then).
    pub fn delivered(&mut self, ok: bool) {
        if let Some(sent) = self.flying.take()
            && ok
        {
            self.written = Some(sent);
        }
    }

    /// The root's post ended: its id, or None when it was not delivered (the next tick posts again).
    pub fn posted(&mut self, id: Option<String>) {
        self.posting = false;
        self.root = id;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(state: &str, seen: i64) -> Snapshot {
        let mut s = Snapshot { v: 1, host: "h1".into(), owner: "ada".into(), name: None, seen, workspaces: vec![], builders: vec![], sessions: vec![], mates: vec![] };
        s.name = Some(state.into());
        s
    }

    #[test]
    fn the_first_tick_posts_the_root_and_later_ones_edit_it() {
        let mut w = MapWriter::default();
        let Some(MsgWrite::Post { channel, labels, key, text }) = w.tick("b", &snap("a", 1), 1_000) else { panic!() };
        assert_eq!((channel.as_str(), key.as_str()), ("v/ada/village", "coc-map-h1"));
        assert_eq!(labels, [("coc.kind".to_string(), "village-map".to_string()), ("coc.host".to_string(), "h1".to_string())]);
        assert!(crate::board::snapshot::parse(&text).is_some());
        assert_eq!(w.tick("b", &snap("a", 2), 2_000), None, "the post is under way");
        w.posted(Some("msg_m".into()));
        // a repeated post would not have changed an existing root's text: the first tick after it edits
        assert!(matches!(w.tick("b", &snap("a", 3), 3_000), Some(MsgWrite::Edit { id, .. }) if id == "msg_m"));
        w.delivered(true);
        assert_eq!(w.tick("b", &snap("a", 4), 4_000), None);
    }

    #[test]
    fn a_post_that_was_not_delivered_is_tried_again() {
        let mut w = MapWriter::default();
        w.tick("b", &snap("a", 1), 1_000);
        w.posted(None);
        assert!(matches!(w.tick("b", &snap("a", 2), 2_000), Some(MsgWrite::Post { .. })));
    }

    fn settled() -> MapWriter {
        let mut w = MapWriter::default();
        w.tick("b", &snap("a", 0), 0);
        w.posted(Some("msg_m".into()));
        w.tick("b", &snap("a", 0), 0);
        w.delivered(true);
        w
    }

    #[test]
    fn a_change_is_written_at_most_every_ten_seconds() {
        let mut w = settled();
        assert_eq!(w.tick("b", &snap("b", 5_000), 5_000), None, "too soon");
        let Some(MsgWrite::Edit { text, .. }) = w.tick("b", &snap("c", 10_000), 10_000) else { panic!() };
        assert!(text.contains(r#""name":"c""#), "the newest state is what is written: {text}");
        w.delivered(true);
        assert_eq!(w.tick("b", &snap("c", 11_000), 11_000), None, "nothing changed");
    }

    #[test]
    fn seen_is_refreshed_every_five_minutes_without_a_change() {
        let mut w = settled();
        assert_eq!(w.tick("b", &snap("a", 299_999), 299_999), None);
        let Some(MsgWrite::Edit { text, .. }) = w.tick("b", &snap("a", 300_000), 300_000) else { panic!() };
        assert!(text.contains(r#""seen":300000"#), "{text}");
    }

    #[test]
    fn one_write_at_a_time_however_long_the_board_takes() {
        // the board is down: the first edit sits in the queue; nothing more is queued behind it
        let mut w = settled();
        assert!(w.tick("b", &snap("b", 10_000), 10_000).is_some());
        for n in 2..200 {
            assert_eq!(w.tick("b", &snap(&format!("s{n}"), n * 10_000), n * 10_000), None, "tick {n}");
        }
        // it was given up: what the village is now is written, once
        w.delivered(false);
        let Some(MsgWrite::Edit { text, .. }) = w.tick("b", &snap("now", 2_000_000), 2_000_000) else { panic!() };
        assert!(text.contains(r#""name":"now""#));
        assert_eq!(w.tick("b", &snap("later", 2_010_000), 2_010_000), None);
        w.delivered(true);
        assert!(w.tick("b", &snap("later", 2_020_000), 2_020_000).is_some());
    }

    #[test]
    fn another_board_starts_a_new_root() {
        let mut w = settled();
        assert!(matches!(w.tick("other", &snap("a", 1), 1), Some(MsgWrite::Post { .. })));
    }
}

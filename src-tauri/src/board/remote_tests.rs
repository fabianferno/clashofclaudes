use super::*;
use crate::model::{AskOption, AskQuestion, SessionInfo, SessionKind, SessionState};
use std::collections::HashSet;

// From `node scripts/remote-vectors.mjs`: a key and signatures made with WebCrypto, as a phone makes them.
const PUB: &str = "BJFoira10seT_4mQCR9cHCW_d571sQbL3La0PctTmwr5P3GDEX_lc0QORs_pqRotn_e4cNgEMUb1Sdclf3Km8E8";
const KEY_ID: &str = "e1628ecfdc6cbe3e";
const CHECK: &str = "792 693";
const BLOCK: &str = r#"{"v":1,"host":"h1","session":"s1","since":42,"wait":"decide","can":["allow","deny"],"question":"Bash: npm test","options":null}"#;
const PROMPT: &str = "ae3a1276c07ab30713915df0019df188200c1e5c1c118aa88093a8cb0d779cfc";
const NONCE: &str = "000102030405060708090a0b0c0d0e0f";
const MSG: &str = "coc-act-1\nallow\n\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n000102030405060708090a0b0c0d0e0f\nae3a1276c07ab30713915df0019df188200c1e5c1c118aa88093a8cb0d779cfc";
const SIG: &str = "o_hEb90kqsSNUXZ39UrU8AtMwLmee8ZJxz2I3GaYZFtL0E3Z32pCOnB2jwdPbUAkpbJZKAqrW4rsp31Rhjq-aA";
const HIGH_S: &str = "o_hEb90kqsSNUXZ39UrU8AtMwLmee8ZJxz2I3GaYZFu0L7IlIJW9xo-JcPiwkr_bFzShhZxsQvoHEk1xdihm6Q";

fn public() -> Vec<u8> {
    unb64(PUB).unwrap()
}

fn info(state: SessionState) -> SessionInfo {
    SessionInfo {
        id: "s1".into(),
        workspace_id: "w1".into(),
        kind: SessionKind::Agent { builder_id: "b1".into() },
        task: None,
        title: None,
        state,
        steps: 0,
        started_at: 1,
        last_output_at: 1,
        reached_finished: false,
        worktree: None,
        command_preview: String::new(),
        awaiting_decision: false,
        busy: false,
        rev: 1,
        spot: None,
        paused: false,
        subagents: vec![],
        state_since: 42,
        last_message: None,
        asking: None,
        questions: vec![],
        parked: None,
    }
}

fn needs() -> SessionInfo {
    info(SessionState::NeedsYou { reason: "which one?".into() })
}

fn question(options: &[&str], multi: bool) -> AskQuestion {
    AskQuestion {
        question: "Which database?".into(),
        header: None,
        options: options.iter().map(|o| AskOption { label: o.to_string(), description: None }).collect(),
        multi_select: multi,
    }
}

#[test]
fn verify_accepts_webcrypto_and_refuses_high_s() {
    assert!(verify(&public(), MSG.as_bytes(), SIG));
    assert!(!verify(&public(), MSG.as_bytes(), HIGH_S), "the (r, n-s) twin of a good signature");
    assert!(!verify(&public(), b"x", SIG));
    assert!(!verify(&public(), MSG.as_bytes(), "not base64 !"));
    assert!(!verify(&public()[..40], MSG.as_bytes(), SIG));
}

#[test]
fn key_id_and_check_number_match_the_phone() {
    assert_eq!(key_id(&public()), KEY_ID);
    assert_eq!(check_number(&public(), "msg_t_1"), CHECK);
    assert_eq!(sha_hex(BLOCK.as_bytes()), PROMPT);
}

fn action(r#do: Do) -> Action {
    Action { v: 1, r#do, pick: None, text: None, nonce: NONCE.into(), key: KEY_ID.into(), prompt: PROMPT.into(), sig: SIG.into() }
}

#[test]
fn signed_bytes_are_the_six_lines() {
    assert_eq!(signed_bytes(&action(Do::Allow)), MSG.as_bytes());
    let mut a = action(Do::Answer);
    a.pick = Some(2);
    a.text = Some("use sqlite".into());
    let s = String::from_utf8(signed_bytes(&a)).unwrap();
    let lines: Vec<&str> = s.split('\n').collect();
    assert_eq!(lines.len(), 6);
    assert_eq!(&lines[..3], &["coc-act-1", "answer", "2"]);
    assert_eq!(lines[3], sha_hex(b"use sqlite"));
}

#[test]
fn an_action_is_read_from_its_json() {
    let text = format!(r#"{{"v":1,"do":"allow","nonce":"{NONCE}","key":"{KEY_ID}","prompt":"{PROMPT}","sig":"{SIG}"}}"#);
    assert_eq!(parse_action(&text), Some(action(Do::Allow)));
    assert_eq!(parse_action("allow"), None);
    assert_eq!(parse_action(r#"{"v":2,"do":"allow","nonce":"a","key":"b","prompt":"c","sig":"d"}"#), None, "a version this app does not know");
}

#[test]
fn block_round_trips_through_text() {
    let b = block(&needs(), "s1", "h1", "answer", false, true);
    let j = block_json(&b);
    let text = format!("Asking you: which one?{}", fenced(&j));
    assert_eq!(block_in(&text), Some(j.as_str()));
    assert_eq!(serde_json::from_str::<PromptBlock>(&j).unwrap(), b);
    assert_eq!(block_in("Asking you: which one?"), None);
    // the last block counts: a builder's own message quoted above it cannot stand in
    let two = format!("x{}{}", fenced("{\"fake\":1}"), fenced(&j));
    assert_eq!(block_in(&two), Some(j.as_str()));
}

#[test]
fn the_block_names_the_prompt() {
    let mut i = needs();
    i.awaiting_decision = true;
    i.asking = Some("Bash: npm test".into());
    let b = block(&i, "s1", "h1", "decide", true, true);
    assert_eq!((b.v, b.host.as_str(), b.session.as_str(), b.since, b.wait.as_str()), (1, "h1", "s1", 42, "decide"));
    assert_eq!(b.can, vec![Do::Allow, Do::Deny]);
    assert_eq!(b.question.as_deref(), Some("Bash: npm test"));
    let off = block(&i, "s1", "h1", "decide", true, false);
    assert_eq!((off.question, off.options, off.can), (None, None, vec![Do::Allow, Do::Deny]));

    let mut q = needs();
    q.questions = vec![question(&["sqlite", "postgres"], false)];
    let b = block(&q, "s1", "h1", "answer", false, true);
    assert_eq!(b.question.as_deref(), Some("Which database?"));
    assert_eq!(b.options, Some(vec!["sqlite".to_string(), "postgres".to_string()]));
}

#[test]
fn can_follows_the_table() {
    let mut decide = needs();
    decide.awaiting_decision = true;
    assert_eq!(can(&decide, true, true), vec![Do::Allow, Do::Deny]);
    assert_eq!(can(&decide, false, true), vec![], "a prompt the app has no keys for");

    let mut picker = needs();
    picker.questions = vec![question(&["a", "b"], false)];
    assert_eq!(can(&picker, false, true), vec![Do::Answer]);
    assert_eq!(can(&picker, false, false), vec![], "details off: the options cannot be shown");
    picker.questions = vec![question(&["a", "b"], true)];
    assert_eq!(can(&picker, false, true), vec![], "multi-select");
    picker.questions = vec![question(&["a"], false), question(&["b"], false)];
    assert_eq!(can(&picker, false, true), vec![], "two questions");
    picker.questions = vec![question(&[], false)];
    assert_eq!(can(&picker, false, true), vec![], "a question named only, answered in the terminal");

    assert_eq!(can(&needs(), false, true), vec![Do::Answer], "asking with no picker");
    assert_eq!(can(&needs(), false, false), vec![Do::Answer]);
    assert_eq!(can(&info(SessionState::Stuck { reason: "x".into() }), false, true), vec![Do::Followup]);
    assert_eq!(can(&info(SessionState::Finished), false, true), vec![Do::Followup]);

    assert_eq!(can(&info(SessionState::Working), false, true), vec![]);
    assert_eq!(can(&info(SessionState::Starting), false, true), vec![]);
    assert_eq!(can(&info(SessionState::Ended { exit_code: Some(0) }), false, true), vec![]);
    let mut paused = info(SessionState::Finished);
    paused.paused = true;
    assert_eq!(can(&paused, false, true), vec![]);
    let mut parked = info(SessionState::Finished);
    parked.parked = Some("later".into());
    assert_eq!(can(&parked, false, true), vec![]);
    let mut term = info(SessionState::Finished);
    term.kind = SessionKind::Terminal;
    assert_eq!(can(&term, false, true), vec![]);
}

fn phones() -> Vec<Phone> {
    vec![Phone { key: KEY_ID.into(), public: public(), name: "iPhone".into(), paired_at: 1, last_used: 0, record: None, level: None, who: None }]
}

fn open() -> Option<Open<'static>> {
    Some(Open { block_json: BLOCK, since: 42, current_since: 42 })
}

fn judged(a: &Action, phones: &[Phone], open: Option<Open<'_>>, seen: &[String], paused: bool) -> Verdict {
    judge(a, phones, open, &seen.iter().cloned().collect::<HashSet<_>>(), paused)
}

#[test]
fn judge_applies_a_good_action() {
    assert_eq!(judged(&action(Do::Allow), &phones(), open(), &[], false), Verdict::Apply);
}

#[test]
fn judge_refuses_what_is_not_from_a_paired_phone() {
    assert_eq!(judged(&action(Do::Allow), &[], open(), &[], false), Verdict::Refused, "unknown key");
    let mut bad = action(Do::Allow);
    bad.sig = HIGH_S.into();
    assert_eq!(judged(&bad, &phones(), open(), &[], false), Verdict::Refused, "bad signature");
    // signed as allow, sent as deny: the signature no longer covers it
    assert_eq!(judged(&action(Do::Deny), &phones(), open(), &[], false), Verdict::Refused);
    assert_eq!(judged(&action(Do::Allow), &phones(), open(), &[], true), Verdict::Refused, "the remote is paused");
}

#[test]
fn judge_calls_a_moved_prompt_stale() {
    assert_eq!(judged(&action(Do::Allow), &phones(), None, &[], false), Verdict::Stale, "nothing is open");
    let other = Some(Open { block_json: r#"{"v":1}"#, since: 42, current_since: 42 });
    assert_eq!(judged(&action(Do::Allow), &phones(), other, &[], false), Verdict::Stale, "another prompt block");
    let moved = Some(Open { block_json: BLOCK, since: 42, current_since: 43 });
    assert_eq!(judged(&action(Do::Allow), &phones(), moved, &[], false), Verdict::Stale, "the session moved on");
    let seen = vec![sha_hex(MSG.as_bytes())];
    assert_eq!(judged(&action(Do::Allow), &phones(), open(), &seen, false), Verdict::Stale, "applied before");
}

/// Signs with a key made here (ring), for the rules a WebCrypto vector cannot reach.
fn signer() -> (Vec<Phone>, impl Fn(&mut Action)) {
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    let public = pair.public_key().as_ref().to_vec();
    let key = key_id(&public);
    let phones = vec![Phone { key: key.clone(), public, name: "t".into(), paired_at: 1, last_used: 0, record: None, level: None, who: None }];
    let sign = move |a: &mut Action| {
        a.key = key.clone();
        loop {
            a.sig = b64(pair.sign(&rng, &signed_bytes(a)).unwrap().as_ref());
            if low_s(&unb64(&a.sig).unwrap()) {
                break;
            }
        }
    };
    (phones, sign)
}

#[test]
fn judge_refuses_what_the_prompt_does_not_offer() {
    let (phones, sign) = signer();
    let mut a = action(Do::Followup);
    sign(&mut a);
    assert_eq!(judged(&a, &phones, open(), &[], false), Verdict::Refused, "followup on a decision");

    let picker = r#"{"v":1,"host":"h1","session":"s1","since":42,"wait":"answer","can":["answer"],"question":"Which?","options":["a","b"]}"#;
    let open = || Some(Open { block_json: picker, since: 42, current_since: 42 });
    let mut pick = action(Do::Answer);
    pick.prompt = sha_hex(picker.as_bytes());
    pick.pick = Some(2);
    sign(&mut pick);
    assert_eq!(judged(&pick, &phones, open(), &[], false), Verdict::Refused, "no such option");
    pick.pick = Some(1);
    sign(&mut pick);
    assert_eq!(judged(&pick, &phones, open(), &[], false), Verdict::Apply);
    pick.pick = None;
    sign(&mut pick);
    assert_eq!(judged(&pick, &phones, open(), &[], false), Verdict::Refused, "an answer with neither a pick nor words");
    pick.text = Some("neither".into());
    sign(&mut pick);
    assert_eq!(judged(&pick, &phones, open(), &[], false), Verdict::Apply);
}

#[test]
fn allows_follows_the_levels() {
    use crate::model::Level;
    for d in [Do::Allow, Do::Deny, Do::Answer, Do::Followup] {
        assert!(allows(None, d), "the owner's own phone");
        assert!(!allows(Some(Level::Visitor), d));
        assert!(allows(Some(Level::Trusted), d));
    }
    assert!(allows(Some(Level::Helper), Do::Answer) && allows(Some(Level::Helper), Do::Followup));
    assert!(!allows(Some(Level::Helper), Do::Allow) && !allows(Some(Level::Helper), Do::Deny));
}

#[test]
fn judge_holds_a_teammates_key_to_its_level() {
    use crate::model::Level;
    let (mut phones, sign) = signer();
    let mut allow = action(Do::Allow);
    sign(&mut allow);
    for (level, verdict) in [(Level::Visitor, Verdict::Refused), (Level::Helper, Verdict::Refused), (Level::Trusted, Verdict::Apply)] {
        phones[0].level = Some(level);
        assert_eq!(judged(&allow, &phones, open(), &[], false), verdict, "{level:?}");
    }
    let review = r#"{"v":1,"host":"h1","session":"s1","since":42,"wait":"review","can":["followup"]}"#;
    let mut follow = action(Do::Followup);
    follow.prompt = sha_hex(review.as_bytes());
    follow.text = Some("also add tests".into());
    sign(&mut follow);
    let open = || Some(Open { block_json: review, since: 42, current_since: 42 });
    phones[0].level = Some(Level::Helper);
    assert_eq!(judged(&follow, &phones, open(), &[], false), Verdict::Apply);
    phones[0].level = Some(Level::Visitor);
    assert_eq!(judged(&follow, &phones, open(), &[], false), Verdict::Refused);
}

#[test]
fn phones_off_stops_phones_and_not_teammates() {
    use crate::model::Level;
    let (mut phones, sign) = signer();
    let mut allow = action(Do::Allow);
    sign(&mut allow);
    // the phone remote is switched off, or paused over a redeploy: that is about phones
    assert_eq!(judged(&allow, &phones, open(), &[], true), Verdict::Refused);
    phones[0].level = Some(Level::Trusted);
    assert_eq!(judged(&allow, &phones, open(), &[], true), Verdict::Apply, "a teammate's action never passes through the remote");
}

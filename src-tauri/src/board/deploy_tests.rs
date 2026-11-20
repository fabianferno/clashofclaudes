use super::*;
use crate::board::cli::{BoardCli, CliError, Output};
use std::sync::Mutex;

// Recorded from CLI 66.4.0 (the spec's spike section), trimmed.
const LS: &str = r#"{"contextName":"acme","deployments":[
 {"url":"village-remote-bbb-acme.vercel.app","name":"village-remote","state":"READY","target":"production","createdAt":1795146765813,"creator":{"uid":"u2","username":"bob"}},
 {"url":"village-remote-ccc-acme.vercel.app","name":"village-remote","state":"ERROR","target":"production","createdAt":1795146000000,"creator":{"uid":"u1","username":"ada"}},
 {"url":"village-remote-aaa-acme.vercel.app","name":"village-remote","state":"READY","target":"production","createdAt":1795140000000,"creator":{"uid":"u1","username":"ada"}}],"pagination":{}}"#;
const NO_PROJECT: &str = r#"{"status":"error","reason":"project_not_found","message":"There is no project for \"village-remote\""}"#;
const INSPECT: &str = r#"{"id":"dpl_7oA","name":"village-remote","url":"village-remote-bbb-acme.vercel.app","target":"production","readyState":"READY","aliases":["village-remote.vercel.app","village-remote-acme.vercel.app"]}"#;
const DEPLOYED: &str = r#"{"status":"ok","deployment":{"id":"dpl_9","url":"https://village-remote-ddd-acme.vercel.app","productionUrl":"https://village-remote.vercel.app","readyState":"READY","target":"production"},"message":"ready"}"#;
const ENV_ADDED: &str = r#"{"env":{"key":"X","target":["production"]},"outcome":"added","replaced":false}"#;

/// Answers by the first words of the call.
struct Fake {
    calls: Mutex<Vec<String>>,
    answers: Vec<(&'static str, Result<&'static str, CliError>)>,
}

impl Fake {
    fn new(answers: Vec<(&'static str, Result<&'static str, CliError>)>) -> Fake {
        Fake { calls: Mutex::default(), answers }
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl BoardCli for Fake {
    fn raw(&self, args: &[String]) -> Result<Output, CliError> {
        let line = args.join(" ");
        self.calls.lock().unwrap().push(line.clone());
        let (_, a) = self.answers.iter().find(|(prefix, _)| line.starts_with(prefix)).unwrap_or_else(|| panic!("unexpected call: {line}"));
        a.clone().map(|stdout| Output { ok: true, stdout: stdout.to_string(), stderr: String::new() })
    }
}

#[test]
fn production_deployments_are_the_ready_ones_newest_first() {
    let cli = Fake::new(vec![("ls", Ok(LS))]);
    let ds = production_deployments(&cli, Some("acme")).unwrap().unwrap();
    assert_eq!(cli.calls(), ["ls village-remote --environment production --json --scope acme"]);
    assert_eq!(ds.iter().map(|d| (d.id.as_str(), d.by.as_str(), d.created)).collect::<Vec<_>>(), [("village-remote-bbb-acme.vercel.app", "bob", 1795146765813), ("village-remote-aaa-acme.vercel.app", "ada", 1795140000000)]);
    let none = Fake::new(vec![("ls", Ok(NO_PROJECT))]);
    assert_eq!(production_deployments(&none, None).unwrap(), None);
    assert_eq!(none.calls(), ["ls village-remote --environment production --json"]);
    let down = Fake::new(vec![("ls", Err(CliError::Retryable("timed out".into())))]);
    assert!(production_deployments(&down, None).is_err());
}

#[test]
fn find_reads_the_project() {
    let cli = Fake::new(vec![("ls", Ok(LS)), ("inspect", Ok(INSPECT))]);
    assert_eq!(find(&cli, Some("acme")).unwrap(), Found::Team { url: "https://village-remote.vercel.app".into(), deployment: "village-remote-bbb-acme.vercel.app".into() });
    assert_eq!(cli.calls()[1], "inspect village-remote-bbb-acme.vercel.app --json --scope acme");
    assert_eq!(find(&Fake::new(vec![("ls", Ok(NO_PROJECT))]), None).unwrap(), Found::None);
    // a project with nothing deployed is not a remote yet
    assert_eq!(find(&Fake::new(vec![("ls", Ok(r#"{"deployments":[]}"#))]), None).unwrap(), Found::None);
}

#[test]
fn unknown_finds_a_deployment_we_did_not_make() {
    let cli = Fake::new(vec![("ls", Ok(LS))]);
    let ds = production_deployments(&cli, None).unwrap().unwrap();
    let trusted = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(unknown(&ds, &trusted(&["village-remote-aaa-acme.vercel.app"])).map(|d| d.by.as_str()), Some("bob"));
    assert_eq!(unknown(&ds, &trusted(&["village-remote-aaa-acme.vercel.app", "village-remote-bbb-acme.vercel.app"])), None);
    assert!(unknown(&[], &[]).is_none());
    assert_eq!(pause_reason(&ds[0]), "The remote was redeployed by bob.");
}

#[test]
fn new_secrets_are_push_keys_and_a_setup_secret() {
    let (a, b) = (new_secrets().unwrap(), new_secrets().unwrap());
    let public = crate::board::remote::unb64(&a.vapid_public).unwrap();
    assert_eq!((public.len(), public[0]), (65, 4));
    assert_eq!(crate::board::remote::unb64(&a.vapid_private).unwrap().len(), 32);
    assert!(a.setup.len() >= 32 && a.setup != b.setup && a.vapid_private != b.vapid_private);
    // the private half is the public half's: a signature made with it verifies
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    let pair = EcdsaKeyPair::from_private_key_and_public_key(&ECDSA_P256_SHA256_FIXED_SIGNING, &crate::board::remote::unb64(&a.vapid_private).unwrap(), &public, &ring::rand::SystemRandom::new()).unwrap();
    assert_eq!(pair.public_key().as_ref(), public.as_slice());
}

fn deploying() -> Vec<(&'static str, Result<&'static str, CliError>)> {
    vec![("project add", Ok("")), ("link", Ok("")), ("env add", Ok(ENV_ADDED)), ("deploy", Ok(DEPLOYED))]
}

#[test]
fn a_first_deploy_makes_the_project_sets_the_variables_and_deploys() {
    let cli = Fake::new(deploying());
    let dir = tempfile::tempdir().unwrap();
    let secrets = NewSecrets { setup: "s3".into(), vapid_public: "PUB".into(), vapid_private: "PRIV".into() };
    let said = Mutex::new(Vec::new());
    let d = deploy(&cli, Some("acme"), dir.path(), "village", Some(&secrets), &|m| said.lock().unwrap().push(m.to_string())).unwrap();
    assert_eq!(d, Deployed { url: "https://village-remote.vercel.app".into(), deployment: "village-remote-ddd-acme.vercel.app".into() });
    let src = dir.path().to_string_lossy().into_owned();
    assert_eq!(
        cli.calls(),
        [
            "project add village-remote --scope acme".to_string(),
            format!("link --yes --project village-remote --cwd {src} --scope acme"),
            format!("env add COC_BOARD --environment production --value village --force --yes --json --cwd {src} --scope acme"),
            format!("env add COC_SETUP --environment production --value s3 --force --yes --json --cwd {src} --scope acme"),
            format!("env add VAPID_PUBLIC --environment production --value PUB --force --yes --json --cwd {src} --scope acme"),
            format!("env add VAPID_PRIVATE --environment production --value PRIV --force --yes --json --cwd {src} --scope acme"),
            format!("deploy --prod --yes --cwd {src} --scope acme"),
        ]
    );
    assert!(dir.path().join("package.json").is_file(), "the source was written");
    assert_eq!(said.lock().unwrap().len(), 4);
}

#[test]
fn an_update_keeps_the_variables_it_has() {
    let cli = Fake::new(deploying());
    let dir = tempfile::tempdir().unwrap();
    deploy(&cli, None, dir.path(), "village", None, &|_| {}).unwrap();
    let calls = cli.calls();
    assert!(calls.iter().all(|c| !c.starts_with("env add") && !c.starts_with("project add")), "{calls:?}");
    assert_eq!(calls.len(), 2);
}

#[test]
fn a_failed_step_says_which_and_why() {
    let mut steps = deploying();
    steps[3] = ("deploy", Ok(r#"{"status":"error","reason":"deploy_failed","message":"Command \"npm run build\" exited with 1"}"#));
    let dir = tempfile::tempdir().unwrap();
    let e = deploy(&Fake::new(steps), None, dir.path(), "village", None, &|_| {}).unwrap_err();
    assert!(e.contains("npm run build"), "{e}");
    let mut steps = deploying();
    steps[1] = ("link", Err(CliError::Missing));
    assert!(deploy(&Fake::new(steps), None, dir.path(), "village", None, &|_| {}).unwrap_err().contains("Vercel CLI"));
    // the project is there already (another teammate made it): go on
    let mut steps = deploying();
    steps[0] = ("project add", Ok("Error: Project already exists"));
    let secrets = NewSecrets { setup: "s".into(), vapid_public: "P".into(), vapid_private: "Q".into() };
    assert!(deploy(&Fake::new(steps), None, dir.path(), "village", Some(&secrets), &|_| {}).is_ok());
}

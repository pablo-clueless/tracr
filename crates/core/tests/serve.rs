//! The transport, over a real loopback socket.
//!
//! Everything below has unit tests; what these cover is the wiring nothing else
//! touches — the handshake, the path routing that decides whether a connection
//! feeds the graph or watches it, and the fact that a viewer is pushed frames
//! without ever asking.

use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde_json::Value;
use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};

use tracr_core::serve::{self, AGENT_PATH};
use tracr_core::session::Session;
use tracr_core::skeleton::{node_kind, NodeId, Skeleton, SkeletonEdge, SkeletonNode};

type Client = WebSocket<MaybeTlsStream<TcpStream>>;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("missing fixture {}: {e}", path.display()))
}

fn skeleton() -> Skeleton {
    let file = |id: NodeId, label: &str| SkeletonNode {
        id,
        kind: node_kind::FILE,
        label: label.into(),
        parent: None,
        site: None,
    };
    let call = |id: NodeId, label: &str, parent: NodeId, site: u32| SkeletonNode {
        id,
        kind: node_kind::CALL_SITE,
        label: label.into(),
        parent: Some(parent),
        site: Some(site),
    };

    Skeleton::new(
        vec![
            file(1, "src/routes.ts"),
            file(2, "src/db.ts"),
            call(10, "readBody", 1, 5),
            call(20, "execute", 2, 65535),
        ],
        vec![SkeletonEdge {
            id: 1,
            source: 1,
            target: 2,
        }],
    )
}

/// Starts a daemon on an ephemeral port and returns its base URL.
///
/// Port 0 rather than a fixed one so tests can run at the same time as each
/// other, and as whatever else is on the machine.
fn daemon() -> String {
    let listener = serve::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    let session = serve::shared(Session::new(skeleton()));

    std::thread::spawn(move || {
        serve::serve_listener(session, listener, Duration::from_millis(10));
    });

    format!("ws://127.0.0.1:{port}")
}

fn open(url: &str) -> Client {
    let (socket, _) = connect(url).expect("handshake");
    socket
}

/// Reads until a frame satisfies `want`, or gives up.
///
/// Polling rather than asserting on the next message: the viewer loop is on its
/// own clock, so which tick carries the change is a race, and pinning it would
/// make the test flaky rather than strict.
fn wait_for(socket: &mut Client, want: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);

    while Instant::now() < deadline {
        let message = socket.read().expect("read");
        if let Message::Text(text) = message {
            let frame: Value = serde_json::from_str(&text).expect("valid json");
            if want(&frame) {
                return frame;
            }
        }
    }
    panic!("no frame matched before the deadline");
}

#[test]
fn hands_a_viewer_the_skeleton_before_anything_else() {
    // A delta names edge ids, which mean nothing without the skeleton.
    let url = daemon();
    let mut viewer = open(&url);

    let first = wait_for(&mut viewer, |_| true);

    assert_eq!(first["tag"], 0);
    assert_eq!(first["nodes"].as_array().unwrap().len(), 4);
    assert_eq!(first["edges"].as_array().unwrap().len(), 1);
}

#[test]
fn pushes_a_delta_to_a_viewer_that_never_asked() {
    let url = daemon();
    let mut viewer = open(&url);
    wait_for(&mut viewer, |frame| frame["tag"] == 0);

    let mut agent = open(&format!("{url}{AGENT_PATH}"));
    // A WebSocket message is one frame, so the length prefix is not used here.
    agent
        .send(Message::Binary(fixture("hello.bin").into()))
        .expect("hello");
    agent
        .send(Message::Binary(fixture("batch.bin").into()))
        .expect("batch");

    let delta = wait_for(&mut viewer, |frame| {
        frame["tag"] == 1 && !frame["edges"].as_array().unwrap().is_empty()
    });

    assert_eq!(delta["edges"][0]["edgeId"], 1);
    assert_eq!(delta["droppedTotal"], 4_294_967_295u64);
}

#[test]
fn routes_by_path_rather_than_by_guessing() {
    // The same port serves both roles, so the path is the only thing telling
    // an event source apart from a viewer.
    let url = daemon();

    let mut agent = open(&format!("{url}{AGENT_PATH}"));
    agent
        .send(Message::Binary(fixture("hello.bin").into()))
        .expect("hello");

    // A viewer gets a skeleton; an agent is never sent one, so a read on the
    // agent socket has nothing waiting behind it.
    let mut viewer = open(&url);
    assert_eq!(wait_for(&mut viewer, |_| true)["tag"], 0);
}

#[test]
fn every_viewer_gets_the_same_delta() {
    // The regression test for one shared tracker: the first viewer to tick used
    // to consume the change and leave the second with nothing.
    let url = daemon();
    let mut first = open(&url);
    let mut second = open(&url);
    wait_for(&mut first, |frame| frame["tag"] == 0);
    wait_for(&mut second, |frame| frame["tag"] == 0);

    let mut agent = open(&format!("{url}{AGENT_PATH}"));
    agent
        .send(Message::Binary(fixture("hello.bin").into()))
        .expect("hello");
    agent
        .send(Message::Binary(fixture("batch.bin").into()))
        .expect("batch");

    let lit = |frame: &Value| frame["tag"] == 1 && !frame["edges"].as_array().unwrap().is_empty();
    let a = wait_for(&mut first, lit);
    let b = wait_for(&mut second, lit);

    assert_eq!(a["edges"][0]["edgeId"], b["edges"][0]["edgeId"]);
    assert_eq!(a["edges"][0]["count"], b["edges"][0]["count"]);
}

#[test]
fn takes_a_granularity_change_from_the_viewer() {
    let url = daemon();
    let mut viewer = open(&url);
    wait_for(&mut viewer, |frame| frame["tag"] == 0);

    let mut agent = open(&format!("{url}{AGENT_PATH}"));
    agent
        .send(Message::Binary(fixture("hello.bin").into()))
        .expect("hello");
    agent
        .send(Message::Binary(fixture("batch.bin").into()))
        .expect("batch");
    wait_for(&mut viewer, |frame| {
        frame["tag"] == 1 && !frame["edges"].as_array().unwrap().is_empty()
    });

    // Nothing is declared between the call sites, so the same flow that lit a
    // file edge shows up as an undeclared crossing one level down.
    viewer
        .send(Message::Text(r#"{"level":2}"#.into()))
        .expect("level");

    let fine = wait_for(&mut viewer, |frame| {
        frame["tag"] == 1 && !frame["unmapped"].as_array().unwrap().is_empty()
    });
    assert_eq!(fine["unmapped"][0]["source"], 10);
    assert_eq!(fine["unmapped"][0]["target"], 20);
}

#[test]
fn shrugs_off_a_control_message_it_does_not_understand() {
    // A newer UI against an older daemon should degrade, not disconnect.
    let url = daemon();
    let mut viewer = open(&url);
    wait_for(&mut viewer, |frame| frame["tag"] == 0);

    viewer
        .send(Message::Text(r#"{"somethingElse":true}"#.into()))
        .expect("send");
    viewer
        .send(Message::Text("not json at all".into()))
        .expect("send");

    // Still live: a delta still arrives once an agent reports something.
    let mut agent = open(&format!("{url}{AGENT_PATH}"));
    agent
        .send(Message::Binary(fixture("hello.bin").into()))
        .expect("hello");
    agent
        .send(Message::Binary(fixture("batch.bin").into()))
        .expect("batch");

    let delta = wait_for(&mut viewer, |frame| {
        frame["tag"] == 1 && !frame["edges"].as_array().unwrap().is_empty()
    });
    assert_eq!(delta["edges"][0]["edgeId"], 1);
}

#[test]
fn keeps_serving_after_an_agent_disconnects() {
    // Provenance outlives the process that reported it.
    let url = daemon();
    let mut viewer = open(&url);
    wait_for(&mut viewer, |frame| frame["tag"] == 0);

    {
        let mut agent = open(&format!("{url}{AGENT_PATH}"));
        agent
            .send(Message::Binary(fixture("hello.bin").into()))
            .expect("hello");
        agent
            .send(Message::Binary(fixture("batch.bin").into()))
            .expect("batch");
        let _ = agent.close(None);
    }

    let delta = wait_for(&mut viewer, |frame| {
        frame["tag"] == 1 && !frame["edges"].as_array().unwrap().is_empty()
    });
    assert_eq!(delta["edges"][0]["count"], 1);
}

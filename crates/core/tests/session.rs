//! The whole pipeline, driven the way a transport drives it.
//!
//! These feed bytes the JavaScript agent actually produced — the same fixtures
//! `wire.rs` decodes — straight through ingest, rollup and emit, and assert on
//! the JSON a UI client would receive. Every layer below has its own tests; this
//! is the one that would catch two of them disagreeing.

use serde_json::Value;

use tracr_core::session::{ConnId, Session};
use tracr_core::skeleton::{node_kind, NodeId, Skeleton, SkeletonEdge, SkeletonNode};

const AGENT: ConnId = 1;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("missing fixture {}: {e}", path.display()))
}

/// Covers the sites the batch fixture actually names: it flows 5 -> 65535 and
/// sinks at 300.
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
            call(30, "query", 2, 300),
        ],
        vec![
            SkeletonEdge {
                id: 1,
                source: 1,
                target: 2,
            },
            SkeletonEdge {
                id: 2,
                source: 10,
                target: 20,
            },
        ],
    )
}

fn session() -> Session {
    let mut session = Session::new(skeleton());
    session.connect(AGENT);
    session
}

fn parse(json: &str) -> Value {
    serde_json::from_str(json).expect("emitted a frame the UI could not parse")
}

#[test]
fn folds_a_js_agent_stream_into_a_ui_frame() {
    let mut session = session();

    // stream.bin is a hello and a batch, each length-prefixed.
    session.feed(AGENT, &fixture("stream.bin"));
    let frame = parse(&session.tick().expect("something moved"));

    assert_eq!(frame["edges"][0]["edgeId"], 1);
    assert_eq!(frame["edges"][0]["count"], 1);
    assert_eq!(frame["sinks"][0]["nodeId"], 2);
    // The batch's Dropped event carries u32::MAX.
    assert_eq!(frame["droppedTotal"], 4_294_967_295u64);
}

#[test]
fn reassembles_a_stream_delivered_one_byte_at_a_time() {
    // A socket read boundary has nothing to do with a frame boundary.
    let mut session = session();

    for byte in fixture("stream.bin") {
        session.feed(AGENT, &[byte]);
    }

    let frame = parse(&session.tick().expect("something moved"));
    assert_eq!(frame["edges"][0]["edgeId"], 1);
    assert_eq!(session.stats().accepted, 2);
}

#[test]
fn refuses_to_fold_events_that_arrive_before_a_hello() {
    // Without a hello there is no label space, so the labels cannot be
    // translated and folding them would merge unrelated provenance.
    let mut session = session();

    session.feed_frame(AGENT, &fixture("batch.bin"));

    assert_eq!(session.stats().before_hello, 1);
    assert_eq!(session.stats().accepted, 0);
    assert_eq!(session.core().footprint().dag_nodes, 0);
}

#[test]
fn accepts_the_same_batch_once_the_hello_lands() {
    let mut session = session();

    session.feed_frame(AGENT, &fixture("hello.bin"));
    session.feed_frame(AGENT, &fixture("batch.bin"));

    assert_eq!(session.stats().accepted, 2);
    assert_eq!(session.stats().before_hello, 0);
    assert!(session.core().footprint().dag_nodes > 0);
}

#[test]
fn stays_quiet_on_a_tick_where_nothing_moved() {
    let mut session = session();
    session.feed(AGENT, &fixture("stream.bin"));

    assert!(session.tick().is_some());
    // An idle app must not cost the UI a parse and a layout pass.
    assert!(session.tick().is_none());
}

#[test]
fn speaks_up_when_only_a_counter_moved() {
    // No edge changed, but the agent admitted losing 9001 events. Silence here
    // would leave the UI showing a graph it has no reason to distrust.
    let mut session = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick();

    session.feed_frame(AGENT, &fixture("dropped-only.bin"));
    let frame = parse(&session.tick().expect("the dropped total moved"));

    assert!(frame["edges"].as_array().unwrap().is_empty());
    assert_eq!(frame["droppedTotal"], 4_294_967_295u64 + 9001);
}

#[test]
fn counts_a_malformed_frame_and_keeps_going() {
    let mut session = session();
    session.feed_frame(AGENT, &fixture("hello.bin"));

    session.feed_frame(AGENT, &[0xc1]); // never a valid msgpack byte

    assert_eq!(session.stats().malformed, 1);
    // Still usable afterwards: one bad frame is not a dead connection.
    session.feed_frame(AGENT, &fixture("batch.bin"));
    assert_eq!(session.stats().accepted, 2);
}

#[test]
fn counts_an_unknown_frame_tag_apart_from_a_broken_one() {
    // A newer agent against an older core is expected, not an error.
    let mut session = session();
    session.feed_frame(AGENT, &fixture("hello.bin"));

    session.feed_frame(AGENT, &[0x91, 0x63]); // one-element array, tag 99

    assert_eq!(session.stats().unknown, 1);
    assert_eq!(session.stats().malformed, 0);
}

#[test]
fn ignores_bytes_for_a_connection_that_was_never_opened() {
    let mut session = Session::new(skeleton());

    session.feed(999, &fixture("stream.bin"));

    assert_eq!(session.stats().accepted, 0);
    assert_eq!(session.connection_count(), 0);
}

#[test]
fn counts_two_agents_reporting_the_same_crossing() {
    let mut session = session();
    session.connect(2);

    session.feed(AGENT, &fixture("stream.bin"));
    session.feed(2, &fixture("stream.bin"));

    let frame = parse(&session.tick().expect("something moved"));
    assert_eq!(frame["edges"][0]["count"], 2);
}

#[test]
fn keeps_provenance_after_the_connection_that_reported_it_drops() {
    // A run-wide graph outlives the process that fed it; otherwise closing a
    // browser tab would erase what it showed.
    let mut session = session();
    session.feed(AGENT, &fixture("stream.bin"));
    let before = session.core().footprint().dag_nodes;

    session.disconnect(AGENT);

    assert_eq!(session.connection_count(), 0);
    assert_eq!(session.core().footprint().dag_nodes, before);
}

#[test]
fn resends_in_full_after_a_client_takes_the_skeleton() {
    let mut session = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick();
    assert!(session.tick().is_none());

    // A fresh client has seen no counts, so "only what moved" means nothing.
    let skeleton = parse(&session.skeleton_frame());
    assert_eq!(skeleton["nodes"].as_array().unwrap().len(), 5);

    let frame = parse(&session.tick().expect("resends everything"));
    assert_eq!(frame["edges"][0]["edgeId"], 1);
}

#[test]
fn changing_granularity_voids_what_the_ui_was_told() {
    // Edge ids at one level mean nothing at another, so the tracker's memory is
    // not just stale, it is about a different graph.
    let mut session = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick();

    session.set_level(node_kind::CALL_SITE);
    let frame = parse(&session.tick().expect("resends at the new level"));

    // Same flow, call-site edge this time.
    assert_eq!(frame["edges"][0]["edgeId"], 2);
}

#[test]
fn setting_the_same_level_twice_changes_nothing() {
    let mut session = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick();

    session.set_level(node_kind::FILE);

    assert!(session.tick().is_none());
}

#[test]
fn applies_the_element_ceiling_before_sending() {
    let mut session = Session::new(skeleton()).with_element_cap(0);
    session.connect(AGENT);

    session.feed(AGENT, &fixture("stream.bin"));

    assert!(session.rollup().edges.is_empty());
    assert_eq!(session.rollup().elements(), 0);
}

#[test]
fn a_new_skeleton_voids_the_old_counts() {
    let mut session = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick();

    session.set_skeleton(skeleton());

    assert!(session.tick().is_some());
}

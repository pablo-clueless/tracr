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

/// A session with one agent connection and one viewer already attached.
fn session() -> (Session, u32) {
    let mut session = Session::new(skeleton());
    session.connect(AGENT);
    let sub = session.subscribe();
    (session, sub)
}

fn parse(json: &str) -> Value {
    serde_json::from_str(json).expect("emitted a frame the UI could not parse")
}

#[test]
fn folds_a_js_agent_stream_into_a_ui_frame() {
    let (mut session, sub) = session();

    // stream.bin is a hello and a batch, each length-prefixed.
    session.feed(AGENT, &fixture("stream.bin"));
    let frame = parse(&session.tick(sub).expect("something moved"));

    assert_eq!(frame["edges"][0]["edgeId"], 1);
    assert_eq!(frame["edges"][0]["count"], 1);
    assert_eq!(frame["sinks"][0]["nodeId"], 2);
    // The batch's Dropped event carries u32::MAX.
    assert_eq!(frame["droppedTotal"], 4_294_967_295u64);
}

#[test]
fn reassembles_a_stream_delivered_one_byte_at_a_time() {
    // A socket read boundary has nothing to do with a frame boundary.
    let (mut session, sub) = session();

    for byte in fixture("stream.bin") {
        session.feed(AGENT, &[byte]);
    }

    let frame = parse(&session.tick(sub).expect("something moved"));
    assert_eq!(frame["edges"][0]["edgeId"], 1);
    assert_eq!(session.stats().accepted, 2);
}

#[test]
fn refuses_to_fold_events_that_arrive_before_a_hello() {
    // Without a hello there is no label space, so the labels cannot be
    // translated and folding them would merge unrelated provenance.
    let (mut session, _sub) = session();

    session.feed_frame(AGENT, &fixture("batch.bin"));

    assert_eq!(session.stats().before_hello, 1);
    assert_eq!(session.stats().accepted, 0);
    assert_eq!(session.core().footprint().dag_nodes, 0);
}

#[test]
fn accepts_the_same_batch_once_the_hello_lands() {
    let (mut session, _sub) = session();

    session.feed_frame(AGENT, &fixture("hello.bin"));
    session.feed_frame(AGENT, &fixture("batch.bin"));

    assert_eq!(session.stats().accepted, 2);
    assert_eq!(session.stats().before_hello, 0);
    assert!(session.core().footprint().dag_nodes > 0);
}

#[test]
fn stays_quiet_on_a_tick_where_nothing_moved() {
    let (mut session, sub) = session();
    session.feed(AGENT, &fixture("stream.bin"));

    assert!(session.tick(sub).is_some());
    // An idle app must not cost the UI a parse and a layout pass.
    assert!(session.tick(sub).is_none());
}

#[test]
fn speaks_up_when_only_a_counter_moved() {
    // No edge changed, but the agent admitted losing 9001 events. Silence here
    // would leave the UI showing a graph it has no reason to distrust.
    let (mut session, sub) = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick(sub);

    session.feed_frame(AGENT, &fixture("dropped-only.bin"));
    let frame = parse(&session.tick(sub).expect("the dropped total moved"));

    assert!(frame["edges"].as_array().unwrap().is_empty());
    assert_eq!(frame["droppedTotal"], 4_294_967_295u64 + 9001);
}

#[test]
fn counts_a_malformed_frame_and_keeps_going() {
    let (mut session, _sub) = session();
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
    let (mut session, _sub) = session();
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
    let (mut session, sub) = session();
    session.connect(2);

    session.feed(AGENT, &fixture("stream.bin"));
    session.feed(2, &fixture("stream.bin"));

    let frame = parse(&session.tick(sub).expect("something moved"));
    assert_eq!(frame["edges"][0]["count"], 2);
}

#[test]
fn keeps_provenance_after_the_connection_that_reported_it_drops() {
    // A run-wide graph outlives the process that fed it; otherwise closing a
    // browser tab would erase what it showed.
    let (mut session, _sub) = session();
    session.feed(AGENT, &fixture("stream.bin"));
    let before = session.core().footprint().dag_nodes;

    session.disconnect(AGENT);

    assert_eq!(session.connection_count(), 0);
    assert_eq!(session.core().footprint().dag_nodes, before);
}

#[test]
fn resends_in_full_after_a_client_takes_the_skeleton() {
    let (mut session, sub) = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick(sub);
    assert!(session.tick(sub).is_none());

    // A fresh client has seen no counts, so "only what moved" means nothing.
    let skeleton = parse(&session.skeleton_frame(sub));
    assert_eq!(skeleton["nodes"].as_array().unwrap().len(), 5);

    let frame = parse(&session.tick(sub).expect("resends everything"));
    assert_eq!(frame["edges"][0]["edgeId"], 1);
}

#[test]
fn changing_granularity_voids_what_the_ui_was_told() {
    // Edge ids at one level mean nothing at another, so the tracker's memory is
    // not just stale, it is about a different graph.
    let (mut session, sub) = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick(sub);

    session.set_level(sub, node_kind::CALL_SITE);
    let frame = parse(&session.tick(sub).expect("resends at the new level"));

    // Same flow, call-site edge this time.
    assert_eq!(frame["edges"][0]["edgeId"], 2);
}

#[test]
fn setting_the_same_level_twice_changes_nothing() {
    let (mut session, sub) = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick(sub);

    session.set_level(sub, node_kind::FILE);

    assert!(session.tick(sub).is_none());
}

#[test]
fn applies_the_element_ceiling_before_sending() {
    let mut session = Session::new(skeleton()).with_element_cap(0);
    session.connect(AGENT);

    session.feed(AGENT, &fixture("stream.bin"));

    assert!(session.rollup(node_kind::FILE).edges.is_empty());
    assert_eq!(session.rollup(node_kind::FILE).elements(), 0);
}

#[test]
fn a_new_skeleton_voids_the_old_counts() {
    let (mut session, sub) = session();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick(sub);

    session.set_skeleton(skeleton());

    assert!(session.tick(sub).is_some());
}

#[test]
fn gives_every_viewer_the_full_picture() {
    // With one shared tracker the first viewer to tick consumed the change and
    // the second saw nothing, so two open tabs each showed half a graph.
    let (mut session, first) = session();
    let second = session.subscribe();
    session.feed(AGENT, &fixture("stream.bin"));

    let a = parse(&session.tick(first).expect("first viewer sees it"));
    let b = parse(&session.tick(second).expect("second viewer sees it too"));

    assert_eq!(a["edges"][0]["edgeId"], 1);
    assert_eq!(b["edges"][0]["edgeId"], 1);
    assert_eq!(a["edges"][0]["count"], b["edges"][0]["count"]);
}

#[test]
fn lets_two_viewers_hold_different_granularities() {
    let (mut session, file_view) = session();
    let call_view = session.subscribe();
    session.set_level(call_view, node_kind::CALL_SITE);
    session.feed(AGENT, &fixture("stream.bin"));

    let coarse = parse(&session.tick(file_view).expect("file view"));
    let fine = parse(&session.tick(call_view).expect("call view"));

    assert_eq!(coarse["edges"][0]["edgeId"], 1);
    assert_eq!(fine["edges"][0]["edgeId"], 2);
    assert_eq!(session.level(file_view), Some(node_kind::FILE));
    assert_eq!(session.level(call_view), Some(node_kind::CALL_SITE));
}

#[test]
fn one_viewer_leaving_does_not_disturb_another() {
    let (mut session, staying) = session();
    let leaving = session.subscribe();
    session.feed(AGENT, &fixture("stream.bin"));
    session.tick(staying);

    session.unsubscribe(leaving);

    assert_eq!(session.subscriber_count(), 1);
    assert!(session.tick(staying).is_none());
}

#[test]
fn a_tick_for_a_viewer_that_never_subscribed_is_silent() {
    let (mut session, _sub) = session();
    session.feed(AGENT, &fixture("stream.bin"));

    assert!(session.tick(9999).is_none());
}

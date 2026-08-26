//! The core -> UI frames, checked against the shapes `@tracr/protocol` declares.
//!
//! These assert on parsed JSON rather than on strings: field order is serde's
//! business, and a test that pins it would break on a harmless reordering while
//! still missing a renamed field.

use serde_json::Value;

use tracr_core::aggregate::{roll_up, DeltaTracker};
use tracr_core::emit::{encode_delta, encode_skeleton, update_tag};
use tracr_core::ingest::SinkHit;
use tracr_core::skeleton::{node_kind, NodeId, Skeleton, SkeletonEdge, SkeletonNode};

fn node(
    id: NodeId,
    kind: u8,
    label: &str,
    parent: Option<NodeId>,
    site: Option<u32>,
) -> SkeletonNode {
    SkeletonNode {
        id,
        kind,
        label: label.into(),
        parent,
        site,
    }
}

fn skeleton() -> Skeleton {
    Skeleton::new(
        vec![
            node(1, node_kind::FILE, "src/routes.ts", None, None),
            node(2, node_kind::FILE, "src/db.ts", None, None),
            node(30, node_kind::CALL_SITE, "readBody", Some(1), Some(1000)),
            node(40, node_kind::CALL_SITE, "execute", Some(2), Some(2000)),
        ],
        vec![
            SkeletonEdge {
                id: 4,
                source: 1,
                target: 2,
            },
            SkeletonEdge {
                id: 5,
                source: 30,
                target: 40,
            },
        ],
    )
}

fn parse(json: &str) -> Value {
    serde_json::from_str(json).expect("emitted a frame the UI could not parse")
}

#[test]
fn sends_the_skeleton_under_its_own_tag() {
    let frame = parse(&encode_skeleton(&skeleton()));

    assert_eq!(frame["tag"], update_tag::SKELETON);
    assert_eq!(frame["nodes"].as_array().unwrap().len(), 4);
    assert_eq!(frame["edges"].as_array().unwrap().len(), 2);
}

#[test]
fn names_skeleton_fields_the_way_the_ui_types_do() {
    let frame = parse(&encode_skeleton(&skeleton()));
    let call = &frame["nodes"][2];

    assert_eq!(call["id"], 30);
    assert_eq!(call["kind"], node_kind::CALL_SITE);
    assert_eq!(call["label"], "readBody");
    assert_eq!(call["parent"], 1);
    // camelCase, matching SkeletonNode in @tracr/protocol.
    assert_eq!(call["siteId"], 1000);
}

#[test]
fn sends_a_missing_parent_or_site_as_null() {
    // A file has no parent and no site of its own. `null` is what the UI's
    // `number | null` expects; omitting the key would read as undefined.
    let frame = parse(&encode_skeleton(&skeleton()));
    let file = &frame["nodes"][0];

    assert!(file["parent"].is_null());
    assert!(file["siteId"].is_null());
}

#[test]
fn escapes_a_label_that_would_otherwise_corrupt_the_frame() {
    // Windows paths are the everyday case; the quote and newline are the ones
    // that would silently truncate a hand-rolled writer's output.
    let hostile = Skeleton::new(
        vec![node(
            1,
            node_kind::FILE,
            r#"src\routes"weird".ts"#,
            None,
            None,
        )],
        vec![],
    );

    let frame = parse(&encode_skeleton(&hostile));

    assert_eq!(frame["nodes"][0]["label"], r#"src\routes"weird".ts"#);
}

#[test]
fn survives_a_label_with_a_newline_and_a_tab() {
    let hostile = Skeleton::new(
        vec![node(1, node_kind::FUNCTION, "odd\n\tname", None, Some(1))],
        vec![],
    );

    let frame = parse(&encode_skeleton(&hostile));

    assert_eq!(frame["nodes"][0]["label"], "odd\n\tname");
}

#[test]
fn sends_an_empty_skeleton_without_choking() {
    let frame = parse(&encode_skeleton(&Skeleton::default()));

    assert_eq!(frame["tag"], update_tag::SKELETON);
    assert!(frame["nodes"].as_array().unwrap().is_empty());
}

#[test]
fn sends_a_delta_under_its_own_tag() {
    let skeleton = skeleton();
    let mut tracker = DeltaTracker::new();
    let rollup = roll_up(&skeleton, &[((1000, 2000), 5)], &[], node_kind::FILE);

    let frame = parse(&encode_delta(&tracker.diff(&rollup, 0)));

    assert_eq!(frame["tag"], update_tag::DELTA);
    assert_eq!(frame["edges"][0]["edgeId"], 4);
    assert_eq!(frame["edges"][0]["count"], 5);
    assert_eq!(frame["edges"][0]["tainted"], true);
}

#[test]
fn carries_every_bucket_the_rollup_classified() {
    let skeleton = skeleton();
    let mut tracker = DeltaTracker::new();
    let flows = [
        ((1000, 2000), 5), // declared file edge
        ((2000, 1000), 3), // no declared edge in that direction
        ((9999, 2000), 6), // unknown site
    ];
    let sinks = [SinkHit {
        site: 2000,
        sink_id: 1,
        count: 40,
        label: 1,
    }];

    let rollup = roll_up(&skeleton, &flows, &sinks, node_kind::FILE);
    let frame = parse(&encode_delta(&tracker.diff(&rollup, 12)));

    assert_eq!(frame["unmapped"][0]["source"], 2);
    assert_eq!(frame["unmapped"][0]["target"], 1);
    assert_eq!(frame["unmapped"][0]["count"], 3);

    assert_eq!(frame["sinks"][0]["nodeId"], 2);
    assert_eq!(frame["sinks"][0]["sites"], 1);
    assert_eq!(frame["sinks"][0]["count"], 40);

    assert_eq!(frame["droppedTotal"], 12);
    assert_eq!(frame["unresolved"], 6);
}

#[test]
fn reports_movement_that_never_left_a_module() {
    let skeleton = skeleton();
    let mut tracker = DeltaTracker::new();
    // Both call sites live in routes.ts, so at file level this is internal.
    let rollup = roll_up(&skeleton, &[((1000, 1000), 9)], &[], node_kind::FILE);

    let frame = parse(&encode_delta(&tracker.diff(&rollup, 0)));

    assert_eq!(frame["internal"][0]["nodeId"], 1);
    assert_eq!(frame["internal"][0]["count"], 9);
    assert!(frame["edges"].as_array().unwrap().is_empty());
}

#[test]
fn sends_empty_arrays_rather_than_omitting_them() {
    // The UI iterates every bucket unconditionally; a missing key would throw.
    let frame = parse(&encode_delta(&Default::default()));

    for bucket in ["edges", "unmapped", "internal", "sinks"] {
        assert!(
            frame[bucket].as_array().is_some_and(|list| list.is_empty()),
            "{bucket} was not an empty array"
        );
    }
    assert_eq!(frame["droppedTotal"], 0);
}

//! Rolling site-level flows up onto the skeleton, and the deltas that follow.
//!
//! The invariant these lean on hardest: aggregation classifies every flow it is
//! handed, it never discards one. An edge count that quietly disagrees with the
//! events behind it is worse than no graph at all.

use tracr_core::aggregate::{roll_up, DeltaTracker, EdgeCount, Rollup, Totals, UnmappedFlow};
use tracr_core::ingest::SinkHit;
use tracr_core::skeleton::{node_kind, EdgeId, NodeId, Skeleton, SkeletonEdge, SkeletonNode};

/// Two files, a handler that calls into a db module.
///
/// ```text
/// routes.ts (1) ── handler (10) ── readBody  (30) site 1000
///                              └── toQuery   (31) site 1001
/// db.ts     (2) ── query   (20) ── execute   (40) site 2000
/// ```
///
/// The static parse emits edges at every level, so the same flow resolves to a
/// different edge depending on what the UI is rendering.
fn skeleton() -> Skeleton {
    let file = |id: NodeId, label: &str| SkeletonNode {
        id,
        kind: node_kind::FILE,
        label: label.into(),
        parent: None,
        site: None,
    };
    let function = |id: NodeId, label: &str, parent: NodeId, site: u32| SkeletonNode {
        id,
        kind: node_kind::FUNCTION,
        label: label.into(),
        parent: Some(parent),
        site: Some(site),
    };
    let call = |id: NodeId, label: &str, parent: NodeId, site: u32| SkeletonNode {
        id,
        kind: node_kind::CALL_SITE,
        label: label.into(),
        parent: Some(parent),
        site: Some(site),
    };
    let edge = |id: EdgeId, source: NodeId, target: NodeId| SkeletonEdge { id, source, target };

    Skeleton::new(
        vec![
            file(1, "src/routes.ts"),
            file(2, "src/db.ts"),
            function(10, "handler", 1, 100),
            function(20, "query", 2, 200),
            call(30, "readBody", 10, 1000),
            call(31, "toQuery", 10, 1001),
            call(40, "execute", 20, 2000),
        ],
        vec![
            edge(1, 30, 31),
            edge(2, 31, 40),
            edge(3, 10, 20),
            edge(4, 1, 2),
        ],
    )
}

fn totals(dropped: u64) -> Totals {
    Totals {
        dropped,
        truncated: 0,
    }
}

fn sink(site: u32, sink_id: u32, count: u64) -> SinkHit {
    SinkHit {
        site,
        sink_id,
        count,
        label: 1,
    }
}

#[test]
fn resolves_a_call_site_all_the_way_up_to_its_file() {
    let skeleton = skeleton();

    assert_eq!(skeleton.resolve(1000, node_kind::CALL_SITE), Some(30));
    assert_eq!(skeleton.resolve(1000, node_kind::FUNCTION), Some(10));
    assert_eq!(skeleton.resolve(1000, node_kind::FILE), Some(1));
}

#[test]
fn lifting_a_node_to_its_own_kind_is_the_node() {
    let skeleton = skeleton();

    assert_eq!(skeleton.lift(1, node_kind::FILE), Some(1));
}

#[test]
fn refuses_to_walk_a_cyclic_parent_chain_forever() {
    // A parser bug, not a protocol one. Degrading to "unresolved" beats hanging.
    let looped = |id: NodeId, parent: NodeId| SkeletonNode {
        id,
        kind: node_kind::CALL_SITE,
        label: "looped".into(),
        parent: Some(parent),
        site: Some(id),
    };
    let skeleton = Skeleton::new(vec![looped(1, 2), looped(2, 1)], vec![]);

    assert_eq!(skeleton.lift(1, node_kind::FILE), None);
}

#[test]
fn collapses_a_call_site_flow_into_one_module_edge() {
    let skeleton = skeleton();
    let flows = [((1001, 2000), 5)];

    let fine = roll_up(&skeleton, &flows, &[], node_kind::CALL_SITE);
    assert_eq!(fine.edges, vec![EdgeCount { edge: 2, count: 5 }]);

    let coarse = roll_up(&skeleton, &flows, &[], node_kind::FILE);
    assert_eq!(coarse.edges, vec![EdgeCount { edge: 4, count: 5 }]);
}

#[test]
fn sums_distinct_call_sites_onto_the_edge_they_share() {
    let skeleton = skeleton();
    // Two call sites in routes.ts, both reaching db.ts. One module edge.
    let flows = [((1000, 2000), 3), ((1001, 2000), 4)];

    let rollup = roll_up(&skeleton, &flows, &[], node_kind::FILE);

    assert_eq!(rollup.edges, vec![EdgeCount { edge: 4, count: 7 }]);
}

#[test]
fn counts_a_flow_that_never_leaves_the_module_as_internal() {
    let skeleton = skeleton();
    let flows = [((1000, 1001), 9)];

    let rollup = roll_up(&skeleton, &flows, &[], node_kind::FILE);

    assert!(rollup.edges.is_empty());
    assert_eq!(rollup.internal, vec![(1, 9)]);
}

#[test]
fn reports_a_crossing_the_static_parse_never_predicted() {
    let skeleton = skeleton();
    // readBody straight into db.ts: no declared edge between those call sites.
    let flows = [((1000, 2000), 2)];

    let rollup = roll_up(&skeleton, &flows, &[], node_kind::CALL_SITE);

    assert!(rollup.edges.is_empty());
    assert_eq!(
        rollup.unmapped,
        vec![UnmappedFlow {
            source: 30,
            target: 40,
            count: 2
        }]
    );
}

#[test]
fn reports_a_site_the_skeleton_has_never_heard_of() {
    let skeleton = skeleton();
    let flows = [((9999, 2000), 6), ((1001, 8888), 1)];

    let rollup = roll_up(&skeleton, &flows, &[], node_kind::FILE);

    assert!(rollup.edges.is_empty());
    assert_eq!(rollup.unresolved, 7);
}

#[test]
fn accounts_for_every_flow_it_was_handed() {
    let skeleton = skeleton();
    let flows = [
        ((1001, 2000), 5), // a declared edge
        ((1000, 1001), 9), // internal to routes.ts
        ((1000, 2000), 2), // real nodes, undeclared crossing
        ((9999, 2000), 6), // unknown site
    ];

    for kind in [node_kind::CALL_SITE, node_kind::FUNCTION, node_kind::FILE] {
        let rollup = roll_up(&skeleton, &flows, &[], kind);
        assert_eq!(rollup.total(), 22, "kind {kind} lost or invented flows");
    }
}

#[test]
fn rolls_sink_hits_up_to_the_node_being_rendered() {
    let skeleton = skeleton();
    let sinks = [sink(2000, 1, 40), sink(2000, 2, 2), sink(1001, 1, 5)];

    let rollup = roll_up(&skeleton, &[], &sinks, node_kind::FILE);

    let db = rollup.sinks.iter().find(|s| s.node == 2).unwrap();
    assert_eq!((db.sites, db.count), (2, 42));

    let routes = rollup.sinks.iter().find(|s| s.node == 1).unwrap();
    assert_eq!((routes.sites, routes.count), (1, 5));
}

#[test]
fn drops_a_sink_hit_whose_site_is_not_in_the_skeleton() {
    let skeleton = skeleton();

    let rollup = roll_up(&skeleton, &[], &[sink(7777, 1, 3)], node_kind::FILE);

    assert!(rollup.sinks.is_empty());
}

#[test]
fn caps_the_graph_to_the_heaviest_edges() {
    let mut rollup = Rollup {
        edges: vec![
            EdgeCount { edge: 1, count: 10 },
            EdgeCount { edge: 2, count: 90 },
            EdgeCount { edge: 3, count: 50 },
            EdgeCount { edge: 4, count: 1 },
        ],
        ..Rollup::default()
    };

    rollup.cap_edges(2);

    // Heaviest two survive, and they come back in id order for a stable diff.
    assert_eq!(
        rollup.edges,
        vec![
            EdgeCount { edge: 2, count: 90 },
            EdgeCount { edge: 3, count: 50 },
        ]
    );
    assert_eq!(rollup.elements(), 2);
}

#[test]
fn leaves_a_graph_under_the_ceiling_alone() {
    let mut rollup = Rollup {
        edges: vec![EdgeCount { edge: 1, count: 10 }],
        ..Rollup::default()
    };

    rollup.cap_edges(2000);

    assert_eq!(rollup.edges.len(), 1);
}

#[test]
fn emits_only_the_edges_whose_counts_moved() {
    let skeleton = skeleton();
    let mut tracker = DeltaTracker::new();

    let first = roll_up(&skeleton, &[((1001, 2000), 5)], &[], node_kind::FILE);
    let delta = tracker.diff(&first, totals(0));
    assert_eq!(delta.edges.len(), 1);
    assert_eq!(delta.edges[0].count, 5);
    assert!(delta.edges[0].tainted);

    // Same counts again: the UI already has this, so say nothing.
    assert!(tracker.diff(&first, totals(0)).is_empty());

    let second = roll_up(&skeleton, &[((1001, 2000), 8)], &[], node_kind::FILE);
    let delta = tracker.diff(&second, totals(0));
    assert_eq!(delta.edges.len(), 1);
    assert_eq!(delta.edges[0].count, 8);
}

#[test]
fn carries_undeclared_crossings_and_internals_through_the_delta() {
    let skeleton = skeleton();
    let mut tracker = DeltaTracker::new();
    // A value re-derived at the site it came from stays inside that node.
    let flows = [((1000, 2000), 2), ((1000, 1000), 9)];

    let delta = tracker.diff(
        &roll_up(&skeleton, &flows, &[sink(2000, 1, 4)], node_kind::CALL_SITE),
        totals(0),
    );

    assert_eq!(
        delta.unmapped,
        vec![UnmappedFlow {
            source: 30,
            target: 40,
            count: 2
        }]
    );
    assert_eq!(delta.internal, vec![(30, 9)]);
    assert_eq!(delta.sinks.len(), 1);
    assert!(!delta.is_empty());

    // Nothing moved on the second pass, so nothing is worth a UI wakeup.
    let repeat = tracker.diff(
        &roll_up(&skeleton, &flows, &[sink(2000, 1, 4)], node_kind::CALL_SITE),
        totals(0),
    );
    assert!(repeat.is_empty());
}

#[test]
fn stays_quiet_about_an_edge_that_got_capped_out_of_a_frame() {
    // Absence means "not in this frame", never "reset to zero" — emitting a
    // zero here would make a busy edge blink off in the UI.
    let mut tracker = DeltaTracker::new();

    let full = Rollup {
        edges: vec![
            EdgeCount { edge: 1, count: 10 },
            EdgeCount { edge: 2, count: 90 },
        ],
        ..Rollup::default()
    };
    assert_eq!(tracker.diff(&full, totals(0)).edges.len(), 2);

    let capped = Rollup {
        edges: vec![EdgeCount { edge: 2, count: 90 }],
        ..Rollup::default()
    };
    assert!(tracker.diff(&capped, totals(0)).edges.is_empty());
}

#[test]
fn reports_running_totals_rather_than_increments() {
    // dropped and unresolved are counters a person reads, not diffs.
    let skeleton = skeleton();
    let mut tracker = DeltaTracker::new();
    let rollup = roll_up(&skeleton, &[((9999, 2000), 6)], &[], node_kind::FILE);

    let delta = tracker.diff(&rollup, totals(12));

    assert_eq!(delta.dropped_total, 12);
    assert_eq!(delta.unresolved, 6);
    assert_eq!(tracker.totals().dropped, 12);
}

#[test]
fn resends_everything_after_a_client_reconnects() {
    let skeleton = skeleton();
    let mut tracker = DeltaTracker::new();
    let rollup = roll_up(&skeleton, &[((1001, 2000), 5)], &[], node_kind::FILE);

    tracker.diff(&rollup, totals(0));
    assert!(tracker.diff(&rollup, totals(0)).is_empty());

    tracker.reset();

    assert_eq!(tracker.diff(&rollup, totals(0)).edges.len(), 1);
}

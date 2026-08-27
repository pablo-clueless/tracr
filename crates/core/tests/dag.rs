//! The depth cap, which is what makes the DAG survive a run that never ends.
//!
//! Hash-consing bounds a loop that redoes the same derivation. It does nothing
//! for one that extends a derivation — `acc = acc + item` interns a new node
//! every iteration, because `acc`'s label moves and the parents differ. These
//! hold the line on that case without giving up precision on ordinary chains.

use tracr_core::dag::{Dag, Node, DEFAULT_MAX_DEPTH};
use tracr_core::{TRUNCATED, UNTAINTED};

fn origin(source_id: u32, site_id: u32) -> Node {
    Node::Origin { source_id, site_id }
}

fn combine(site_id: u32, parents: Vec<u32>) -> Node {
    Node::Combine {
        op: 0,
        site_id,
        parents,
    }
}

#[test]
fn an_origin_starts_the_chain_at_depth_one() {
    let mut dag = Dag::new();

    let label = dag.intern(origin(1, 10));

    assert_eq!(dag.depth(label), 1);
}

#[test]
fn a_combine_is_one_deeper_than_its_deepest_parent() {
    let mut dag = Dag::new();
    let shallow = dag.intern(origin(1, 10));
    let deeper = dag.intern(combine(11, vec![shallow]));

    let joined = dag.intern(combine(12, vec![shallow, deeper]));

    assert_eq!(dag.depth(deeper), 2);
    assert_eq!(dag.depth(joined), 3);
}

#[test]
fn untainted_parents_add_no_depth() {
    let mut dag = Dag::new();

    let label = dag.intern(combine(10, vec![UNTAINTED, UNTAINTED]));

    assert_eq!(dag.depth(label), 1);
}

#[test]
fn keeps_interning_right_up_to_the_cap() {
    let mut dag = Dag::with_max_depth(4);
    let mut label = dag.intern(origin(1, 10));

    for _ in 0..3 {
        label = dag.intern(combine(11, vec![label]));
    }

    // Origin plus three combines is exactly four deep: still a real node.
    assert_eq!(dag.depth(label), 4);
    assert_ne!(label, TRUNCATED);
    assert_eq!(dag.len(), 4);
    assert_eq!(dag.truncated(), 0);
}

#[test]
fn refuses_the_node_that_would_run_past_the_cap() {
    let mut dag = Dag::with_max_depth(4);
    let mut label = dag.intern(origin(1, 10));
    for _ in 0..3 {
        label = dag.intern(combine(11, vec![label]));
    }

    let over = dag.intern(combine(11, vec![label]));

    assert_eq!(over, TRUNCATED);
    // Refused, not stored: this is the whole point.
    assert_eq!(dag.len(), 4);
    assert_eq!(dag.truncated(), 1);
}

#[test]
fn a_truncated_parent_truncates_its_children() {
    // Otherwise the chain would restart at depth 1 and grow again forever.
    let mut dag = Dag::with_max_depth(2);

    let child = dag.intern(combine(11, vec![TRUNCATED]));

    assert_eq!(child, TRUNCATED);
    assert_eq!(dag.len(), 0);
}

#[test]
fn truncated_is_not_untainted() {
    // The two reserved labels are opposite answers. Collapsing them would let a
    // sink report clean for a value that is dirty with no recorded history.
    assert_ne!(TRUNCATED, UNTAINTED);

    let dag = Dag::new();

    assert_eq!(dag.get(UNTAINTED), None);
    assert_eq!(dag.get(TRUNCATED), None);
    assert_eq!(dag.depth(UNTAINTED), 0);
    assert_eq!(dag.depth(TRUNCATED), dag.max_depth());
}

#[test]
fn an_accumulator_loop_reaches_a_fixed_ceiling() {
    // The measured failure: before the cap this grew one node per iteration,
    // 50k iterations giving 50,002 nodes. This is the regression test for it.
    let mut dag = Dag::with_max_depth(DEFAULT_MAX_DEPTH);
    let item = dag.intern(origin(1, 10));
    let mut acc = dag.intern(combine(11, vec![item]));

    for _ in 0..50_000 {
        acc = dag.intern(combine(11, vec![acc, item]));
    }

    assert_eq!(acc, TRUNCATED);
    assert!(
        dag.len() <= DEFAULT_MAX_DEPTH as usize + 1,
        "chain kept growing: {} nodes",
        dag.len()
    );
    // It stopped extending, and it says how often it refused.
    assert!(dag.truncated() > 49_000);
}

#[test]
fn a_wide_shallow_graph_is_untouched_by_the_cap() {
    // Breadth is not the pathology; only depth is. A thousand sibling
    // derivations from one source must all keep full lineage.
    let mut dag = Dag::with_max_depth(4);
    let source = dag.intern(origin(1, 10));

    for site in 0..1_000 {
        let label = dag.intern(combine(site, vec![source]));
        assert_ne!(label, TRUNCATED);
    }

    assert_eq!(dag.len(), 1_001);
    assert_eq!(dag.truncated(), 0);
}

#[test]
fn still_dedupes_a_repeated_derivation() {
    let mut dag = Dag::new();
    let source = dag.intern(origin(1, 10));

    let first = dag.intern(combine(11, vec![source]));
    let again = dag.intern(combine(11, vec![source]));

    assert_eq!(first, again);
    assert_eq!(dag.len(), 2);
}

#[test]
fn depth_is_not_part_of_a_nodes_identity() {
    // Two paths to the same (op, site, parents) must land on one label, which
    // only holds because depth is derived from parents rather than stored in
    // the hash key.
    let mut dag = Dag::new();
    let source = dag.intern(origin(1, 10));
    let node = combine(11, vec![source]);

    let first = dag.intern(node.clone());
    let second = dag.intern(node);

    assert_eq!(first, second);
    assert_eq!(dag.depth(first), dag.depth(second));
}

#[test]
fn walks_a_derivation_back_to_its_source() {
    // The product's whole claim, at the level that implements it.
    let mut dag = Dag::new();
    let source = dag.intern(origin(1, 10));
    let trimmed = dag.intern(combine(11, vec![source]));
    let formatted = dag.intern(combine(12, vec![trimmed]));

    let lineage = dag.lineage(formatted, 64);

    assert_eq!(lineage.steps, vec![source, trimmed, formatted]);
    assert!(!lineage.truncated);
}

#[test]
fn puts_the_origin_first_however_the_graph_was_built() {
    // A person reads a chain forwards: source, then what happened to it.
    let mut dag = Dag::new();
    let left = dag.intern(origin(1, 10));
    let right = dag.intern(origin(2, 20));
    let joined = dag.intern(combine(30, vec![left, right]));

    let lineage = dag.lineage(joined, 64);

    assert_eq!(lineage.steps.last(), Some(&joined));
    assert_eq!(dag.depth(lineage.steps[0]), 1);
}

#[test]
fn visits_a_shared_ancestor_once() {
    // Structural sharing is the point of hash-consing; a diamond must not make
    // the same step appear twice in the chain.
    let mut dag = Dag::new();
    let source = dag.intern(origin(1, 10));
    let left = dag.intern(combine(11, vec![source]));
    let right = dag.intern(combine(12, vec![source]));
    let joined = dag.intern(combine(13, vec![left, right]));

    let lineage = dag.lineage(joined, 64);

    assert_eq!(lineage.steps.len(), 4);
    assert_eq!(lineage.steps.iter().filter(|&&s| s == source).count(), 1);
}

#[test]
fn says_a_truncated_label_has_no_recorded_history() {
    // Not the same as "no provenance": the value is tainted, the chain is gone.
    let dag = Dag::new();

    let lineage = dag.lineage(TRUNCATED, 64);

    assert!(lineage.steps.is_empty());
    assert!(lineage.truncated);
}

#[test]
fn an_untainted_label_has_no_chain_and_is_not_truncated() {
    let dag = Dag::new();

    let lineage = dag.lineage(UNTAINTED, 64);

    assert!(lineage.steps.is_empty());
    assert!(!lineage.truncated);
}

#[test]
fn admits_when_a_chain_was_too_wide_to_send() {
    let mut dag = Dag::new();
    let parents: Vec<u32> = (0..50).map(|i| dag.intern(origin(i, 10 + i))).collect();
    let joined = dag.intern(combine(99, parents));

    let lineage = dag.lineage(joined, 8);

    assert!(lineage.steps.len() <= 8);
    assert!(lineage.truncated);
}

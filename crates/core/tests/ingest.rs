//! Ingest behaviour, with an eye on the Phase 3 gate: bounded memory over a run
//! that never ends.

use tracr_core::dag::Node;
use tracr_core::ingest::{Agent, Core};
use tracr_core::wire::{Event, Frame, Hello};
use tracr_core::UNTAINTED;

fn hello(proc_id: u32) -> Hello {
    Hello {
        protocol_version: 1,
        run_id: 0,
        proc_id,
        language: "javascript".into(),
        platform: "node".into(),
    }
}

fn agent(proc_id: u32) -> Agent {
    Agent::new(hello(proc_id))
}

fn origin(label: u32, site: u32, source_id: u32) -> Event {
    Event::Origin {
        site,
        label,
        source_id,
    }
}

#[test]
fn interns_an_origin_and_remembers_the_translation() {
    let mut core = Core::new();
    let mut a = agent(1);

    core.apply(&mut a, origin(7, 42, 3));

    assert_eq!(core.dag.len(), 1);
    assert_eq!(
        core.dag.get(1),
        Some(&Node::Origin {
            source_id: 3,
            site_id: 42
        })
    );
    assert_eq!(a.mapped_labels(), 1);
}

#[test]
fn keeps_two_agents_label_spaces_apart() {
    // Both agents call it label 1; they mean completely different things.
    let mut core = Core::new();
    let mut a = agent(1);
    let mut b = agent(2);

    core.apply(&mut a, origin(1, 10, 0));
    core.apply(&mut b, origin(1, 20, 0));

    core.apply(
        &mut a,
        Event::Sink {
            site: 99,
            label: 1,
            sink_id: 0,
        },
    );

    // Two distinct sites means two distinct nodes, not one merged one.
    assert_eq!(core.dag.len(), 2);

    let hit = core.sinks().remove(0);
    assert_eq!(
        core.dag.get(hit.label),
        Some(&Node::Origin {
            source_id: 0,
            site_id: 10
        }),
        "the sink must resolve through agent a's map, not b's"
    );
}

#[test]
fn collapses_identical_provenance_from_different_agents() {
    // The point of hash-consing: a browser and a server deriving a value the
    // same way from the same site share one node.
    let mut core = Core::new();
    let mut a = agent(1);
    let mut b = agent(2);

    core.apply(&mut a, origin(1, 10, 0));
    core.apply(&mut b, origin(5, 10, 0));

    assert_eq!(core.dag.len(), 1);
}

#[test]
fn resolves_combine_parents_through_the_agent_map() {
    let mut core = Core::new();
    let mut a = agent(1);

    core.apply(&mut a, origin(1, 10, 0));
    core.apply(&mut a, origin(2, 11, 0));
    core.apply(
        &mut a,
        Event::Combine {
            site: 12,
            label: 3,
            op: 1,
            parents: vec![1, 2],
        },
    );

    assert_eq!(core.dag.len(), 3);
    let Some(Node::Combine { parents, .. }) = core.dag.get(3) else {
        panic!("expected a combine node");
    };
    // Compared as slices with an explicit element type: `&Vec<u32>` against an
    // inferred `&Vec<{integer}>` compiles, but reads as an error in the editor.
    assert_eq!(parents.as_slice(), [1u32, 2].as_slice());
}

#[test]
fn treats_a_label_whose_origin_was_dropped_as_untainted() {
    // The agent's ring buffer overflowed and the defining event never arrived.
    // Inventing a node here would fabricate provenance that never existed.
    let mut core = Core::new();
    let mut a = agent(1);

    core.apply(
        &mut a,
        Event::Combine {
            site: 12,
            label: 3,
            op: 1,
            parents: vec![404],
        },
    );

    assert_eq!(core.dag.len(), 0);

    core.apply(
        &mut a,
        Event::Sink {
            site: 99,
            label: 3,
            sink_id: 0,
        },
    );
    assert_eq!(core.sinks()[0].label, UNTAINTED);
}

#[test]
fn counts_drops_from_both_the_batch_header_and_the_event() {
    let mut core = Core::new();
    let mut a = agent(1);

    core.apply_frame(
        &mut a,
        Frame::Batch {
            events: vec![Event::Dropped { count: 5 }],
            dropped: 10,
        },
    );

    assert_eq!(core.dropped, 15);
}

#[test]
fn a_second_hello_resets_the_label_space() {
    // A reconnecting agent starts interning from scratch; keeping the old map
    // would translate its new labels into someone else's provenance.
    let mut core = Core::new();
    let mut a = agent(1);

    core.apply(&mut a, origin(1, 10, 0));
    assert_eq!(a.mapped_labels(), 1);

    core.apply_frame(&mut a, Frame::Hello(hello(1)));
    assert_eq!(a.mapped_labels(), 0);
}

#[test]
fn ignores_a_flow_carrying_nothing() {
    let mut core = Core::new();
    let mut a = agent(1);

    core.apply(
        &mut a,
        Event::Flow {
            from: 1,
            to: 2,
            label: UNTAINTED,
        },
    );

    assert!(core.flows().is_empty());
}

/// The Phase 3 gate, in miniature: a hot loop must not grow the core.
#[test]
fn a_repeating_workload_reaches_a_fixed_ceiling() {
    let mut core = Core::new();
    let mut a = agent(1);

    let replay = |core: &mut Core, a: &mut Agent| {
        core.apply(a, origin(1, 10, 0));
        core.apply(
            a,
            Event::Combine {
                site: 11,
                label: 2,
                op: 1,
                parents: vec![1],
            },
        );
        core.apply(
            a,
            Event::Flow {
                from: 10,
                to: 11,
                label: 2,
            },
        );
        core.apply(
            a,
            Event::Sink {
                site: 12,
                label: 2,
                sink_id: 0,
            },
        );
    };

    for _ in 0..100 {
        replay(&mut core, &mut a);
    }
    let after_100 = core.footprint();

    for _ in 0..100_000 {
        replay(&mut core, &mut a);
    }
    let after_100k = core.footprint();

    // A thousandfold more events, not one byte more topology.
    assert_eq!(after_100, after_100k);
    assert_eq!(after_100k.dag_nodes, 2);
    assert_eq!(after_100k.flow_edges, 1);
    assert_eq!(after_100k.sink_sites, 1);
    assert_eq!(a.mapped_labels(), 2);

    // The counts still went up: aggregation, not amnesia.
    assert_eq!(core.sinks()[0].count, 100_100);
    assert_eq!(core.flows()[0].1, 100_100);
}

#[test]
fn an_accumulating_loop_stops_growing_the_dag() {
    // Measured before the depth cap: 50k iterations of `acc = acc + item` grew
    // the DAG to 50,002 nodes, one per iteration, forever.
    let mut core = Core::new();
    let mut a = agent(1);

    core.apply(&mut a, origin(1, 10, 0));
    let mut acc = 2;
    core.apply(
        &mut a,
        Event::Combine {
            site: 11,
            label: acc,
            op: 0,
            parents: vec![1],
        },
    );

    for _ in 0..50_000 {
        let next = acc + 1;
        core.apply(
            &mut a,
            Event::Combine {
                site: 11,
                label: next,
                op: 0,
                parents: vec![acc, 1],
            },
        );
        acc = next;
    }

    let footprint = core.footprint();
    assert!(
        footprint.dag_nodes < 100,
        "dag kept growing: {} nodes",
        footprint.dag_nodes
    );
    assert!(footprint.truncated > 49_000);
}

#[test]
fn a_saturated_value_stays_tainted_at_the_sink() {
    // The cap must not launder a value clean. Losing the chain is acceptable;
    // reporting a dirty value as untainted is not.
    let mut core = Core::new();
    let mut a = agent(1);
    let mut dag = tracr_core::dag::Dag::with_max_depth(2);
    std::mem::swap(&mut core.dag, &mut dag);

    core.apply(&mut a, origin(1, 10, 0));
    let mut acc = 2;
    core.apply(
        &mut a,
        Event::Combine {
            site: 11,
            label: acc,
            op: 0,
            parents: vec![1],
        },
    );
    for _ in 0..10 {
        let next = acc + 1;
        core.apply(
            &mut a,
            Event::Combine {
                site: 11,
                label: next,
                op: 0,
                parents: vec![acc, 1],
            },
        );
        acc = next;
    }

    core.apply(
        &mut a,
        Event::Sink {
            site: 12,
            label: acc,
            sink_id: 0,
        },
    );

    let hit = &core.sinks()[0];
    assert_eq!(hit.count, 1);
    assert_eq!(hit.label, tracr_core::TRUNCATED);
    assert_ne!(hit.label, UNTAINTED);
}

#[test]
fn an_accumulating_loop_stops_growing_the_label_map() {
    // The depth cap bounded the DAG but moved the leak here: measured at 64 DAG
    // nodes and 50,002 map entries. This is the regression test for the second
    // half.
    let mut core = Core::new();
    let mut a = Agent::with_capacity(hello(1), 64);

    core.apply(&mut a, origin(1, 10, 0));
    let mut acc = 2;
    core.apply(
        &mut a,
        Event::Combine {
            site: 11,
            label: acc,
            op: 0,
            parents: vec![1],
        },
    );

    for _ in 0..50_000 {
        let next = acc + 1;
        core.apply(
            &mut a,
            Event::Combine {
                site: 11,
                label: next,
                op: 0,
                parents: vec![acc, 1],
            },
        );
        acc = next;
    }

    // Two generations live at once, so the ceiling is twice the capacity.
    assert!(
        a.mapped_labels() <= 128,
        "label map kept growing: {}",
        a.mapped_labels()
    );
    assert!(core.footprint().dag_nodes < 100);
}

#[test]
fn a_label_still_in_use_survives_eviction() {
    // Reference locality is the whole argument for dropping the oldest
    // generation, so the case that would break it — an old label named long
    // after it was created — has to keep working.
    let mut core = Core::new();
    let mut a = Agent::with_capacity(hello(1), 4);

    core.apply(&mut a, origin(1, 10, 0));

    // Churn well past capacity, naming label 1 each time so it stays live.
    for i in 0..200 {
        core.apply(
            &mut a,
            Event::Combine {
                site: 11,
                label: 100 + i,
                op: 0,
                parents: vec![1],
            },
        );
    }

    core.apply(
        &mut a,
        Event::Sink {
            site: 12,
            label: 1,
            sink_id: 0,
        },
    );

    assert_ne!(core.sinks()[0].label, UNTAINTED);
    assert_eq!(a.misses(), 0);
}

#[test]
fn counts_a_label_it_could_not_translate() {
    // An evicted-but-live label reads as untainted, which is a false negative.
    // It cannot be detected after the fact, so it is counted instead.
    let mut core = Core::new();
    let mut a = agent(1);

    core.apply(
        &mut a,
        Event::Sink {
            site: 12,
            label: 999,
            sink_id: 0,
        },
    );

    assert_eq!(a.misses(), 1);
    assert_eq!(core.sinks()[0].label, UNTAINTED);
}

#[test]
fn an_untainted_operand_is_not_a_miss() {
    // Label 0 is the common case on every instrumented line. Counting it would
    // bury the real misses in noise.
    let mut core = Core::new();
    let mut a = agent(1);

    core.apply(
        &mut a,
        Event::Sink {
            site: 12,
            label: UNTAINTED,
            sink_id: 0,
        },
    );

    assert_eq!(a.misses(), 0);
}

//! Folding agent events into the core's own DAG.
//!
//! # Two label spaces
//!
//! An agent interns labels locally, so its label 3 and another agent's label 3
//! are unrelated. The core keeps one DAG for the whole run, which means every
//! incoming label has to be translated through a per-agent map before it can be
//! used. Skipping that step silently merges the provenance of unrelated
//! processes — and because both sides are just `u32`, nothing would ever throw.
//!
//! Hash-consing then does real work here: two agents that derive a value the
//! same way from the same site land on the *same* core label, so a browser and a
//! server that both hash a user id share one node.
//!
//! # Why this stays bounded
//!
//! Phase 3's gate is bounded memory over a long run, so nothing here grows per
//! event. Every structure is keyed on the static topology instead:
//!
//! - the DAG is keyed on `(op, site, parents)`, so a loop running a million
//!   times interns one node,
//! - flow edges are keyed on `(from, to)` site pairs and carry counts,
//! - sink hits are keyed on `(site, sink)` and keep a count plus the most recent
//!   label, which is what a provenance panel needs.
//!
//! Per-agent label maps are bounded by the number of distinct provenance shapes
//! the agent produced, not by how many events it sent, because the agent
//! hash-conses too.

use std::collections::HashMap;

use crate::dag::{Dag, Label, Node, SiteId};
use crate::wire::{Event, Frame, Hello};
use crate::UNTAINTED;

/// One sink, aggregated. A million hits on one line is one row with a count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SinkHit {
    pub site: SiteId,
    pub sink_id: u32,
    pub count: u64,
    /// Most recent label to arrive here — the chain a provenance panel shows.
    pub label: Label,
}

/// Per-connection state. Its own label space, its own translation table.
pub struct Agent {
    pub hello: Hello,
    remap: HashMap<Label, Label>,
}

impl Agent {
    pub fn new(hello: Hello) -> Self {
        Self {
            hello,
            remap: HashMap::new(),
        }
    }

    /// How many distinct agent labels have been seen. Bounded by the agent's own
    /// interning, so this is a memory ceiling worth asserting on.
    pub fn mapped_labels(&self) -> usize {
        self.remap.len()
    }

    fn translate(&self, label: Label) -> Label {
        if label == UNTAINTED {
            return UNTAINTED;
        }
        // An unknown label means its defining event was dropped by the agent's
        // ring buffer. Untainted is the honest answer: inventing a node would
        // fabricate provenance that never existed.
        self.remap.get(&label).copied().unwrap_or(UNTAINTED)
    }
}

#[derive(Default)]
pub struct Core {
    pub dag: Dag,
    /// Events the agents admit to discarding. Surfaced, never hidden.
    pub dropped: u64,
    flows: HashMap<(SiteId, SiteId), u64>,
    sinks: HashMap<(SiteId, u32), SinkHit>,
}

impl Core {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply_frame(&mut self, agent: &mut Agent, frame: Frame) {
        match frame {
            // A second hello on a live connection restarts the label space.
            Frame::Hello(hello) => {
                agent.hello = hello;
                agent.remap.clear();
            }
            Frame::Batch { events, dropped } => {
                self.dropped += dropped;
                for event in events {
                    self.apply(agent, event);
                }
            }
        }
    }

    pub fn apply(&mut self, agent: &mut Agent, event: Event) {
        match event {
            Event::Origin {
                site,
                label,
                source_id,
            } => {
                let core = self.dag.intern(Node::Origin {
                    source_id,
                    site_id: site,
                });
                agent.remap.insert(label, core);
            }

            Event::Combine {
                site,
                label,
                op,
                parents,
            } => {
                let parents: Vec<Label> = parents.iter().map(|&p| agent.translate(p)).collect();

                // Every parent lost means the derivation is unrecoverable, so
                // the result is untainted rather than a node with no lineage.
                if parents.iter().all(|&p| p == UNTAINTED) {
                    agent.remap.insert(label, UNTAINTED);
                    return;
                }

                let core = self.dag.intern(Node::Combine {
                    op,
                    site_id: site,
                    parents,
                });
                agent.remap.insert(label, core);
            }

            Event::Flow { from, to, label } => {
                if agent.translate(label) == UNTAINTED {
                    return;
                }
                *self.flows.entry((from, to)).or_insert(0) += 1;
            }

            Event::Sink {
                site,
                label,
                sink_id,
            } => {
                let core = agent.translate(label);
                let hit = self.sinks.entry((site, sink_id)).or_insert(SinkHit {
                    site,
                    sink_id,
                    count: 0,
                    label: UNTAINTED,
                });
                hit.count += 1;
                if core != UNTAINTED {
                    hit.label = core;
                }
            }

            Event::Dropped { count } => self.dropped += count,
        }
    }

    /// Aggregated sink hits, in a stable order so a delta diff is meaningful.
    pub fn sinks(&self) -> Vec<SinkHit> {
        let mut hits: Vec<SinkHit> = self.sinks.values().cloned().collect();
        hits.sort_by_key(|hit| (hit.site, hit.sink_id));
        hits
    }

    /// Aggregated flow edges, in a stable order.
    pub fn flows(&self) -> Vec<((SiteId, SiteId), u64)> {
        let mut edges: Vec<_> = self.flows.iter().map(|(&k, &v)| (k, v)).collect();
        edges.sort_by_key(|&(pair, _)| pair);
        edges
    }

    /// Everything the core is holding: the ceiling the Phase 3 gate watches.
    pub fn footprint(&self) -> Footprint {
        Footprint {
            dag_nodes: self.dag.len(),
            flow_edges: self.flows.len(),
            sink_sites: self.sinks.len(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Footprint {
    pub dag_nodes: usize,
    pub flow_edges: usize,
    pub sink_sites: usize,
}

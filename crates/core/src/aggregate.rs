//! DAG -> function -> module rollup.
//!
//! The UI renders at module level by default with a ~2k element ceiling, so the
//! daemon does the collapsing rather than shipping every call site.
//!
//! # Everything lands somewhere
//!
//! A flow between two sites can fail to become an edge in three distinct ways,
//! and they mean different things, so they are counted apart rather than
//! dropped into one "other" bucket:
//!
//! - **unresolved** — a site the skeleton has never heard of. The static parse
//!   and the running code disagree, which is a bug worth seeing.
//! - **internal** — both ends rolled up to the same node. Not a failure: it is
//!   the rollup working, and "this module moves tainted data around inside
//!   itself" is worth rendering on the node.
//! - **unmapped** — two real nodes with no declared edge between them. Taint
//!   crossed a seam the static parse did not predict, which is exactly what an
//!   uninstrumented framework frame looks like from here.
//!
//! [`Rollup::total`] adds up to the input, and the tests hold that line. Silent
//! loss in an aggregator is indistinguishable from a graph that is simply wrong.
//!
//! # Bounded, like ingest
//!
//! Every map here is keyed on skeleton nodes or skeleton edges, both of which
//! are fixed by the static topology. A run that never ends grows counters, not
//! entries.

use std::collections::HashMap;

use crate::dag::SiteId;
use crate::ingest::SinkHit;
use crate::skeleton::{EdgeId, NodeId, Skeleton};

/// One declared edge, lit up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EdgeCount {
    pub edge: EdgeId,
    pub count: u64,
}

/// Taint crossed between two nodes the static parse never connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnmappedFlow {
    pub source: NodeId,
    pub target: NodeId,
    pub count: u64,
}

/// Sinks reached, collapsed to the rendered granularity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeSinks {
    pub node: NodeId,
    /// Distinct `(site, sink)` pairs that rolled up here.
    pub sites: u32,
    pub count: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Rollup {
    /// Granularity this was rolled up to, as a `node_kind`.
    pub kind: u8,
    pub edges: Vec<EdgeCount>,
    pub internal: Vec<(NodeId, u64)>,
    pub unmapped: Vec<UnmappedFlow>,
    /// Flows naming a site the skeleton does not contain.
    pub unresolved: u64,
    pub sinks: Vec<NodeSinks>,
}

impl Rollup {
    /// Every counted flow, however it was classified. Must equal the input.
    pub fn total(&self) -> u64 {
        let edges: u64 = self.edges.iter().map(|edge| edge.count).sum();
        let internal: u64 = self.internal.iter().map(|&(_, count)| count).sum();
        let unmapped: u64 = self.unmapped.iter().map(|flow| flow.count).sum();
        edges + internal + unmapped + self.unresolved
    }

    /// Elements the UI would have to render. Watched against the ~2k ceiling.
    pub fn elements(&self) -> usize {
        self.edges.len() + self.unmapped.len()
    }

    /// Drops all but the `n` heaviest edges.
    ///
    /// Truncation is by count because a graph past its ceiling is unreadable
    /// anyway, and the heavy edges are the ones a person is looking for. Ties
    /// break on id so the same load always yields the same picture.
    pub fn cap_edges(&mut self, n: usize) {
        if self.edges.len() > n {
            self.edges
                .sort_by_key(|edge| (std::cmp::Reverse(edge.count), edge.edge));
            self.edges.truncate(n);
            self.edges.sort_by_key(|edge| edge.edge);
        }
    }
}

/// Collapses site-level flows and sink hits onto the skeleton at `kind`.
///
/// `flows` and `sinks` are shaped exactly as [`crate::ingest::Core::flows`] and
/// [`crate::ingest::Core::sinks`] return them, so the daemon hands one straight
/// to the other without an intermediate copy.
pub fn roll_up(
    skeleton: &Skeleton,
    flows: &[((SiteId, SiteId), u64)],
    sinks: &[SinkHit],
    kind: u8,
) -> Rollup {
    let mut edges: HashMap<EdgeId, u64> = HashMap::new();
    let mut internal: HashMap<NodeId, u64> = HashMap::new();
    let mut unmapped: HashMap<(NodeId, NodeId), u64> = HashMap::new();
    let mut unresolved = 0;

    for &((from, to), count) in flows {
        let (Some(source), Some(target)) =
            (skeleton.resolve(from, kind), skeleton.resolve(to, kind))
        else {
            unresolved += count;
            continue;
        };

        if source == target {
            *internal.entry(source).or_insert(0) += count;
        } else if let Some(edge) = skeleton.edge_between(source, target) {
            *edges.entry(edge).or_insert(0) += count;
        } else {
            *unmapped.entry((source, target)).or_insert(0) += count;
        }
    }

    // A sink whose site is unknown is dropped rather than counted: unlike a
    // flow there is no edge it could belong to, and the flow tally already
    // reports the same disagreement.
    let mut sink_totals: HashMap<NodeId, (u32, u64)> = HashMap::new();
    for hit in sinks {
        let Some(node) = skeleton.resolve(hit.site, kind) else {
            continue;
        };
        let entry = sink_totals.entry(node).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += hit.count;
    }

    let mut rollup = Rollup {
        kind,
        edges: edges
            .into_iter()
            .map(|(edge, count)| EdgeCount { edge, count })
            .collect(),
        internal: internal.into_iter().collect(),
        unmapped: unmapped
            .into_iter()
            .map(|((source, target), count)| UnmappedFlow {
                source,
                target,
                count,
            })
            .collect(),
        unresolved,
        sinks: sink_totals
            .into_iter()
            .map(|(node, (sites, count))| NodeSinks { node, sites, count })
            .collect(),
    };

    // Stable order throughout: a delta is only meaningful against a fixed one.
    rollup.edges.sort_by_key(|edge| edge.edge);
    rollup.internal.sort_by_key(|&(node, _)| node);
    rollup
        .unmapped
        .sort_by_key(|flow| (flow.source, flow.target));
    rollup.sinks.sort_by_key(|sinks| sinks.node);
    rollup
}

/// One edge whose count moved since the UI last heard about it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EdgeDelta {
    pub edge: EdgeId,
    pub count: u64,
    pub tainted: bool,
}

/// Run-wide counters the UI displays as-is.
///
/// Both are partial-answer tallies: events the agent threw away, and lineages
/// the DAG refused to extend. Neither is a size, and neither is ever hidden.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub dropped: u64,
    pub truncated: u64,
    /// Label lookups that found nothing, so the value was reported untainted.
    /// A false negative: unlike a truncated chain it leaves no trace in the
    /// graph, which is exactly why it is counted.
    pub lost: u64,
}

/// Everything that moved since the last frame.
///
/// The four counters are running totals rather than diffs: they are numbers a
/// person reads off the screen, and the increment is not what they want.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Delta {
    pub edges: Vec<EdgeDelta>,
    pub unmapped: Vec<UnmappedFlow>,
    pub internal: Vec<(NodeId, u64)>,
    pub sinks: Vec<NodeSinks>,
    pub dropped_total: u64,
    pub unresolved: u64,
    /// Derivation chains that hit the depth cap. A provenance panel has to say
    /// "the chain stops here" rather than implying it reached a source.
    pub truncated: u64,
    /// Labels that aged out or were never seen, and so read as untainted.
    pub lost: u64,
}

impl Delta {
    /// Whether there is anything worth sending. A quiet frame costs a wakeup on
    /// the UI thread and a layout pass; skipping it is the whole point.
    pub fn is_empty(&self) -> bool {
        self.edges.is_empty()
            && self.unmapped.is_empty()
            && self.internal.is_empty()
            && self.sinks.is_empty()
    }
}

/// Skeleton once, then deltas.
///
/// Ingest only counts a flow whose label survives translation, so an edge
/// appearing here at all means tainted data crossed it — `tainted` is carried
/// anyway because the UI's contract has the field and a future untainted-flow
/// count would land in the same shape.
///
/// Every map is keyed on skeleton nodes or edges, so what the tracker remembers
/// is bounded by the topology exactly like the rollup that feeds it.
#[derive(Default)]
pub struct DeltaTracker {
    edges: HashMap<EdgeId, u64>,
    unmapped: HashMap<(NodeId, NodeId), u64>,
    internal: HashMap<NodeId, u64>,
    sinks: HashMap<NodeId, (u32, u64)>,
    totals: Totals,
}

impl DeltaTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// What changed since the last call.
    ///
    /// An entry missing from `rollup` is not emitted as a zero: counts only ever
    /// climb, so absence means "capped out of this frame", and reporting that as
    /// a reset would make the UI flicker under load.
    pub fn diff(&mut self, rollup: &Rollup, totals: Totals) -> Delta {
        let mut delta = Delta {
            dropped_total: totals.dropped,
            unresolved: rollup.unresolved,
            truncated: totals.truncated,
            lost: totals.lost,
            ..Delta::default()
        };

        for edge in &rollup.edges {
            if self.edges.insert(edge.edge, edge.count) != Some(edge.count) {
                delta.edges.push(EdgeDelta {
                    edge: edge.edge,
                    count: edge.count,
                    tainted: true,
                });
            }
        }

        for flow in &rollup.unmapped {
            let key = (flow.source, flow.target);
            if self.unmapped.insert(key, flow.count) != Some(flow.count) {
                delta.unmapped.push(*flow);
            }
        }

        for &(node, count) in &rollup.internal {
            if self.internal.insert(node, count) != Some(count) {
                delta.internal.push((node, count));
            }
        }

        for sinks in &rollup.sinks {
            let seen = (sinks.sites, sinks.count);
            if self.sinks.insert(sinks.node, seen) != Some(seen) {
                delta.sinks.push(*sinks);
            }
        }

        self.totals = totals;
        delta
    }

    /// The run-wide counters as last reported.
    pub fn totals(&self) -> Totals {
        self.totals
    }

    /// Forgets what the UI has seen, so the next diff is a full resend. Used
    /// when a client reconnects and needs the skeleton and counts again.
    pub fn reset(&mut self) {
        self.edges.clear();
        self.unmapped.clear();
        self.internal.clear();
        self.sinks.clear();
    }
}

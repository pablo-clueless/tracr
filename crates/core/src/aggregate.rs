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
        let (Some(source), Some(target)) = (skeleton.resolve(from, kind), skeleton.resolve(to, kind))
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
    rollup.unmapped.sort_by_key(|flow| (flow.source, flow.target));
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

/// Skeleton once, then deltas.
///
/// Ingest only counts a flow whose label survives translation, so an edge
/// appearing here at all means tainted data crossed it — `tainted` is carried
/// anyway because the UI's contract has the field and a future untainted-flow
/// count would land in the same shape.
#[derive(Default)]
pub struct DeltaTracker {
    sent: HashMap<EdgeId, u64>,
    dropped: u64,
}

impl DeltaTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Edges that changed since the last call, plus the current dropped total.
    ///
    /// An edge missing from `rollup` is not emitted as a zero: counts only ever
    /// climb, so absence means "capped out of this frame", and reporting that
    /// as a reset would make the UI flicker under load.
    pub fn diff(&mut self, rollup: &Rollup, dropped: u64) -> (Vec<EdgeDelta>, u64) {
        let mut changed = Vec::new();

        for edge in &rollup.edges {
            let last = self.sent.get(&edge.edge).copied().unwrap_or(0);
            if last != edge.count {
                self.sent.insert(edge.edge, edge.count);
                changed.push(EdgeDelta {
                    edge: edge.edge,
                    count: edge.count,
                    tainted: true,
                });
            }
        }

        self.dropped = dropped;
        (changed, dropped)
    }

    /// Total events the agents admitted to discarding, as last reported.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Forgets what the UI has seen, so the next diff is a full resend. Used
    /// when a client reconnects and needs the skeleton and counts again.
    pub fn reset(&mut self) {
        self.sent.clear();
    }
}

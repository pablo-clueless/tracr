//! The static topology, parsed once before execution.
//!
//! Runtime is an overlay on this: edges light up and carry counts. A node per
//! call would make the graph unrenderable within seconds.
//!
//! # Why this owns the indexes
//!
//! Events carry a `SiteId` and nothing else — no file, no function name. Turning
//! a flow between two sites into an edge between two boxes on screen is a
//! lookup, and it happens once per distinct flow pair per emit. Building the
//! maps at load time keeps that off the hot path, and the skeleton is immutable
//! after construction, so there is nothing to keep in sync.
//!
//! # Containment is the rollup
//!
//! `parent` runs call site -> function -> file, so rolling a flow up to module
//! level is an ancestor walk rather than a separate aggregation index. The kinds
//! are ordered coarse-to-fine deliberately: a smaller `kind` is always further
//! up the chain, which is what makes [`Skeleton::lift`] a simple loop.

use std::collections::HashMap;

use crate::dag::SiteId;

pub type NodeId = u32;
pub type EdgeId = u32;

/// Granularity, coarse to fine. Mirrors `SkeletonNodeKind` in `@tracr/protocol`.
pub mod node_kind {
    pub const FILE: u8 = 0;
    pub const FUNCTION: u8 = 1;
    pub const CALL_SITE: u8 = 2;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkeletonNode {
    pub id: NodeId,
    pub kind: u8,
    pub label: String,
    pub parent: Option<NodeId>,
    /// Set on nodes an event can name. Files and functions without an
    /// instrumented site carry `None` and are reachable only as ancestors.
    pub site: Option<SiteId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SkeletonEdge {
    pub id: EdgeId,
    pub source: NodeId,
    pub target: NodeId,
}

#[derive(Default)]
pub struct Skeleton {
    nodes: Vec<SkeletonNode>,
    edges: Vec<SkeletonEdge>,
    by_id: HashMap<NodeId, usize>,
    by_site: HashMap<SiteId, NodeId>,
    by_endpoints: HashMap<(NodeId, NodeId), EdgeId>,
}

impl Skeleton {
    /// Builds the lookup tables once. Later duplicates lose: a malformed
    /// skeleton is a parser bug, and dropping the graph over it would be worse
    /// than rendering the first definition.
    pub fn new(nodes: Vec<SkeletonNode>, edges: Vec<SkeletonEdge>) -> Self {
        let mut by_id = HashMap::with_capacity(nodes.len());
        let mut by_site = HashMap::new();

        for (index, node) in nodes.iter().enumerate() {
            by_id.entry(node.id).or_insert(index);
            if let Some(site) = node.site {
                by_site.entry(site).or_insert(node.id);
            }
        }

        let mut by_endpoints = HashMap::with_capacity(edges.len());
        for edge in &edges {
            by_endpoints
                .entry((edge.source, edge.target))
                .or_insert(edge.id);
        }

        Self {
            nodes,
            edges,
            by_id,
            by_site,
            by_endpoints,
        }
    }

    pub fn nodes(&self) -> &[SkeletonNode] {
        &self.nodes
    }

    pub fn edges(&self) -> &[SkeletonEdge] {
        &self.edges
    }

    pub fn node(&self, id: NodeId) -> Option<&SkeletonNode> {
        self.by_id.get(&id).map(|&index| &self.nodes[index])
    }

    /// The node an event's `SiteId` names, before any rollup.
    pub fn site_node(&self, site: SiteId) -> Option<NodeId> {
        self.by_site.get(&site).copied()
    }

    pub fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.node(id).and_then(|node| node.parent)
    }

    /// Walks up the containment chain to the first ancestor of `kind`.
    ///
    /// Returns `id` itself when it already matches. The walk is bounded by the
    /// node count so a skeleton whose parent pointers form a cycle degrades to
    /// "unresolved" instead of hanging the daemon.
    pub fn lift(&self, id: NodeId, kind: u8) -> Option<NodeId> {
        let mut current = id;
        for _ in 0..=self.nodes.len() {
            let node = self.node(current)?;
            if node.kind == kind {
                return Some(current);
            }
            current = node.parent?;
        }
        None
    }

    /// A site resolved all the way to the granularity the UI is rendering.
    pub fn resolve(&self, site: SiteId, kind: u8) -> Option<NodeId> {
        self.lift(self.site_node(site)?, kind)
    }

    /// The declared edge between two nodes, if the static parse found one.
    pub fn edge_between(&self, source: NodeId, target: NodeId) -> Option<EdgeId> {
        self.by_endpoints.get(&(source, target)).copied()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

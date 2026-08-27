//! The core -> UI wire format.
//!
//! # Why this is JSON, when the agent side is MessagePack
//!
//! The two directions have opposite pressures. Agent -> core is per-event and
//! hot enough that the format is positional arrays with no keys. Core -> UI is
//! one message per frame interval carrying an already-collapsed graph, so the
//! cost is negligible and the wins are elsewhere: browsers parse JSON in native
//! code, and a person debugging the daemon can read the socket.
//!
//! # Named fields, camelCase
//!
//! Unlike the event format, these are objects keyed by name, matching the
//! `CoreUpdate` types in `@tracr/protocol`. The UI is versioned alongside the
//! daemon but not shipped with it — a user can end up on a new binary and a
//! cached bundle — so a field the UI does not recognise must be ignorable
//! rather than shifting every field after it.
//!
//! Escaping is why this does not hand-roll a writer: node labels are file paths
//! and function names. A Windows path is full of backslashes, and a mangled one
//! would corrupt the whole frame rather than one node.

use serde::Serialize;

use crate::aggregate::Delta;
use crate::skeleton::{EdgeId, NodeId, Skeleton};

/// Element `tag` of an update. Mirrors `UpdateTag` in `@tracr/protocol`.
pub mod update_tag {
    pub const SKELETON: u8 = 0;
    pub const DELTA: u8 = 1;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireNode<'a> {
    id: NodeId,
    kind: u8,
    label: &'a str,
    parent: Option<NodeId>,
    site_id: Option<u32>,
}

#[derive(Serialize)]
struct WireEdge {
    id: EdgeId,
    source: NodeId,
    target: NodeId,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireSkeleton<'a> {
    tag: u8,
    nodes: Vec<WireNode<'a>>,
    edges: Vec<WireEdge>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireEdgeDelta {
    edge_id: EdgeId,
    count: u64,
    tainted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireUnmapped {
    source: NodeId,
    target: NodeId,
    count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireNodeCount {
    node_id: NodeId,
    count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireNodeSinks {
    node_id: NodeId,
    sites: u32,
    count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireDelta {
    tag: u8,
    edges: Vec<WireEdgeDelta>,
    unmapped: Vec<WireUnmapped>,
    internal: Vec<WireNodeCount>,
    sinks: Vec<WireNodeSinks>,
    dropped_total: u64,
    unresolved: u64,
    truncated: u64,
    lost: u64,
}

/// The static topology, sent once when a client attaches.
pub fn encode_skeleton(skeleton: &Skeleton) -> String {
    let wire = WireSkeleton {
        tag: update_tag::SKELETON,
        nodes: skeleton
            .nodes()
            .iter()
            .map(|node| WireNode {
                id: node.id,
                kind: node.kind,
                label: &node.label,
                parent: node.parent,
                site_id: node.site,
            })
            .collect(),
        edges: skeleton
            .edges()
            .iter()
            .map(|edge| WireEdge {
                id: edge.id,
                source: edge.source,
                target: edge.target,
            })
            .collect(),
    };

    // Every field is an integer, a bool, or a string we own: nothing here can
    // fail to serialise, so the daemon does not carry an error path it can
    // never take.
    serde_json::to_string(&wire).expect("skeleton is plain data")
}

/// One frame of change.
pub fn encode_delta(delta: &Delta) -> String {
    let wire = WireDelta {
        tag: update_tag::DELTA,
        edges: delta
            .edges
            .iter()
            .map(|edge| WireEdgeDelta {
                edge_id: edge.edge,
                count: edge.count,
                tainted: edge.tainted,
            })
            .collect(),
        unmapped: delta
            .unmapped
            .iter()
            .map(|flow| WireUnmapped {
                source: flow.source,
                target: flow.target,
                count: flow.count,
            })
            .collect(),
        internal: delta
            .internal
            .iter()
            .map(|&(node_id, count)| WireNodeCount { node_id, count })
            .collect(),
        sinks: delta
            .sinks
            .iter()
            .map(|sinks| WireNodeSinks {
                node_id: sinks.node,
                sites: sinks.sites,
                count: sinks.count,
            })
            .collect(),
        dropped_total: delta.dropped_total,
        unresolved: delta.unresolved,
        truncated: delta.truncated,
        lost: delta.lost,
    };

    serde_json::to_string(&wire).expect("delta is plain data")
}

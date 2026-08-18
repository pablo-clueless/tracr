//! The static topology, parsed once before execution.
//!
//! Runtime is an overlay on this: edges light up and carry counts. A node per
//! call would make the graph unrenderable within seconds.

pub struct Skeleton {
    pub nodes: Vec<SkeletonNode>,
    pub edges: Vec<SkeletonEdge>,
}

pub struct SkeletonNode {
    pub id: u32,
    pub kind: u8,
    pub label: String,
    pub parent: Option<u32>,
}

pub struct SkeletonEdge {
    pub id: u32,
    pub source: u32,
    pub target: u32,
}

//! Hash-consed provenance DAG.
//!
//! Identical `(op, site_id, parents)` always yields the same index, so union is
//! a hash lookup, lineage is structurally shared, and index 0 means untainted.
//!
//! # Why hash-consing alone does not bound this
//!
//! Interning dedupes *repeated* shapes, which is enough for a loop that redoes
//! the same derivation. It does nothing for a loop that extends one:
//!
//! ```text
//! for (const item of items) acc = acc + item
//! ```
//!
//! Every iteration combines at the same site, but `acc` carries a new label
//! each time, so the parents differ and every iteration is a genuinely new
//! node. Measured, that is one node per iteration forever — linear growth from
//! a `reduce`, a running total, or a string builder, which is not an exotic
//! shape. Phase 3's gate is bounded memory over a run that never ends, so the
//! DAG has to refuse to extend a chain past some point.
//!
//! # Depth cap
//!
//! Each node knows how deep its lineage runs. Past [`Dag::max_depth`], interning
//! returns [`TRUNCATED`] instead of a new node: still tainted, but with no
//! recorded history. Truncation then propagates for free, because a child of a
//! truncated parent is itself over the cap.
//!
//! This bounds the pathological case and leaves the useful one untouched. The
//! product promise is showing a derivation chain from sink back to source, and
//! a chain fifty thousand links long is not something a person reads — so the
//! cap discards precisely what had no value while every short chain, which is
//! nearly all of them, is stored exactly as before.
//!
//! Depth is not part of a node's identity. It is a pure function of the node's
//! parents, so two nodes with equal `(op, site, parents)` always agree on it and
//! it must stay out of the hash key.

use std::collections::HashMap;

use crate::{TRUNCATED, UNTAINTED};

pub type Label = u32;
pub type SiteId = u32;

/// How long a lineage may run before the DAG stops extending it.
///
/// Deep enough that ordinary derivations — a value read, trimmed, formatted,
/// and interpolated — never come near it; shallow enough that an accumulator
/// saturates in well under a millisecond of loop time.
pub const DEFAULT_MAX_DEPTH: u32 = 64;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Node {
    Origin {
        source_id: u32,
        site_id: SiteId,
    },
    Combine {
        op: u8,
        site_id: SiteId,
        parents: Vec<Label>,
    },
}

pub struct Dag {
    nodes: Vec<Node>,
    /// Lineage depth per node, parallel to `nodes`. Kept beside the node rather
    /// than inside it so it stays out of the hash-consing key.
    depths: Vec<u32>,
    index: HashMap<Node, Label>,
    max_depth: u32,
    truncated: u64,
}

impl Default for Dag {
    fn default() -> Self {
        Self::with_max_depth(DEFAULT_MAX_DEPTH)
    }
}

impl Dag {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_max_depth(max_depth: u32) -> Self {
        Self {
            nodes: Vec::new(),
            depths: Vec::new(),
            index: HashMap::new(),
            max_depth,
            truncated: 0,
        }
    }

    /// Returns [`TRUNCATED`] rather than a new label once the lineage would run
    /// past the cap. The node is not stored, so nothing grows.
    pub fn intern(&mut self, node: Node) -> Label {
        // Checked first: a node already interned passed the cap when it was
        // stored, and depth cannot change afterwards because a node's parents
        // never change.
        if let Some(&label) = self.index.get(&node) {
            return label;
        }

        let depth = self.depth_of(&node);
        if depth > self.max_depth {
            self.truncated += 1;
            return TRUNCATED;
        }

        self.nodes.push(node.clone());
        self.depths.push(depth);
        let label = self.nodes.len() as Label;
        self.index.insert(node, label);
        label
    }

    fn depth_of(&self, node: &Node) -> u32 {
        match node {
            Node::Origin { .. } => 1,
            Node::Combine { parents, .. } => {
                1 + parents.iter().map(|&p| self.depth(p)).max().unwrap_or(0)
            }
        }
    }

    /// How far this label's lineage runs. Untainted is 0; truncated reports the
    /// cap itself, which is what makes any child of it saturate in turn.
    pub fn depth(&self, label: Label) -> u32 {
        match label {
            UNTAINTED => 0,
            TRUNCATED => self.max_depth,
            _ => label
                .checked_sub(1)
                .and_then(|slot| self.depths.get(slot as usize))
                .copied()
                .unwrap_or(0),
        }
    }

    /// The node behind a label, or `None` for either reserved label — neither
    /// [`UNTAINTED`] nor [`TRUNCATED`] names one.
    pub fn get(&self, label: Label) -> Option<&Node> {
        if label == UNTAINTED || label == TRUNCATED {
            return None;
        }
        self.nodes.get((label - 1) as usize)
    }

    /// Every label this one was derived from, origins first.
    ///
    /// Ordered by depth so it reads the way the value was actually built: the
    /// declared source, then each step that transformed it, then the label
    /// asked about. This is the product's whole claim — "show me how this value
    /// got here" — so the order is the feature, not a detail.
    ///
    /// `cap` bounds the width. A chain is deep-bounded already by the depth cap,
    /// but a node can have many parents and a person cannot read a thousand
    /// steps anyway.
    pub fn lineage(&self, label: Label, cap: usize) -> Lineage {
        if label == UNTAINTED {
            return Lineage::default();
        }
        // A truncated label is tainted with no recorded history. Saying so beats
        // returning an empty chain that reads like "no provenance".
        if label == TRUNCATED {
            return Lineage {
                steps: Vec::new(),
                truncated: true,
            };
        }

        let mut seen = std::collections::HashSet::new();
        let mut stack = vec![label];
        let mut steps = Vec::new();
        let mut truncated = false;

        while let Some(current) = stack.pop() {
            if !seen.insert(current) {
                continue;
            }
            if steps.len() >= cap {
                truncated = true;
                break;
            }
            let Some(node) = self.get(current) else {
                continue;
            };
            steps.push(current);

            if let Node::Combine { parents, .. } = node {
                for &parent in parents {
                    if parent != UNTAINTED {
                        stack.push(parent);
                    }
                }
            }
        }

        // Shallowest first, so an origin heads the list. Ties break on label to
        // keep the same value rendering the same way every time.
        steps.sort_by_key(|&step| (self.depth(step), step));
        Lineage { steps, truncated }
    }

    /// Chains the cap refused to extend. Surfaced, never hidden: a truncated
    /// lineage is a partial answer and the UI has to be able to say so.
    pub fn truncated(&self) -> u64 {
        self.truncated
    }

    pub fn max_depth(&self) -> u32 {
        self.max_depth
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

/// A derivation chain, origins first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Lineage {
    pub steps: Vec<Label>,
    /// The chain is incomplete: it hit the depth cap or the width cap. The UI
    /// must say so rather than presenting a partial chain as the whole story.
    pub truncated: bool,
}

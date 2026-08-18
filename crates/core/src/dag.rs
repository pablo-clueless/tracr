//! Hash-consed provenance DAG.
//!
//! Identical `(op, site_id, parents)` always yields the same index, so union is
//! a hash lookup, lineage is structurally shared, and index 0 means untainted.

use std::collections::HashMap;

pub type Label = u32;
pub type SiteId = u32;

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

#[derive(Default)]
pub struct Dag {
    nodes: Vec<Node>,
    index: HashMap<Node, Label>,
}

impl Dag {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn intern(&mut self, node: Node) -> Label {
        if let Some(&label) = self.index.get(&node) {
            return label;
        }
        self.nodes.push(node.clone());
        let label = self.nodes.len() as Label;
        self.index.insert(node, label);
        label
    }

    pub fn get(&self, label: Label) -> Option<&Node> {
        if label == crate::UNTAINTED {
            return None;
        }
        self.nodes.get((label - 1) as usize)
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

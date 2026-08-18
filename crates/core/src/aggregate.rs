//! DAG -> function -> module rollup.
//!
//! The UI renders at module level by default with a ~2k element ceiling, so the
//! daemon does the collapsing rather than shipping every call site.

use crate::dag::Label;

#[derive(Default)]
pub struct EdgeCounts {
    pub counts: Vec<(u32, u64)>,
}

pub fn roll_up(_labels: &[Label]) -> EdgeCounts {
    EdgeCounts::default()
}

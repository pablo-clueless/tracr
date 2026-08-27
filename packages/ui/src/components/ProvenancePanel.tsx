import { useGraphStore } from "../store/useGraphStore";
import { toRows } from "../graph/chain";

/**
 * The answer to "how did this value get here".
 *
 * Reads top to bottom: the declared source, then each step that transformed it,
 * then the value that reached the sink.
 */
export const ProvenancePanel = () => {
  const chain = useGraphStore((s) => s.chain);
  const graph = useGraphStore((s) => s.graph);
  const clearChain = useGraphStore((s) => s.clearChain);

  if (chain === null) return null;

  const rows = toRows(chain, graph);

  return (
    <aside className="tracr-provenance">
      <header>
        <span>derivation</span>
        <button className="tracr-button tracr-button-outline" onClick={clearChain}>
          close
        </button>
      </header>
      {rows.length === 0 ? (
        // Never rendered as "no provenance": the value is tainted, its history
        // is what went missing.
        <p className="tracr-empty">
          {chain.truncated
            ? "This value is tainted, but its chain ran past the depth cap and was not recorded."
            : "Nothing has reached this node yet."}
        </p>
      ) : (
        <ol className="tracr-chain">
          {rows.map((row) => (
            <li key={row.label}>
              <span className="tracr-chain-index">#{row.index}</span>
              <span className="tracr-chain-op">
                {row.operation}
                {row.from.length > 0 && `(${row.from.map((at) => `#${String(at)}`).join(", ")})`}
              </span>
              <span className="tracr-chain-where">{row.where}</span>
            </li>
          ))}
        </ol>
      )}

      {chain.truncated && rows.length > 0 && (
        <p className="tracr-truncated">
          Chain is incomplete — it hit a cap before reaching a source.
        </p>
      )}
    </aside>
  );
};

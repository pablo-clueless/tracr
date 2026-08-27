import { useGraphStore } from "./store/useGraphStore";
import { useCoreSocket } from "./lib/useCoreSocket";
import { useLayout } from "./lib/useLayout";
import { Visualizer } from "./graph/Visualizer";
import { ProvenancePanel } from "./components/ProvenancePanel";

/** Matches tracr-core's own default. They have to agree or nothing connects. */
const CORE_URL = "ws://127.0.0.1:9231";

export const App = () => {
  const request = useCoreSocket(CORE_URL);
  useLayout();

  const connected = useGraphStore((s) => s.connected);
  const dropped = useGraphStore((s) => s.dropped);
  const lost = useGraphStore((s) => s.lost);

  return (
    <div className="tracr-app">
      <header className="tracr-header">
        <span>tracr</span>
        <span>{connected ? "connected" : "disconnected"}</span>
        {dropped > 0 && <span className="tracr-dropped">{dropped} events dropped</span>}
        {/* A lost label reported a tainted value as clean, so it is a stronger
            warning than a drop: the graph may be missing flows entirely. */}
        {lost > 0 && <span className="tracr-lost">{lost} labels lost</span>}
      </header>
      <main className="tracr-canvas">
        <Visualizer onInspect={(nodeId) => request({ chain: nodeId })} />
        <ProvenancePanel />
      </main>
    </div>
  );
};

export default App;

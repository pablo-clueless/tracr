import { useGraphStore } from "./store/useGraphStore";
import { useCoreSocket } from "./lib/useCoreSocket";
import { Visualizer } from "./graph/Visualizer";

const CORE_URL = "ws://localhost:7331";

export const App = () => {
  useCoreSocket(CORE_URL);

  const connected = useGraphStore((s) => s.connected);
  const dropped = useGraphStore((s) => s.dropped);

  return (
    <div className="tracr-app">
      <header className="tracr-header">
        <span>tracr</span>
        <span>{connected ? "connected" : "disconnected"}</span>
        {dropped > 0 && <span className="tracr-dropped">{dropped} events dropped</span>}
      </header>
      <main className="tracr-canvas">
        <Visualizer />
      </main>
    </div>
  );
};

export default App;

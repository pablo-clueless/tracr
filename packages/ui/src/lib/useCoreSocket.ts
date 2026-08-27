import { useCallback, useEffect, useRef } from "react";

import { UpdateTag, type CoreUpdate, type ViewerRequest } from "@pablo_clueless/protocol";
import { useGraphStore } from "../store/useGraphStore";

/**
 * Core sends the skeleton once, then deltas. A chain arrives only when asked
 * for, so it is a reply rather than a push.
 *
 * Returns a sender because asking is a user action — clicking a node — and the
 * socket is owned here.
 */
export const useCoreSocket = (url: string): ((request: ViewerRequest) => void) => {
  const ingestSkeleton = useGraphStore((s) => s.ingestSkeleton);
  const ingestDelta = useGraphStore((s) => s.ingestDelta);
  const ingestChain = useGraphStore((s) => s.ingestChain);
  const setConnected = useGraphStore((s) => s.setConnected);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = (event: MessageEvent<string>) => {
      const update = JSON.parse(event.data) as CoreUpdate;
      if (update.tag === UpdateTag.Skeleton) ingestSkeleton(update);
      else if (update.tag === UpdateTag.Chain) ingestChain(update);
      else ingestDelta(update);
    };

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [url, ingestSkeleton, ingestDelta, ingestChain, setConnected]);

  return useCallback((request: ViewerRequest) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(request));
  }, []);
};

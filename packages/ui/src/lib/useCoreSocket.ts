import { useEffect } from "react";
import { UpdateTag, type CoreUpdate } from "@pablo_clueless/protocol";

import { useGraphStore } from "../store/useGraphStore";

/** Core sends the skeleton once, then deltas. */
export const useCoreSocket = (url: string): void => {
  const ingestSkeleton = useGraphStore((s) => s.ingestSkeleton);
  const ingestDelta = useGraphStore((s) => s.ingestDelta);
  const setConnected = useGraphStore((s) => s.setConnected);

  useEffect(() => {
    const socket = new WebSocket(url);

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);
    socket.onmessage = (event: MessageEvent<string>) => {
      const update = JSON.parse(event.data) as CoreUpdate;
      if (update.tag === UpdateTag.Skeleton) ingestSkeleton(update);
      else ingestDelta(update);
    };

    return () => socket.close();
  }, [url, ingestSkeleton, ingestDelta, setConnected]);
};

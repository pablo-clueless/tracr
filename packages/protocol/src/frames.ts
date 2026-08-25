/**
 * Wire framing shared by every agent transport and tracr-core.
 *
 * A frame is one MessagePack array whose element 0 is a `FrameType`. On
 * stream transports (unix socket / named pipe) each frame is prefixed with a
 * 4-byte big-endian length; WebSocket messages carry one frame per message and
 * need no prefix.
 */
export const FrameType = {
  Hello: 0,
  Batch: 1,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

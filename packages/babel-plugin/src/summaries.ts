/**
 * Taint dies the moment a value enters a builtin, because `node_modules` and
 * native code stay uninstrumented. This table is the substitute, and it is the
 * difference between a demo and a tool. It never really ends.
 *
 * `args` lists the argument positions whose taint reaches the result;
 * `receiver` means the taint of `this` reaches the result.
 */
export interface BuiltinSummary {
  receiver: boolean;
  args: number[];
}

export const BUILTIN_SUMMARIES: Record<string, BuiltinSummary> = {
  "JSON.parse": { receiver: false, args: [0] },
  "JSON.stringify": { receiver: false, args: [0] },
  "String.prototype.slice": { receiver: true, args: [] },
  "String.prototype.concat": { receiver: true, args: [0] },
  "String.prototype.replace": { receiver: true, args: [1] },
  "String.prototype.trim": { receiver: true, args: [] },
  "String.prototype.toLowerCase": { receiver: true, args: [] },
  "String.prototype.toUpperCase": { receiver: true, args: [] },
  "String.prototype.split": { receiver: true, args: [] },
  "String.prototype.padStart": { receiver: true, args: [1] },
  "Array.prototype.map": { receiver: true, args: [] },
  "Array.prototype.filter": { receiver: true, args: [] },
  "Array.prototype.join": { receiver: true, args: [] },
  "Array.prototype.slice": { receiver: true, args: [] },
  "Array.prototype.concat": { receiver: true, args: [0] },
  "Array.prototype.find": { receiver: true, args: [] },
  "Object.assign": { receiver: false, args: [0, 1] },
  "Object.entries": { receiver: false, args: [0] },
  Number: { receiver: false, args: [0] },
  String: { receiver: false, args: [0] },
  parseInt: { receiver: false, args: [0] },
};

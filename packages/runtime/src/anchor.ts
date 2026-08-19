import { UNTAINTED, type Label } from "@pablo_clueless/protocol";

/**
 * Object-anchored taint. This is what survives uninstrumented framework frames:
 * the side channel is call-scoped and dies at the first `node_modules` boundary,
 * but a label hung off the object itself travels with the object.
 */
const anchors = new WeakMap<object, Map<PropertyKey, Label>>();

const OWN = Symbol.for("tracr.own");

export const anchor = (obj: object, key: PropertyKey, label: Label): void => {
  if (label === UNTAINTED) return;
  let slots = anchors.get(obj);
  if (slots === undefined) {
    slots = new Map();
    anchors.set(obj, slots);
  }
  slots.set(key, label);
};

export const readAnchor = (obj: object, key: PropertyKey): Label =>
  anchors.get(obj)?.get(key) ?? UNTAINTED;

/** Label the object itself, not one of its properties. */
export const anchorSelf = (obj: object, label: Label): void => anchor(obj, OWN, label);

export const readSelf = (obj: object): Label => readAnchor(obj, OWN);

/**
 * The general primitive adapters call at known framework boundaries to move a
 * call-scoped label onto an object that outlives the call.
 */
export const reanchor = (obj: object, label: Label): object => {
  anchorSelf(obj, label);
  return obj;
};

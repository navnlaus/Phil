// The document being edited: a tree of nodes
//   { type: "object" | "array" | "string" | "number" | "boolean" | "null",
//     value,      a string's text, a number's text as written (no lost digits),
//                 true/false, null
//     children,   for objects and arrays
//     key,        for members of an object
//     parent }
import { parse } from "/ui/json.js";

export const isContainer = (node) => node.type === "object" || node.type === "array";

/** The model of a parse tree (json.js) of `text`. */
export function fromParse(text, p, parent = null) {
  const node = { type: p.type, parent };
  if (p.key !== undefined) node.key = p.key;
  if (p.children) node.children = p.children.map((c) => fromParse(text, c, node));
  else node.value = p.type === "number" ? text.slice(p.start, p.end) : p.value;
  return node;
}

/**
 * What typing `text` as a value means: JSON (a number, true, false, null,
 * "a quoted string", {...} or [...]) is taken as such; anything else is a
 * string. { node } or, for text that starts like an object or array but isn't
 * valid, { error }.
 */
export function literal(text) {
  const result = parse(text);
  if (result.root) return { node: fromParse(text, result.root) };
  if (/^\s*[[{]/.test(text)) return { error: result.error.message };
  return { node: { type: "string", value: text } };
}

/** The text that edits `node`'s value back to itself (see literal). */
export function editText(node) {
  if (node.type === "string") return literal(node.value).node.type === "string" && !/^\s*"/.test(node.value) ? node.value : JSON.stringify(node.value);
  if (isContainer(node)) return serialize(node, "  ");
  return String(node.value);
}

/** The node as JSON text, `indent` per level ("" for one line). */
export function serialize(node, indent = "  ", depth = 0) {
  if (node.type === "string") return JSON.stringify(node.value);
  if (!isContainer(node)) return String(node.value);
  const [open, close] = node.type === "object" ? ["{", "}"] : ["[", "]"];
  if (!node.children.length) return open + close;
  const nl = indent ? "\n" : "";
  const pad = indent.repeat(depth + 1);
  const items = node.children.map((c) => pad + (node.type === "object" ? JSON.stringify(c.key) + (indent ? ": " : ":") : "") + serialize(c, indent, depth + 1));
  return open + nl + items.join("," + nl) + nl + indent.repeat(depth) + close;
}

/** A copy of `node` (and its children), under `parent`. */
export function clone(node, parent = null) {
  const copy = { ...node, parent };
  if (node.children) copy.children = node.children.map((c) => clone(c, copy));
  return copy;
}

/** Where `node` is, as steps from the root: keys and indexes. */
export function stepsTo(node) {
  const steps = [];
  for (let n = node; n.parent; n = n.parent) steps.unshift(n.parent.type === "object" ? n.key : n.parent.children.indexOf(n));
  return steps;
}

/** The node at `steps` (stepsTo) under `root`, or the deepest one that exists. */
export function follow(root, steps) {
  let node = root;
  for (const step of steps) {
    const next = node.children?.[typeof step === "number" ? step : node.children.findIndex((c) => c.key === step)];
    if (!next) break;
    node = next;
  }
  return node;
}

/** `$.apps[0].kind` style path, for the status bar. */
export function displayPath(node) {
  return "$" + stepsTo(node).map((s) => (typeof s === "number" ? `[${s}]` : /^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join("");
}

/** A key not used yet in `object`: "key", "key 2", ... */
export function freshKey(object, base = "key") {
  const used = new Set(object.children.map((c) => c.key));
  if (!used.has(base)) return base;
  for (let i = 2;; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

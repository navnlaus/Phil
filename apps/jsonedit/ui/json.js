// A JSON parser that keeps where every value is in the text, for the tree and
// for errors (WebKit's JSON.parse doesn't say where an error is).
//
// parse(text) returns { root } or { error: { message, offset } }. Nodes:
//   { type: "object" | "array" | "string" | "number" | "boolean" | "null",
//     start, end,            offsets of the value in the text
//     key?, keyStart?,       for object members: the key and where it starts
//     value?,                for strings, numbers, booleans
//     children? }            for objects and arrays

export function parse(text) {
  let i = 0;

  const fail = (message, at = i) => {
    throw Object.assign(new Error(message), { offset: at });
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const describe = (at) => (at >= text.length ? "the end of the text" : `“${text[at]}”`);

  function value() {
    ws();
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    for (const [word, type, v] of [["true", "boolean", true], ["false", "boolean", false], ["null", "null", null]]) {
      if (text.startsWith(word, i)) {
        const start = i;
        i += word.length;
        return { type, start, end: i, value: v };
      }
    }
    if (c === "'") fail("Strings need double quotes");
    if (c === "}" || c === "]") fail(`Expected a value, found ${describe(i)}`);
    fail(`Expected a value, found ${describe(i)}`);
  }

  function object() {
    const node = { type: "object", start: i, children: [] };
    i++;
    ws();
    if (text[i] === "}") return i++, Object.assign(node, { end: i });
    for (;;) {
      ws();
      if (text[i] !== '"') {
        if (text[i] === "}" && node.children.length) fail("Trailing comma: remove the comma before }", lastComma(i));
        fail(text[i] === "'" ? "Keys need double quotes" : `Expected a key in double quotes, found ${describe(i)}`);
      }
      const key = string();
      ws();
      if (text[i] !== ":") fail(`Expected : after the key "${key.value}"`);
      i++;
      const child = value();
      child.key = key.value;
      child.keyStart = key.start;
      node.children.push(child);
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") return i++, Object.assign(node, { end: i });
      fail(`Expected , or } after a value, found ${describe(i)}`);
    }
  }

  function array() {
    const node = { type: "array", start: i, children: [] };
    i++;
    ws();
    if (text[i] === "]") return i++, Object.assign(node, { end: i });
    for (;;) {
      ws();
      if (text[i] === "]" && node.children.length) fail("Trailing comma: remove the comma before ]", lastComma(i));
      node.children.push(value());
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") return i++, Object.assign(node, { end: i });
      fail(`Expected , or ] after a value, found ${describe(i)}`);
    }
  }

  function string() {
    const start = i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("Unterminated string: a closing \" is missing", start);
      const c = text[i];
      if (c === '"') break;
      if (c === "\n") fail("Unterminated string: a closing \" is missing on this line", start);
      if (c < " ") fail("Control characters must be escaped in strings (\\t, \\n, ...)");
      if (c === "\\") {
        const e = text[i + 1];
        const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[e];
        if (simple !== undefined) {
          out += simple;
          i += 2;
          continue;
        }
        if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        fail(`Invalid escape \\${e ?? ""}`);
      }
      out += c;
      i++;
    }
    i++;
    return { type: "string", start, end: i, value: out };
  }

  function number() {
    const start = i;
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail("Invalid number");
    i += m[0].length;
    if (/[\d.]/.test(text[i] ?? "")) fail(m[1] === "0" && text[i] !== "." ? "Numbers can't have leading zeros" : "Invalid number", start);
    return { type: "number", start, end: i, value: Number(m[0]) };
  }

  // The comma before position `at`, for pointing at a trailing comma.
  function lastComma(at) {
    let j = at - 1;
    while (j > 0 && " \t\n\r".includes(text[j])) j--;
    return text[j] === "," ? j : at;
  }

  try {
    const root = value();
    ws();
    if (i < text.length) fail(`Unexpected ${describe(i)} after the end of the JSON`);
    return { root };
  } catch (err) {
    if (err.offset === undefined) throw err;
    return { error: { message: err.message, offset: err.offset } };
  }
}

/** Line and column (both from 1) of `offset` in `text`. */
export function position(text, offset) {
  let line = 1, last = -1;
  for (let j = text.indexOf("\n"); j !== -1 && j < offset; j = text.indexOf("\n", j + 1)) line++, last = j;
  return { line, column: offset - last };
}

/**
 * The JSON of `node` laid out again: `indent` per level ("" for one line).
 * Keys, strings and numbers keep their exact text from `text` (no reordered
 * keys, no lost digits); `sortKeys` sorts object members by key.
 */
export function format(text, node, { indent = "  ", sortKeys = false } = {}) {
  const nl = indent ? "\n" : "";
  const sep = indent ? ": " : ":";
  const out = (n, depth) => {
    if (n.type !== "object" && n.type !== "array") return text.slice(n.start, n.end);
    const [open, close] = n.type === "object" ? ["{", "}"] : ["[", "]"];
    if (!n.children.length) return open + close;
    const pad = indent.repeat(depth + 1);
    const members = sortKeys && n.type === "object" ? [...n.children].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) : n.children;
    const items = members.map((c) => pad + (n.type === "object" ? text.slice(c.keyStart, keyEnd(text, c.keyStart)) + sep : "") + out(c, depth + 1));
    return open + nl + items.join("," + nl) + nl + indent.repeat(depth) + close;
  };
  return out(node, 0);
}

// Where the key string starting at `start` ends (after its closing quote).
function keyEnd(text, start) {
  let j = start + 1;
  while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

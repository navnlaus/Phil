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

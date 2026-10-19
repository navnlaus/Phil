// Pages in the terminal: what vu sends (engine/vu.js), drawn as it reads in
// textedit (Markdown, by engine/ui/markdown.js, in engine/ui/markdown.css's
// style) or as a web page (HTML), in rows the terminal leaves for it in its
// text, scrolling with it. Through OSC 5379:
//   ?                     does this terminal draw them? answered OSC 5379;blocks
//   block;<JSON>          {markdown, images: {src: data URL}} or {html} (JSON: no
//                         control characters in it, to end the sequence early)
// Each is a frame of its own, sandboxed: nothing runs in it (any program can
// send one, cat of a file too). Its rows are made when it comes (as many as it
// is tall at the terminal's width then), so a terminal's screen given again
// (one in the background, shown) draws it again, at its width. Its text isn't
// the terminal's: selecting there selects in it (copied with the usual keys).
// A block in a part of the screen that's erased (clear) goes with it.

import { render } from "/engine/ui/markdown.js";

const OSC = 5379;
// The theme's colors and fonts, given to a block (it's a page of its own).
const VARS = ["--bg", "--bg-side", "--bg-raised", "--bg-hover", "--border", "--text", "--text-dim", "--accent", "--accent-bg", "--selection", "--mono",
  "--s-comment", "--s-string", "--s-number", "--s-keyword", "--s-literal", "--s-type", "--s-fn", "--s-attr", "--s-variable", "--s-meta", "--s-heading"];

export class Blocks {
  /**
   * In `term` (xterm.js, opened): `answer(text)` sends text to what runs in it (as typed);
   * `replaying()`: an earlier screen's being given again (asked then: long answered);
   * `openLink(url)`; `copy(text)`; `onKey(e)`: a key pressed in a block (the terminal's focus again).
   */
  constructor(term, { answer, replaying, openLink, copy }) {
    this.term = term;
    this.answer = answer;
    this.replaying = replaying;
    this.openLink = openLink;
    this.copy = copy;
    this.list = []; // [{frame, marker, rows}]
    this.layer = document.createElement("div");
    this.layer.className = "term-blocks";
    term.element.querySelector(".xterm-screen").append(this.layer);
    term.parser.registerOscHandler(OSC, (data) => this.osc(data));
    term.onRender(() => this.place());
    term.onScroll(() => this.place());
    term.onResize(() => this.place());
    term.buffer.onBufferChange(() => this.place());
    // Erased: below the cursor (ED 0), the screen (ED 2: clear), everything (RIS: reset).
    term.parser.registerCsiHandler({ final: "J" }, (params) => {
      const buf = this.term.buffer.active;
      if (!params[0]) this.dropBelow(buf.baseY + buf.cursorY);
      if (params[0] === 2) this.dropBelow(buf.baseY);
      return false;
    });
    term.parser.registerEscHandler({ final: "c" }, () => {
      for (const b of [...this.list]) b.marker.dispose();
      return false;
    });
  }

  osc(data) {
    if (data === "?") {
      if (!this.replaying()) this.answer(`\x1b]${OSC};blocks\x07`);
      return true;
    }
    if (!data.startsWith("block;")) return false;
    let spec;
    try {
      spec = JSON.parse(data.slice(6));
    } catch {
      return true;
    }
    return this.add(spec).catch(() => true);
  }

  // The size of a cell (px): xterm.js's, as its image addon takes it.
  cell() {
    const dims = this.term._core?._renderService?.dimensions?.css?.cell;
    const screen = this.layer.parentElement;
    return { w: dims?.width || screen.clientWidth / this.term.cols, h: dims?.height || screen.clientHeight / this.term.rows };
  }

  async add(spec) {
    if (this.term.buffer.active.type !== "normal") return true;
    const frame = document.createElement("iframe");
    frame.sandbox = "allow-same-origin"; // (no scripts: its document is reachable from here, nothing in it runs)
    frame.className = "term-block measuring";
    frame.style.width = `${this.layer.clientWidth}px`;
    frame.srcdoc = page(spec);
    this.layer.append(frame);
    await within(new Promise((r) => (frame.onload = r)), 5000);
    const doc = frame.contentDocument;
    if (!doc) return frame.remove(), true;
    await within(Promise.all([...doc.images].map((img) => img.decode().catch(() => {}))), 5000);
    const { h } = this.cell();
    const rows = Math.max(1, Math.ceil(doc.documentElement.scrollHeight / h));
    frame.style.height = `${rows * h}px`;
    // Its rows: from the cursor's line (a new one if the cursor's in a line's text) down,
    // the cursor at the start of the line after them. (xterm.js's own, as its image addon
    // makes room for a picture.)
    const core = this.term._core, buffer = core.buffer;
    if (buffer.x) core._inputHandler.lineFeed(), (buffer.x = 0);
    const marker = this.term.registerMarker(0);
    if (!marker) return frame.remove(), true;
    for (let i = 0; i < rows; i++) core._inputHandler.lineFeed();
    buffer.x = 0;
    const block = { frame, marker, rows };
    marker.onDispose(() => {
      frame.remove();
      this.list = this.list.filter((b) => b !== block);
    });
    this.wire(doc);
    frame.classList.remove("measuring");
    this.list.push(block);
    this.place();
    return true;
  }

  // Each where its rows are now (or hidden: scrolled away, a full-screen program's screen).
  place() {
    if (this.placing) return;
    this.placing = requestAnimationFrame(() => {
      this.placing = 0;
      const buf = this.term.buffer.active, { h } = this.cell();
      for (const b of this.list) {
        const top = (b.marker.line - buf.viewportY) * h;
        const shown = buf.type === "normal" && top < this.term.rows * h && top + b.rows * h > 0;
        b.frame.style.display = shown ? "" : "none";
        if (shown) b.frame.style.transform = `translateY(${top}px)`;
      }
    });
  }

  // The lines from `line` (in the buffer) on erased: the blocks there go.
  dropBelow(line) {
    if (this.term.buffer.active.type !== "normal") return;
    for (const b of [...this.list]) if (b.marker.line + b.rows > line) b.marker.dispose();
  }

  // A block's own: the wheel scrolls the terminal, links open in the browser, its
  // selection copies; a key or a click that selects nothing gives the terminal its focus.
  wire(doc) {
    doc.addEventListener("wheel", (e) => {
      e.preventDefault();
      const lines = e.deltaMode === 1 ? e.deltaY : e.deltaY / this.cell().h;
      this.term.scrollLines(Math.round(lines) || Math.sign(e.deltaY));
    }, { passive: false });
    doc.addEventListener("click", (e) => {
      const a = e.target.closest?.("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (/^(https?|mailto):/i.test(href)) this.openLink(href);
    });
    doc.addEventListener("mouseup", () => {
      if (!doc.getSelection()?.toString()) this.term.focus();
    });
    doc.addEventListener("keydown", (e) => {
      const text = doc.getSelection()?.toString();
      if (text && (e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C" || e.key === "Insert")) {
        e.preventDefault();
        this.copy(text);
      }
      doc.getSelection()?.removeAllRanges();
      this.term.focus();
    });
  }
}

// A block's page: the theme's colors, Markdown's style, and it.
function page({ markdown, html, images = {} }) {
  const css = getComputedStyle(document.documentElement);
  const vars = VARS.map((v) => `${v}: ${css.getPropertyValue(v).trim()};`).join(" ");
  const resolve = (src) => images[src] ?? (/^(https?|data):/i.test(src) ? src : "");
  const style = `<style>
:root { ${vars} color-scheme: dark light; }
html, body { margin: 0; overflow: hidden; background: var(--bg); color: var(--text); }
::selection { background: var(--selection); }
.markdown { padding: 6px 12px 10px; max-width: 46rem; }
.markdown input { pointer-events: none; }
</style>`;
  const head = `<meta charset="utf-8"><link rel="stylesheet" href="${location.origin}/engine/ui/markdown.css">${style}`;
  if (markdown !== undefined) return `<!doctype html><html><head>${head}</head><body><article class="markdown">${render(markdown, { resolve }).html}</article></body></html>`;
  // A web page: ours first, its own styles after (its colors, if it has them).
  const doc = String(html ?? "");
  return /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (m) => m + head) : `<!doctype html><html><head>${head}</head><body>${doc}</body></html>`;
}

const within = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);

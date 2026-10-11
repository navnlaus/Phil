import { copyText, pasteText } from "/engine/ui/kit.js";

export const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Bash in a panel under the grid. The shell reports its directory after every
 * command (OSC 7, see src/shell-init.bash):
 *  - when the shell's directory changes, the file view follows (onCwd)
 *  - when the file view changes folder and the shell sits at an empty prompt,
 *    the shell changes directory too, without a command being typed: the
 *    server leaves the target for the prompt hook (__phil_follow) and sends an
 *    empty Enter, and the old prompt is erased so the new one replaces it.
 *    The prompt counts as empty again when what was typed is erased.
 */
export class TerminalPanel {
  constructor({ panel, container, onCwd, onBack, onOpen, isLocal, toLocal, toRemote }) {
    this.panel = panel;
    this.container = container;
    this.onCwd = onCwd;
    this.onBack = onBack; // the shell is back on this machine after ssh
    this.onOpen = onOpen; // phil-editor in the shell asks for an app in this window
    // ssh'd into another machine (phil's ssh, shell-init.bash): its folders
    // map to and from local ones on a network mount of it.
    this.isLocal = isLocal; // (host) => is this machine
    this.toLocal = toLocal; // (host, dir) => local path, or null
    this.toRemote = toRemote; // (path) => { host, dir }, or null
    this.remote = null; // the host the shell is on, when not this machine
    this.term = null;
    this.ws = null;
    this.cwd = null; // last directory the shell reported
    this.idle = false; // at a prompt with nothing typed since
    this.typedAt = null; // where the cursor was, and what followed it, at the first key typed at this prompt
    this.running = false; // a command was entered and its prompt hasn't come back
    this.promptRow = null; // buffer line where the current prompt began, if at column 0
    this.dropEcho = false; // swallow the newline bash echoes for a silent cd's Enter
    this.exited = false;
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  get isRunning() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async show(cwd, { focus = true } = {}) {
    this.panel.hidden = false;
    await (this.starting ??= this.start(cwd));
    requestAnimationFrame(() => {
      this.fit.fit();
      if (focus) this.term.focus();
    });
  }

  hide() {
    this.panel.hidden = true;
  }

  async start(cwd) {
    // xterm.js is big; it's only loaded once the panel is first opened.
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("/ui/vendor/xterm.mjs"),
      import("/ui/vendor/addon-fit.mjs"),
    ]);
    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();
    this.term = new Terminal({
      fontFamily: "monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: color("--bg"),
        foreground: color("--text"),
        cursor: color("--accent"),
        selectionBackground: color("--accent-bg"),
      },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.container);
    this.fit.fit();

    this.term.parser.registerOscHandler(7, (data) => {
      let path, host;
      try {
        const url = new URL(data);
        path = decodeURIComponent(url.pathname);
        host = url.hostname;
      } catch {
        return true;
      }
      // On another machine: the view follows if it's a folder on a mount of it.
      const wasRemote = !!this.remote;
      this.remote = host && !this.isLocal(host) ? host : null;
      if (this.remote) path = this.toLocal(host, path) ?? `ssh://${host}${path}`;
      const changed = path !== this.cwd;
      const buf = this.term.buffer.active;
      this.promptRow = buf.cursorX === 0 ? buf.baseY + buf.cursorY : null;
      this.cwd = path;
      this.idle = true;
      this.typedAt = null;
      this.running = false;
      // Back from ssh: the view stays where the remote shell left it, and this
      // shell follows it there instead.
      if (wasRemote && !this.remote) setTimeout(() => this.onBack?.(), 200); // once the prompt is drawn, so it's replaced
      else if (changed && path.startsWith("/")) this.onCwd(path);
      return true;
    });
    this.term.onData((data) => {
      if (this.exited) {
        if (data === "\r") this.connect(this.restartCwd ?? cwd);
        return;
      }
      this.typed(data);
      this.send(data);
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.isRunning) this.ws.send(JSON.stringify({ resize: [cols, rows] }));
    });
    // Let the panel and focus shortcuts reach the app instead of the shell.
    // Copying and pasting (Ctrl+Insert / Shift+Insert) go through the desktop's
    // clipboard (kit.js); xterm.js pastes into the shell as a paste.
    this.term.attachCustomKeyEventHandler((e) => {
      if (isToggleKey(e) || isFocusKey(e)) return false;
      const action = clipboardAction(e);
      if (action && e.type === "keydown") {
        e.preventDefault();
        if (action === "paste") pasteText().then((text) => text && this.term.paste(text));
        else if (this.term.hasSelection()) copyText(this.term.getSelection());
      }
      return !action;
    });
    new ResizeObserver(() => !this.panel.hidden && this.fit.fit()).observe(this.container);

    this.connect(cwd);
  }

  connect(cwd) {
    this.exited = false;
    this.idle = false;
    this.cwd = null;
    const params = new URLSearchParams({ cwd, cols: this.term.cols, rows: this.term.rows });
    const ws = new WebSocket(`ws://${location.host}/term?${params}`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data === "string") { // not terminal output: {open: {app, params}}
        const { open } = JSON.parse(e.data);
        if (open) this.onOpen?.(open);
        return;
      }
      let data = new Uint8Array(e.data);
      if (this.dropEcho) {
        this.dropEcho = false;
        if (data[0] === 13 && data[1] === 10) data = data.subarray(2);
      }
      this.term.write(data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.exited = true;
      this.term.write("\r\n\x1b[2m[shell exited, press Enter to start a new one]\x1b[0m\r\n");
    };
    this.ws = ws;
  }

  send(data) {
    if (this.isRunning) this.ws.send(new TextEncoder().encode(data));
  }

  // Keys (or text) about to go to the shell. The first ones at a prompt note
  // where the line began; Enter means a command runs.
  typed(data) {
    if (this.idle) {
      const buf = this.term.buffer.active;
      const row = buf.baseY + buf.cursorY;
      this.typedAt = { x: buf.cursorX, row, rest: this.textFrom(row, buf.cursorX) };
    }
    this.idle = false;
    if (/[\r\n]/.test(data)) this.running = true;
  }

  // The screen's text from (row, x) to the end of the buffer.
  textFrom(row, x) {
    const buf = this.term.buffer.active;
    const lines = [];
    for (let y = row; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true, y === row ? x : 0) ?? "");
    return lines.join("\n").trimEnd();
  }

  /**
   * At a prompt with an empty command line: nothing typed since the prompt, or
   * everything typed erased again (the cursor is back where typing began, and
   * the screen after it reads as it did then).
   */
  get atEmptyPrompt() {
    if (this.idle) return true;
    const at = this.typedAt;
    if (!at || this.running) return false;
    const buf = this.term.buffer.active;
    return buf.baseY + buf.cursorY === at.row && buf.cursorX === at.x && this.textFrom(at.row, at.x) === at.rest;
  }

  /**
   * The file view moved to `path`: follow it if the shell is at an empty
   * prompt. ssh'd in, if the folder is on the same machine (a mount of it).
   */
  follow(path) {
    if (!this.remote) this.restartCwd = path;
    if (!this.isRunning || !this.atEmptyPrompt || path === this.cwd) return;
    let message = { cd: path };
    if (this.remote) {
      const there = this.toRemote(path);
      if (!there || !this.isSameHost(there.host, this.remote)) return;
      message = { cd: there.dir || ".", host: this.remote };
    }
    this.idle = false;
    this.running = true;
    this.erasePrompt();
    this.ws.send(JSON.stringify(message));
  }

  isSameHost(a, b) {
    const name = (h) => h.replace(/^.*@/, "").split(".")[0].toLowerCase();
    return name(a) === name(b);
  }

  /** Runs a command at the prompt (typed, as if by hand); false if the shell is busy. */
  run(command) {
    if (!this.isRunning || !this.atEmptyPrompt) return false;
    this.typed(command + "\r");
    this.send(command + "\r");
    this.term.focus();
    return true;
  }

  // Clears the idle prompt and leaves the cursor where it began; the newline
  // bash echoes for the empty Enter is dropped, so the redrawn prompt takes
  // its exact place (even on the top row). Display-only: nothing is sent to
  // the shell. Skipped when the prompt's start isn't on screen.
  erasePrompt() {
    const buf = this.term.buffer.active;
    const promptLine = this.promptRow - buf.baseY; // viewport row
    if (this.promptRow === null || promptLine < 0) return;
    const up = buf.cursorY - promptLine;
    this.term.write(`${up > 0 ? `\x1b[${up}A` : ""}\r\x1b[J`);
    this.dropEcho = true;
  }

  /** Types text at the prompt (e.g. a quoted file path) and focuses the terminal. */
  insert(text) {
    if (!this.isRunning) return;
    this.typed(text);
    this.send(text);
    this.term.focus();
  }
}

// Ctrl+Insert copies the selection, Shift+Insert pastes: what Omarchy's
// universal Super+C / Super+V send a window tagged "terminal", as phil is (see
// README). Plain Ctrl+C / Ctrl+V stay the shell's.
function clipboardAction(e) {
  if (e.key !== "Insert" || e.altKey || e.metaKey || e.ctrlKey === e.shiftKey) return null;
  return e.ctrlKey ? "copy" : "paste";
}

export function isToggleKey(e) {
  return e.type === "keydown" && (e.key === "F4" || (e.ctrlKey && e.key === "`"));
}

/** Alt+↑ / Alt+↓: focus the folder view / the terminal (Tab belongs to the shell). */
export function isFocusKey(e) {
  return e.type === "keydown" && e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey &&
    (e.key === "ArrowUp" || e.key === "ArrowDown");
}

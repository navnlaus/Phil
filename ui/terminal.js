import { Terminal } from "/ui/vendor/xterm.mjs";
import { FitAddon } from "/ui/vendor/addon-fit.mjs";

export const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Bash in a panel under the grid. The shell reports its directory after every
 * command (OSC 7, see src/shell-init.bash):
 *  - when the shell's directory changes, the file view follows (onCwd)
 *  - when the file view changes folder and the shell sits at an empty prompt,
 *    a " cd -- '<path>'" is typed into it, like Dolphin's terminal panel does
 */
export class TerminalPanel {
  constructor({ panel, container, onCwd }) {
    this.panel = panel;
    this.container = container;
    this.onCwd = onCwd;
    this.term = null;
    this.ws = null;
    this.cwd = null; // last directory the shell reported
    this.idle = false; // at a prompt with nothing typed since
    this.exited = false;
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  get isRunning() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  show(cwd) {
    this.panel.hidden = false;
    if (!this.term) this.start(cwd);
    requestAnimationFrame(() => {
      this.fit.fit();
      this.term.focus();
    });
  }

  hide() {
    this.panel.hidden = true;
  }

  toggle(cwd) {
    if (this.isOpen) this.hide();
    else this.show(cwd);
  }

  start(cwd) {
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
      let path;
      try {
        path = decodeURIComponent(new URL(data).pathname);
      } catch {
        return true;
      }
      const changed = path !== this.cwd;
      this.cwd = path;
      this.idle = true;
      if (changed) this.onCwd(path);
      return true;
    });
    this.term.onData((data) => {
      if (this.exited) {
        if (data === "\r") this.connect(this.restartCwd ?? cwd);
        return;
      }
      this.idle = false;
      this.send(data);
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.isRunning) this.ws.send(JSON.stringify({ resize: [cols, rows] }));
    });
    // Let the panel shortcuts reach the app instead of the shell.
    this.term.attachCustomKeyEventHandler((e) => !isToggleKey(e));
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
    ws.onmessage = (e) => this.term.write(new Uint8Array(e.data));
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

  /** The file view moved to `path`: follow it if the shell is idle at a prompt. */
  follow(path) {
    this.restartCwd = path;
    if (!this.isRunning || !this.idle || path === this.cwd) return;
    this.idle = false;
    this.send(` cd -- ${shellQuote(path)}\r`);
  }

  /** Types text at the prompt (e.g. a quoted file path) and focuses the terminal. */
  insert(text) {
    if (!this.isRunning) return;
    this.idle = false;
    this.send(text);
    this.term.focus();
  }
}

export function isToggleKey(e) {
  return e.type === "keydown" && (e.key === "F4" || (e.ctrlKey && e.key === "`"));
}

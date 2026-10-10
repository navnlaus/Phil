// Pseudo-terminals over Deno FFI. Deno has no PTY API, so the master side is
// opened with libc and the shell is started through setsid, opening the slave
// device itself so it becomes the shell's controlling terminal.

const O_RDWR = 0x2;
const O_NOCTTY = 0x100;
const O_CLOEXEC = 0x80000; // or the shell (and every later child) inherits the master and the pty never hangs up
const TIOCSWINSZ = 0x5414;

const libc = Deno.dlopen("libc.so.6", {
  posix_openpt: { parameters: ["i32"], result: "i32" },
  grantpt: { parameters: ["i32"], result: "i32" },
  unlockpt: { parameters: ["i32"], result: "i32" },
  ptsname_r: { parameters: ["i32", "buffer", "usize"], result: "i32" },
  // read/write block (e.g. a full input buffer while a program ignores stdin),
  // so they run on Deno's blocking thread pool instead of the event loop.
  read: { parameters: ["i32", "buffer", "usize"], result: "isize", nonblocking: true },
  write: { parameters: ["i32", "buffer", "usize"], result: "isize", nonblocking: true },
  close: { parameters: ["i32"], result: "i32" },
  ioctl: { parameters: ["i32", "u64", "buffer"], result: "i32" },
});

export class Pty {
  /**
   * @param {string[]} command  argv of the program to run on the terminal
   * @param {{ cwd?: string, env?: Record<string, string>, cols?: number, rows?: number }} options
   */
  constructor(command, { cwd, env = {}, cols = 80, rows = 24 } = {}) {
    const fd = libc.symbols.posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
    if (fd < 0) throw new Error("posix_openpt failed");
    const name = new Uint8Array(128);
    if (libc.symbols.grantpt(fd) || libc.symbols.unlockpt(fd) || libc.symbols.ptsname_r(fd, name, name.length)) {
      libc.symbols.close(fd);
      throw new Error("could not set up pseudo-terminal");
    }
    this.fd = fd;
    this.closed = false;
    this.writing = Promise.resolve();
    this.resize(cols, rows);

    const slave = new TextDecoder().decode(name.subarray(0, name.indexOf(0)));
    // setsid gives the shell a new session; its first open() of the slave (no
    // O_NOCTTY) then makes that the controlling terminal, so job control works.
    this.child = new Deno.Command("setsid", {
      args: ["sh", "-c", 'exec <"$1" >"$1" 2>&1; shift; exec "$@"', "phil-pty", slave, ...command],
      cwd,
      env: { TERM: "xterm-256color", COLORTERM: "truecolor", ...env },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    this.exited = this.child.status;
  }

  /** Yields output chunks until the terminal is hung up (every slave fd closed). */
  async *output() {
    const buf = new Uint8Array(64 * 1024);
    while (!this.closed) {
      const n = Number(await libc.symbols.read(this.fd, buf, buf.length));
      if (n <= 0) break;
      yield buf.slice(0, n);
    }
  }

  write(data) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.writing = this.writing.then(async () => {
      for (let off = 0; off < bytes.length && !this.closed;) {
        const n = Number(await libc.symbols.write(this.fd, bytes.subarray(off), bytes.length - off));
        if (n <= 0) break;
        off += n;
      }
    });
    return this.writing;
  }

  resize(cols, rows) {
    if (this.closed) return;
    libc.symbols.ioctl(this.fd, BigInt(TIOCSWINSZ), new Uint16Array([rows, cols, 0, 0]));
  }

  /** Hangs up the shell and releases the master side. */
  async close() {
    if (this.closed) return;
    try {
      this.child.kill("SIGHUP");
    } catch { /* already gone */ }
    await this.exited.catch(() => {});
    this.closed = true;
    libc.symbols.close(this.fd);
  }
}

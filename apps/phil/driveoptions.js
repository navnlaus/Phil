// What phil does on a drive, set in its Properties: `thumbnails` (pictures',
// videos' and documents' previews, folders' faces made of them) and
// `folderSizes` (folders' totals, foldertotals.js), each true, false or unset
// (unset: thumbnails made; folder sizes as Preferences say). Kept by the
// drive's file system's UUID (a share: its source), so a drive keeps them
// wherever it's mounted, in ~/.config/phil/drives.json:
//   {"<uuid>": {"name": "<label or mount point>", "thumbnails": false, "folderSizes": true}}
// `readOnly` (incognito): changes last the session.
import { basename, dirname } from "@std/path";

const DRIVE_MS = 60_000; // a file system's drive (by device number), remembered this long

export class DriveOptions {
  #file;
  #readOnly;
  #all = null; // the file's, as last read
  #read = 0; // its modification time then
  #drives = new Map(); // st_dev -> { key, name, mount, at }

  constructor(file, { readOnly = false } = {}) {
    this.#file = file;
    this.#readOnly = readOnly;
  }

  /** The drive `path` is on: {key, name, mount}, or null. */
  async drive(path) {
    const dev = (await Deno.stat(path).catch(() => null))?.dev;
    if (dev === undefined) return null;
    const known = this.#drives.get(dev);
    if (known && Date.now() - known.at < DRIVE_MS) return known;
    try {
      const out = await new Deno.Command("findmnt", { args: ["-J", "-o", "UUID,SOURCE,TARGET,LABEL", "-T", path], stdin: "null", stdout: "piped", stderr: "null" }).output();
      const fs = JSON.parse(new TextDecoder().decode(out.stdout)).filesystems?.[0];
      if (!fs) return null;
      const drive = { key: fs.uuid || fs.source, name: fs.label || (fs.target === "/" ? "/" : basename(fs.target)), mount: fs.target, at: Date.now() };
      this.#drives.set(dev, drive);
      return drive;
    } catch {
      return null;
    }
  }

  /** The options of the drive `path` is on ({} when none are set). */
  async get(path) {
    const drive = await this.drive(path);
    return drive ? (await this.#load())[drive.key] ?? {} : {};
  }

  /** Sets the drive's `thumbnails` and `folderSizes` (true, false; null: as usual). */
  async set(path, changes) {
    const drive = await this.drive(path);
    if (!drive) throw new Error(`${path}: which drive it's on isn't known`);
    const all = await this.#load();
    const options = { ...all[drive.key], name: drive.name };
    for (const name of ["thumbnails", "folderSizes"]) {
      if (!(name in changes)) continue;
      if (typeof changes[name] === "boolean") options[name] = changes[name];
      else delete options[name];
    }
    if (Object.keys(options).length > 1) all[drive.key] = options;
    else delete all[drive.key];
    if (this.#readOnly) return;
    await Deno.mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(all, null, 2) + "\n");
    await Deno.rename(tmp, this.#file);
    this.#read = (await Deno.stat(this.#file)).mtime?.getTime() ?? 0;
  }

  // The file, read again when it changed (another phil, an edit by hand).
  async #load() {
    if (this.#all && this.#readOnly) return this.#all;
    const mtime = (await Deno.stat(this.#file).catch(() => null))?.mtime?.getTime() ?? 0;
    if (this.#all && mtime === this.#read) return this.#all;
    this.#read = mtime;
    this.#all = mtime ? await Deno.readTextFile(this.#file).then(JSON.parse).catch(() => ({})) : {};
    return this.#all;
  }
}

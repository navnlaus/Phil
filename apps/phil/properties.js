// Properties (right-click → Properties): what a file or folder is, its size,
// dates, owner and permissions, and whether you can change it.
import { basename, dirname, join } from "@std/path";
import { requireSudo, sudo } from "./sudo.js";

/** The facts about `path` (a link: about the link and what it points to). */
export async function properties(path) {
  const link = await Deno.lstat(path);
  const stat = link.isSymlink ? await Deno.stat(path).catch(() => null) : link;
  const target = link.isSymlink ? await Deno.readLink(path).catch(() => null) : null;
  const real = link.isSymlink ? await Deno.realPath(path).catch(() => null) : null;
  const of = stat ?? link;
  const [users, groups] = await Promise.all([idNames("/etc/passwd"), idNames("/etc/group")]);
  return {
    name: basename(path),
    path,
    folder: dirname(path),
    kind: !stat ? "broken link" : stat.isDirectory ? "folder" : stat.isFile ? "file" : "special",
    description: stat?.isFile ? await describe(path) : null,
    link: link.isSymlink ? { target, real } : null,
    size: of.size,
    modified: of.mtime?.getTime() ?? null,
    accessed: of.atime?.getTime() ?? null,
    created: of.birthtime?.getTime() ?? null,
    changed: of.ctime?.getTime() ?? null, // permissions or owner too
    mode: (of.mode ?? 0) & 0o7777,
    owner: users.get(of.uid) ?? String(of.uid),
    group: groups.get(of.gid) ?? String(of.gid),
    access: stat ? await access(stat, real ?? path) : null,
  };
}

/**
 * Everything inside a folder: {files, dirs, bytes, complete}. Links aren't
 * followed. Gives up after `ms` (complete: false), for very large trees.
 */
export async function folderSize(path, ms = 4000) {
  const end = Date.now() + ms;
  const total = { files: 0, dirs: 0, bytes: 0, complete: true };
  const queue = [path];
  const visit = async () => {
    while (queue.length) {
      if (Date.now() > end) return void (total.complete = false);
      const dir = queue.pop();
      let entries;
      try {
        entries = await Array.fromAsync(Deno.readDir(dir));
      } catch {
        continue; // no permission
      }
      for (const e of entries) {
        const child = `${dir === "/" ? "" : dir}/${e.name}`;
        if (e.isDirectory) total.dirs++, queue.push(child);
        else {
          total.files++;
          total.bytes += await Deno.lstat(child).then((s) => s.size, () => 0);
        }
      }
    }
  };
  // A few at once: the queue is shared, so they keep each other fed.
  while (queue.length && total.complete) await Promise.all(Array.from({ length: 8 }, visit));
  return total;
}

// What you can do with it: read, and write (change, for a folder).
async function access(stat, path) {
  const who = await me();
  const folder = stat.isFile ? await Deno.stat(dirname(path)).catch(() => null) : null;
  return { read: !!(permissions(stat, who) & 4), write: canWrite(stat, folder, who), mine: stat.uid === who.uid };
}

/**
 * Whether you can change it without sudo: a folder's contents, or a file,
 * which also takes its `folder` (the editors save by replacing the file
 * there). `who` is me().
 */
export function canWrite(stat, folder, who) {
  if (!(permissions(stat, who) & 2)) return false;
  return !stat.isFile || !!folder && !!(permissions(folder, who) & 2);
}

// The rwx bits that apply to `who`: the owner's, the group's or everyone's.
function permissions(stat, { uid, groups }) {
  if (uid === 0) return 7;
  const mode = stat.mode ?? 0;
  return stat.uid === uid ? (mode >> 6) & 7 : groups.has(stat.gid) ? (mode >> 3) & 7 : mode & 7;
}

// Who phil runs as: {uid, groups}, from id(1). (Deno.uid() and Deno.gid()
// need --allow-sys, and /proc/self all permissions, which the installed build
// doesn't have.)
let meOnce = null;
export function me() {
  const id = (flag) =>
    new Deno.Command("id", { args: [flag], stdin: "null", stderr: "null" }).output()
      .then((out) => new TextDecoder().decode(out.stdout).trim().split(/\s+/).filter(Boolean).map(Number));
  meOnce ??= Promise.all([id("-u"), id("-G")]).then(([[uid], groups]) => ({ uid, groups: new Set(groups) }));
  return meOnce;
}

// uid/gid -> name, from /etc/passwd or /etc/group.
async function idNames(file) {
  const names = new Map();
  try {
    for (const line of (await Deno.readTextFile(file)).split("\n")) {
      const [name, , id] = line.split(":");
      if (name && id) names.set(Number(id), name);
    }
  } catch { /* numbers it is */ }
  return names;
}

// file(1)'s description: "ASCII text", "PNG image data, 640 x 480, ...".
async function describe(path) {
  try {
    const out = await new Deno.Command("file", { args: ["-b", "-L", "--", path], stdin: "null", stderr: "null" }).output();
    return new TextDecoder().decode(out.stdout).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- drives

const run = async (cmd, args, ms = 10_000) => {
  const out = await new Deno.Command(cmd, { args, stdin: "null", stdout: "piped", stderr: "piped", signal: AbortSignal.timeout(ms) }).output();
  return { ok: out.success, code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
};

/**
 * The drive a mount point is on (Properties of the sidebar's drives): {mount,
 * fstype, source, network, disk: {path, model, serial, size, transport,
 * rotational}, speed}: the physical disk under partitions, encryption and the
 * like; `speed` is the last read speed test of it (driveSpeed), or null.
 */
export async function driveInfo(path, cacheFile) {
  const fm = await run("findmnt", ["-J", "-o", "SOURCE,FSTYPE,TARGET", "--mountpoint", path]);
  const all = fm.ok ? JSON.parse(fm.stdout).filesystems ?? [] : [];
  const fs = all.filter((f) => f.fstype !== "autofs").at(-1) ?? all[0]; // an automount: the share mounted on it
  if (!fs) return null;
  const source = fs.source.replace(/\[.*\]$/, ""); // btrfs: /dev/mapper/root[/@]
  const info = { mount: fs.target, fstype: fs.fstype, source, network: !source.startsWith("/dev/"), disk: null, speed: null };
  if (info.network) {
    info.speed = (await readSpeeds(cacheFile))[`net|${source}`] ?? null;
    return info;
  }
  const tree = await run("lsblk", ["-J", "-s", "-o", "NAME,TYPE,PATH,MODEL,SERIAL,SIZE,TRAN,ROTA", source]);
  if (tree.ok) {
    // -s: inverted, the device first and what it's on as its children, down to the disk.
    let node = JSON.parse(tree.stdout).blockdevices?.[0], transport = null;
    while (node) {
      transport ??= node.tran;
      if (node.type === "disk") {
        info.disk = { path: node.path, model: node.model?.trim() || null, serial: node.serial?.trim() || null, size: node.size, transport: node.tran ?? transport, rotational: !!node.rota };
        break;
      }
      node = node.children?.[0];
    }
  }
  if (info.disk) info.speed = (await readSpeeds(cacheFile))[speedKey(info.disk)] ?? null;
  return info;
}

/**
 * A network share's speed both ways: a test file of random data (compression
 * can't flatter it) written to it for up to 10 s, then read back for up to
 * 10 s, both past the page cache (O_DIRECT: over the network each time), and
 * removed. No root: it's the user's share. {write, read} in MB/s, kept in
 * `cacheFile` by the share ("net|host:/path").
 */
async function shareSpeed(info, cacheFile) {
  const key = `net|${info.source}`;
  if (testing.has(key)) throw new Error("A test of this share is running already");
  testing.add(key);
  const file = join(info.mount, `.phil-speed-test-${crypto.randomUUID().slice(0, 8)}`);
  // At 10 s, USR1 makes dd report how far it got; killed a second later.
  const dd = async (args) => {
    const r = await run("timeout", ["-s", "USR1", "-k", "1", "10", "dd", ...args], 60_000);
    const m = /(\d+) bytes .*copied, ([\d.]+) s/.exec(r.stderr);
    if (!m || !Number(m[1]) || !Number(m[2])) throw new Error(r.stderr.trim().split("\n").at(-1) || "dd failed");
    return Number(m[1]) / Number(m[2]) / 1048576;
  };
  try {
    const write = await dd(["if=/dev/urandom", `of=${file}`, "bs=4M", "count=256", "oflag=direct"]).catch((err) => {
      throw new Error(`Couldn't write a test file to it: ${err.message}`);
    });
    const read = await dd([`if=${file}`, "of=/dev/null", "bs=4M", "iflag=direct"]);
    const result = { read, write, at: Date.now(), share: info.source };
    const all = await readSpeeds(cacheFile);
    all[key] = result;
    await Deno.mkdir(dirname(cacheFile), { recursive: true });
    await Deno.writeTextFile(cacheFile, JSON.stringify(all, null, 2) + "\n");
    return result;
  } finally {
    testing.delete(key);
    await Deno.remove(file).catch(() => {});
  }
}

const speedKey = (disk) => (disk.model || disk.serial ? `${disk.model ?? ""}|${disk.serial ?? ""}` : disk.path);

async function readSpeeds(cacheFile) {
  try {
    return JSON.parse(await Deno.readTextFile(cacheFile));
  } catch {
    return {};
  }
}

const testing = new Set(); // disks being timed now

/**
 * Times reading from the drive under mount point `path`: up to 4 GB read
 * straight from the disk (dd, O_DIRECT: past the page cache), stopped after 15 s
 * on a slow one. Not hdparm -t: it flushes the disk's caches first, which can
 * wait behind everything else on the disk (it did, for minutes).
 *
 * As root, with sudo (sudo.js: a 401 when it wants the password, which the
 * page asks for).
 *
 * Kept in `cacheFile` by the disk's model and serial, for driveInfo to show:
 * {read} in MB/s, `at`.
 */
export async function driveSpeed(path, cacheFile) {
  const info = await driveInfo(path, cacheFile);
  if (info?.network) return await shareSpeed(info, cacheFile);
  if (!info?.disk) throw new Error("Not a drive");
  await requireSudo("Reading the disk directly needs root.");
  if (testing.has(info.disk.path)) throw new Error("A test of this drive is running already");
  testing.add(info.disk.path);
  let r;
  try {
    // At 15 s, USR1 makes dd report how far it got (SIGINT may be ignored here); killed a second later.
    r = await sudo(["timeout", "-s", "USR1", "-k", "1", "15", "dd", `if=${info.disk.path}`, "of=/dev/null", "bs=4M", "count=1024", "iflag=direct"]);
  } catch {
    throw new Error("The test didn't finish");
  } finally {
    testing.delete(info.disk.path);
  }
  // dd's report (the first, if it made two): "2147483648 bytes (2.1 GB, 2.0 GiB) copied, 0.71 s, 3.0 GB/s"
  const m = /(\d+) bytes .*copied, ([\d.]+) s/.exec(r.stderr);
  if (!m || !Number(m[2])) throw new Error(r.stderr.trim().split("\n").at(-1) || "dd failed");
  const result = { read: Number(m[1]) / Number(m[2]) / 1048576, bytes: Number(m[1]), seconds: Number(m[2]), at: Date.now(), device: info.disk.path };
  const all = await readSpeeds(cacheFile);
  all[speedKey(info.disk)] = result;
  await Deno.mkdir(dirname(cacheFile), { recursive: true });
  await Deno.writeTextFile(cacheFile, JSON.stringify(all, null, 2) + "\n");
  return result;
}

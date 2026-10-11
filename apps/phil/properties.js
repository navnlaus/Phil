// Properties (right-click → Properties): what a file or folder is, its size,
// dates, owner and permissions, and whether you can change it.
import { basename, dirname } from "@std/path";

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

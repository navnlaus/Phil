// The phone link: phones paired with phil (phil's Android app, android/) show in
// its sidebar, their files mounted over SFTP by gvfs when opened; and a light
// phil of this PC's files on the phone. The phone talks to the link server here
// (LINK_PORT, every address: the Wi-Fi's, Tailscale's), HTTPS with a certificate
// of its own (~/.config/phil/link/, made once), which the phone trusts by its
// fingerprint: seen when pairing, and compared by eye then (both show its start).
//
// Pairing: phil's "Add a phone…" shows a code (and the fingerprint); the app
// finds phil on the Wi-Fi (mDNS: _phil._tcp, avahi-publish) or is given its
// address, and sends the code with what phil needs to reach its files (its SFTP
// port, login, and host key's fingerprint). It gets a token, its key here from
// then on (kept as a hash). Only while that dialog is open, and five wrong codes
// end it.
//
// Then the phone checks in (POST /link/hello: its addresses, battery, free space) when it
// starts, when its network changes and every five minutes; phil lists it as in
// reach if it has in the last few, and answers with the app's version here: a
// phone with an older one offers to update itself (GET /link/app.apk). Opening it mounts sftp://phil@<address>:<port>/
// (gio mount, locate.js), at its Wi-Fi address if it's on this one, else its
// Tailscale one, the login answered and its host key the one it paired with. What's shared to phil on the phone (Share → "Send to PC") comes
// in at POST /link/upload, into the Downloads folder, in the Transfers list as
// it comes.
//
// Kept in ~/.config/phil/phones.json (readable only by you: the phones' SFTP
// logins are in it): {"phones": [{id, name, model, tokenHash, sftp: {port, user,
// password, hostKey, publicKey}, addresses, remote, seen, battery, sharing,
// paired, mounts}]}. `mounts`: where gvfs has its files, at each address it was
// reached at ({host: path}). Its host key goes in ssh's known_hosts for the
// address it's mounted from, before it is: ssh takes that key, and no other.
//
// The app's light phil (its own page, in the app: the phone's files and these)
// asks for this PC's at /m/: folders as phil lists them, with phil's thumbnails
// and folder summaries (the app keeps the thumbnails), files (played,
// downloaded), files sent into a folder; and /link/theme, phil's look.

import { basename, dirname, join, normalize } from "@std/path";
import { httpError, json, serveFile, text } from "../../engine/http.js";
import { currentTheme, themeFile } from "../../engine/themes.js";
import { downloadDir, reportsDir } from "./browserdownloads.js";
import { gioInfo, mount } from "./locate.js";

export const LINK_PORT = Number(Deno.env.get("PHIL_LINK_PORT")) || 47210; // (PHIL_LINK_PORT: another, for testing)
const ONLINE_MS = 7 * 60_000; // a check-in within this: in reach (they come every five minutes)
const PAIR_MS = 10 * 60_000; // "Add a phone…" open this long at most
const MAX_TRIES = 5; // wrong codes before pairing ends
const enc = new TextEncoder();

/**
 * The link, for phil's server: `configDir` (~/.config/phil), `broadcast` (to
 * every window), `thumbs` (thumbs.js's Thumbnailer), `list(dir)` (a folder's
 * entries as phil's page gets them: thumbnails made, folder summaries saved),
 * `summary(dir)` (a folder's summary, made now), `touched(dir)` (a file was
 * added there), `apk` (phil's Android app, offered while pairing, if it's
 * there). Call start(); stop() frees the port (an engine retiring).
 */
export function createLink({ configDir, broadcast, thumbs, list, summary: summaryOf, touched = () => {}, apk = null }) {
  const stateFile = join(configDir, "phones.json");
  const certDir = join(configDir, "link");
  let phones = null; // [phone], loaded first
  let pairing = null; // {code, expires, tries}
  let server = null, avahi = null, cert = null, fingerprint = null;
  let problem = null; // why it isn't listening (the port taken)
  let retry = null, stopped = false;
  let lastShown = ""; // the list as the sidebar has it (what changes it is broadcast)

  async function load() {
    if (phones) return phones;
    try {
      phones = JSON.parse(await Deno.readTextFile(stateFile)).phones ?? [];
    } catch {
      phones = [];
    }
    return phones;
  }

  async function save() {
    await Deno.mkdir(configDir, { recursive: true });
    const tmp = `${stateFile}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify({ phones }, null, 2) + "\n", { mode: 0o600 });
    await Deno.rename(tmp, stateFile);
  }

  // What the sidebar shows of each (no secrets).
  function shown() {
    return (phones ?? []).map((p) => ({
      id: p.id, name: p.name, model: p.model, online: Date.now() - (p.seen ?? 0) < ONLINE_MS, seen: p.seen ?? null,
      battery: p.battery ?? null, storage: p.storage ?? null, sharing: p.sharing !== false, addresses: p.addresses ?? [],
    }));
  }

  // The sidebar's list, to every window, when what it shows changed (a phone came or went out of reach...).
  function changed() {
    const now = JSON.stringify(shown().map(({ seen: _, ...p }) => p));
    if (now === lastShown) return;
    lastShown = now;
    broadcast({ phones: shown() });
  }
  const watch = setInterval(changed, 60_000); // (out of reach: by time passing)

  // ---------------------------------------------------------------- listening

  async function start() {
    stopped = false;
    await load();
    lastShown = JSON.stringify(shown().map(({ seen: _, ...p }) => p));
    try {
      cert ??= await certificate(certDir);
      fingerprint ??= await certFingerprint(cert.cert);
    } catch (err) {
      problem = `No certificate: ${err.message}`;
      return;
    }
    try {
      server = Deno.serve({
        hostname: "0.0.0.0",
        port: LINK_PORT,
        cert: cert.cert,
        key: cert.key,
        onListen() {},
        onError: jsonError,
      }, (req, info) => handle(req, info).catch((err) => jsonError(err)));
      problem = null;
      publish();
    } catch (err) {
      // Another engine has it (one retiring, a development one): again in a while.
      problem = err instanceof Deno.errors.AddrInUse ? `Port ${LINK_PORT} is taken (another phil?)` : err.message;
      if (!stopped) retry = setTimeout(start, 30_000);
    }
  }

  async function stop() {
    stopped = true;
    clearTimeout(retry);
    clearInterval(watch);
    const publisher = avahi;
    avahi = null;
    try {
      publisher?.kill();
    } catch { /* gone */ }
    await server?.shutdown().catch(() => {});
    server = null;
  }

  // On the Wi-Fi, by mDNS (avahi): the app finds phil there, and its address when it
  // changes. An announcement left by an engine that's gone (killed: its avahi-publish
  // outlives it) would take the name, pointing at nothing: it goes first, this engine
  // having the port. One that stops (avahi restarted) is made again in a while.
  async function publish() {
    const name = await hostname();
    if (stopped || !server) return;
    await new Deno.Command("pkill", { args: ["-f", "^(/usr/bin/)?avahi-publish-service -s phil on "], stdin: "null", stdout: "null", stderr: "null" }).output().catch(() => {});
    try {
      const mine = avahi = new Deno.Command("avahi-publish-service", {
        args: ["-s", `phil on ${name}`, "_phil._tcp", String(LINK_PORT), `fp=${fingerprint.slice(0, 16)}`, "v=1"],
        stdin: "null", stdout: "null", stderr: "null",
      }).spawn();
      mine.status.then(() => {
        if (avahi !== mine) return;
        avahi = null;
        if (!stopped) retry = setTimeout(publish, 60_000);
      });
    } catch { /* no avahi: the address is typed */ }
  }

  // ---------------------------------------------------------------- requests

  async function handle(req, info) {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    const remote = info?.remoteAddr?.hostname ?? null;
    switch (route) {
      case "GET /link/info": // (anyone) its name, and whether it's pairing
        return json({ name: await hostname(), pairing: !!pairingNow(), v: 1 });
      case "POST /link/pair":
        return json(await pair(await req.json(), remote));
      case "GET /app": // (anyone, while pairing) the app: typed in the phone's browser
      case "GET /phil.apk":
        if (!pairingNow() || !apk) return text(404, "Not found");
        return serveFile(req, apk, { "content-type": "application/vnd.android.package-archive", "content-disposition": 'attachment; filename="phil.apk"' });
    }
    // The rest: a paired phone's (its token, in a header).
    const phone = await phoneFor(tokenOf(req));
    if (!phone) return jsonError(httpError(401, "Not paired"));
    switch (route) {
      case "GET /link/me": // (the app, opening) still paired? And the app's version here.
        return json({ name: phone.name, pc: await hostname(), app: await appVersion() });
      case "GET /link/app.apk": // the app, for a phone updating itself (it checks the sha256 /link/me gave it)
        if (!await appVersion()) return text(404, "No app here");
        return serveFile(req, apk, { "content-type": "application/vnd.android.package-archive" });
      case "POST /link/hello":
        return json(await hello(phone, await req.json(), remote));
      case "POST /link/unpair":
        await forget(phone.id, { unmount: true });
        return json({ ok: true });
      case "POST /link/upload": // Share → phil: into the Downloads folder
        return json(await receive(req, downloadDir(), url.searchParams.get("name"), phone));
      case "GET /link/theme": // phil's look, for the app's: the shared styles and the theme in use
        return json(await themeNow());
      case "GET /m/api/places":
        return json(await placesHere());
      case "GET /m/api/list":
        return json(await listing(pathParam(url), url.searchParams.get("hidden") === "1"));
      case "GET /m/api/summary": // a folder's, for its tile (its previews: thumbnails by name, /m/thumbs/...)
        return json(appSummary(await summaryOf(pathParam(url))));
      case "GET /m/file":
      case "HEAD /m/file": {
        const path = pathParam(url);
        const headers = url.searchParams.get("dl") === "1" ? { "content-disposition": attachment(basename(path)) } : { "content-security-policy": "sandbox" };
        return serveFile(req, path, headers);
      }
      case "GET /m/thumb":
        return thumbnail(req, pathParam(url));
      case "POST /m/api/upload": // the light phil's: into the folder shown
        return json(await receive(req, pathParam(url, "dir"), url.searchParams.get("name"), phone));
    }
    // A thumbnail by its name (a listing's, a folder summary's): always the same picture (the app keeps it).
    const named = /^\/m\/thumbs\/[^/]+\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && named) {
      const file = thumbs.fileFor(named[1]);
      if (file) return serveFile(req, file, { "cache-control": "private, max-age=31536000, immutable" });
    }
    return text(404, "Not found");
  }

  function pairingNow() {
    if (pairing && Date.now() > pairing.expires) pairing = null, broadcast({ phonePairing: { ended: "time" } });
    return pairing;
  }

  async function pair(body, remote) {
    const p = pairingNow();
    if (!p) throw httpError(403, "phil isn't pairing now: open \"Add a phone…\" there first");
    if (String(body.code ?? "").trim() !== p.code) {
      if (++p.tries >= MAX_TRIES) {
        pairing = null;
        broadcast({ phonePairing: { ended: "tries" } });
        throw httpError(403, "Wrong code too many times: pairing ended. Start it again in phil.");
      }
      throw httpError(403, "That's not the code phil shows");
    }
    const { phoneId, name, model, sftp } = body;
    if (!/^[\w-]{8,64}$/.test(phoneId ?? "")) throw httpError(400, "No phone id");
    if (!sftp || !Number.isInteger(sftp.port) || typeof sftp.user !== "string" || typeof sftp.password !== "string") throw httpError(400, "No SFTP login");
    if (!KEY_LINE.test(sftp.publicKey ?? "") || await keyFingerprint(sftp.publicKey) !== sftp.hostKey) throw httpError(400, "No SFTP host key (or not the one it says)");
    const token = randomToken();
    await load();
    const old = phones.find((x) => x.id === phoneId);
    const phone = {
      id: phoneId, name: clean(name) || "Phone", model: clean(model), tokenHash: await sha256(token),
      sftp: { port: sftp.port, user: sftp.user, password: sftp.password, hostKey: sftp.hostKey, publicKey: sftp.publicKey },
      addresses: [], remote, seen: Date.now(), battery: null, sharing: true, paired: Date.now(), mounts: old?.mounts ?? {},
    };
    phones = [...phones.filter((x) => x.id !== phoneId), phone];
    await save();
    pairing = null;
    broadcast({ phonePairing: { paired: phone.name, id: phone.id } });
    changed();
    return { token, name: await hostname(), hosts: await addressesHere() };
  }

  async function hello(phone, body, remote) {
    phone.addresses = (Array.isArray(body.addresses) ? body.addresses : []).filter((a) => typeof a === "string" && /^[\d.]+$/.test(a)).slice(0, 8);
    phone.remote = remote;
    phone.seen = Date.now();
    if (body.name) phone.name = clean(body.name) || phone.name;
    if (body.model) phone.model = clean(body.model);
    phone.battery = body.battery && Number.isFinite(body.battery.percent) ? { percent: Math.round(body.battery.percent), charging: !!body.battery.charging } : null;
    phone.storage = body.storage && Number.isFinite(body.storage.free) && Number.isFinite(body.storage.total) ? { free: body.storage.free, total: body.storage.total } : null;
    phone.sharing = body.sharing !== false;
    await save();
    changed();
    return { hosts: await addressesHere(), app: await appVersion() };
  }

  // The app's version here (scripts/install.sh puts it next to it): {code, name, sha256},
  // or null. A phone with an older one is offered it (its check-ins have this).
  async function appVersion() {
    if (!apk) return null;
    try {
      const v = JSON.parse(await Deno.readTextFile(`${apk}.json`));
      return Number.isInteger(v.code) && /^[0-9a-f]{64}$/.test(v.sha256) && await Deno.stat(apk).then((s) => s.isFile, () => false) ? v : null;
    } catch {
      return null;
    }
  }

  async function phoneFor(token) {
    if (!token) return null;
    const hash = await sha256(token);
    return (await load()).find((p) => p.tokenHash === hash) ?? null;
  }

  // ---------------------------------------------------------------- the sidebar's

  // "Add a phone…": pairing for a while, its code; and what the dialog shows.
  async function pairStart() {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    pairing = { code, expires: Date.now() + PAIR_MS, tries: 0 };
    const addresses = await addressesHere();
    const wifi = addresses.find((a) => !isTailscale(a));
    return {
      code,
      fingerprint: fingerprint ? shortFingerprint(fingerprint) : null,
      port: LINK_PORT,
      addresses,
      problem,
      firewall: await firewallBlocks(),
      apk: apk && wifi && await Deno.stat(apk).then(() => true, () => false) ? `https://${wifi}:${LINK_PORT}/app` : null,
      expires: pairing.expires,
    };
  }

  function pairStop() {
    pairing = null;
  }

  // A phone's files: mounted (at an address that answers) and their path here.
  async function open(id) {
    const phone = (await load()).find((p) => p.id === id);
    if (!phone) throw httpError(404, "No such phone");
    if (phone.sharing === false) throw httpError(409, `${phone.name} isn't sharing its files: turn it on in phil there`);
    const host = await reachableHost(phone);
    if (!host) {
      throw httpError(409, `${phone.name} isn't in reach. ` +
        (Date.now() - (phone.seen ?? 0) < ONLINE_MS ? "It checked in a moment ago: is something blocking its port?" : "Is phil's app sharing there, and the phone on this Wi-Fi (or Tailscale on, on both)?"));
    }
    const { port, user, password, publicKey } = phone.sftp;
    if (!publicKey) throw httpError(409, `Pair ${phone.name} again (phil needs its key, which it didn't give before)`);
    const url = `sftp://${user}@${host}:${port}/`;
    // ssh is told the key it paired with, for this address: it takes that, and no other.
    await knowHostKey(host, port, publicKey);
    let ask;
    try {
      ask = await mount(url, { login: { user, password } });
    } catch (err) {
      if (/verif|identity|host key/i.test(err.message)) throw httpError(409, `${phone.name} at ${host} isn't the phone paired with (its key is another). Pair it again if phil's app was reinstalled.`);
      throw httpError(409, `${phone.name}: ${err.message}`);
    }
    if (ask?.login) throw httpError(409, `${phone.name} didn't take phil's login: pair it again`);
    if (ask?.question) throw httpError(409, `${phone.name} at ${host}: ${ask.question}`);
    const here = await gioInfo(url);
    if (!here) throw httpError(500, "gvfs mounted it but has no path for it");
    if (phone.mounts?.[host] !== here.path) {
      phone.mounts = { ...phone.mounts, [host]: here.path };
      await save();
    }
    return { path: here.path, host };
  }

  async function rename(id, name) {
    const phone = (await load()).find((p) => p.id === id);
    if (!phone) throw httpError(404, "No such phone");
    phone.name = clean(name) || phone.name;
    await save();
    changed();
    return { ok: true };
  }

  // Forgotten here (its token no longer works; the app learns at its next check-in).
  async function forget(id, { unmount = true } = {}) {
    const phone = (await load()).find((p) => p.id === id);
    if (!phone) return { ok: true };
    phones = phones.filter((p) => p !== phone);
    await save();
    changed();
    if (unmount) {
      for (const host of Object.keys(phone.mounts ?? {})) {
        await new Deno.Command("gio", { args: ["mount", "-u", `sftp://${phone.sftp.user}@${host}:${phone.sftp.port}/`], stdin: "null", stdout: "null", stderr: "null" }).output().catch(() => {});
      }
    }
    return { ok: true };
  }

  async function phonesList() {
    await load();
    return shown();
  }

  // A folder for the app: phil's own entries (their thumbnails, if made, by name:
  // /m/thumbs/...; folders' summaries), folders first.
  async function listing(dir, hidden) {
    dir = normalize(dir);
    const entries = (await list(dir)).filter((e) => hidden || !e.name.startsWith(".")).map((e) => ({
      name: e.name, path: e.path, kind: e.kind === "file" ? audioKind(e.name) ?? "file" : e.kind, size: e.size, mtime: e.mtime,
      thumb: typeof e.thumb === "string" && e.thumb.startsWith("/thumbs/") ? `/m${e.thumb}` : null,
      summary: e.kind === "dir" ? appSummary(e.summary) : undefined,
    }));
    entries.sort((a, b) => (a.kind === "dir") === (b.kind === "dir") ? collator.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1);
    return { path: dir, parent: dir === "/" ? null : dirname(dir), entries };
  }

  // The gvfs mount points of phones (their paths here): {path: name}, for showing their names.
  async function mountNames() {
    const names = {};
    for (const p of await load()) for (const path of Object.values(p.mounts ?? {})) names[path] = p.name;
    return names;
  }

  // ---------------------------------------------------------------- files

  // Received from the phone into `dir`, under its own name (one there already:
  // "name (2).ext"), as a .part file first; in the Transfers list meanwhile.
  async function receive(req, dir, name, phone) {
    if (!req.body) throw httpError(400, "Nothing sent");
    dir = normalize(dir);
    if (!(await Deno.stat(dir).then((s) => s.isDirectory, () => false))) throw httpError(404, `No folder ${dir}`);
    const safe = String(name ?? "").replace(/[/\0]/g, "_").replace(/^\.+/, "").trim().slice(0, 200) || "file";
    const target = await freeName(join(dir, safe));
    const part = join(dir, `.${basename(target)}.part`);
    const total = Number(new URL(req.url).searchParams.get("size")) || Number(req.headers.get("content-length")) || null;
    const id = crypto.randomUUID(), started = Date.now();
    const reportFile = join(reportsDir(), `${id}.json`);
    let bytes = 0, reported = 0;
    const report = () =>
      Deno.writeTextFile(reportFile, JSON.stringify({
        id, app: phone.name, name: basename(target), target, path: part, bytes, total, percent: total ? (bytes / total) * 100 : null,
        speed: bytes / Math.max(0.001, (Date.now() - started) / 1000), state: "receiving", started, pid: Deno.pid,
      })).catch(() => {});
    await Deno.mkdir(reportsDir(), { recursive: true, mode: 0o700 }).catch(() => {});
    const file = await Deno.open(part, { write: true, createNew: true });
    try {
      await req.body.pipeThrough(new TransformStream({
        transform(chunk, out) {
          bytes += chunk.length;
          if (Date.now() - reported > 500) (reported = Date.now()), report();
          out.enqueue(chunk);
        },
      })).pipeTo(file.writable);
      if (total && bytes !== total) throw new Error(`only ${bytes} of ${total} bytes came`);
      await Deno.rename(part, target);
      touched(dir);
      return { path: target };
    } catch (err) {
      await Deno.remove(part).catch(() => {});
      throw httpError(500, `It didn't all come: ${err.message}`);
    } finally {
      await Deno.remove(reportFile).catch(() => {});
    }
  }

  async function thumbnail(req, path) {
    try {
      const url = await thumbs.get(path);
      if (url.startsWith("/thumbs/")) return serveFile(req, thumbs.fileFor(basename(url)), { "cache-control": "private, max-age=31536000, immutable" });
      if (url.startsWith("/file?")) return serveFile(req, new URLSearchParams(url.slice(6)).get("path"));
    } catch (err) {
      if (err.busy) return new Response(null, { status: 503, headers: { "retry-after": String(Math.ceil((err.retryIn ?? 2000) / 1000)) } });
      if (Deno.env.get("PHIL_TRACE")) console.error(`phil: link: no thumbnail of ${path}: ${err.message}`);
    }
    return text(404, "No thumbnail");
  }

  return { start, stop, list: phonesList, pairStart, pairStop, open, rename, forget, mountNames, status: () => ({ listening: !!server, problem }) };
}

// ---------------------------------------------------------------- the app's light phil

// A folder summary as the app has it: its previews' thumbnails by name
// (/m/thumbs/...; ones not made yet left out: it asks again), texts as they are.
function appSummary(s) {
  if (!s) return null;
  const previews = (s.previews ?? []).map((p) => (typeof p === "string" ? { url: p } : p))
    .map((p) => (p.url?.startsWith("/thumbs/") ? { url: `/m${p.url}` } : p.text ? { text: p.text } : null)).filter(Boolean);
  return { files: s.files, dirs: s.dirs, size: s.size, previews, complete: s.complete !== false };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// The theme in use: base.css (the shared styles) and its own file, from the themes folder.
async function themeNow() {
  const name = await currentTheme();
  const read = async (file) => (await themeFile(file)).text();
  return { name, base: await read("base.css"), css: await read(`${name}.css`) };
}

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|wma|alac|aiff?)$/i;
const audioKind = (name) => (AUDIO_EXT.test(name) ? "audio" : null);

async function placesHere() {
  const home = Deno.env.get("HOME") ?? "/";
  const dirs = {};
  try {
    const file = await Deno.readTextFile(join(Deno.env.get("XDG_CONFIG_HOME") || join(home, ".config"), "user-dirs.dirs"));
    for (const [, key, value] of file.matchAll(/^XDG_(\w+)_DIR="(.*)"$/gm)) dirs[key] = value.replace(/^\$HOME/, home);
  } catch { /* the usual names */ }
  const named = [["Home", home, "home"], ["Desktop", dirs.DESKTOP ?? join(home, "Desktop"), "monitor"], ["Documents", dirs.DOCUMENTS ?? join(home, "Documents"), "file-text"],
    ["Downloads", dirs.DOWNLOAD ?? join(home, "Downloads"), "download"], ["Pictures", dirs.PICTURES ?? join(home, "Pictures"), "image"],
    ["Videos", dirs.VIDEOS ?? join(home, "Videos"), "film"], ["Music", dirs.MUSIC ?? join(home, "Music"), "music"]];
  const out = [];
  for (const [name, path, icon] of named) if (path === home || await Deno.stat(path).then((s) => s.isDirectory, () => false)) out.push({ name, path, icon });
  return { home, places: out, name: await hostname() };
}

function pathParam(url, key = "path") {
  const path = url.searchParams.get(key);
  if (!path || !path.startsWith("/")) throw httpError(400, `${key}, please`);
  return normalize(path);
}

// ---------------------------------------------------------------- helpers

async function freeName(path) {
  const dir = dirname(path), name = basename(path);
  const dot = name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length;
  const taken = (p) => Deno.lstat(p).then(() => true, () => false);
  let out = path;
  for (let n = 2; await taken(out) || await taken(join(dir, `.${basename(out)}.part`)); n++) out = join(dir, `${name.slice(0, dot)} (${n})${name.slice(dot)}`);
  return out;
}

const attachment = (name) => `attachment; filename="${name.replace(/["\\\r\n]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
// deno-lint-ignore no-control-regex
const clean = (s) => String(s ?? "").replace(/[\0-\x1f]/g, "").trim().slice(0, 80);
const jsonError = (err) => new Response(JSON.stringify({ error: err.message }), { status: err.status ?? 500, headers: { "content-type": "application/json" } });

const tokenOf = (req) => /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(s) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", typeof s === "string" ? enc.encode(s) : s));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

// The certificate's SHA-256 (of its DER), hex: what the app pins.
function certFingerprint(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return sha256(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

// As the app shows it, to compare: its first 8 bytes, in fours.
const shortFingerprint = (hex) => hex.slice(0, 16).toUpperCase().match(/.{4}/g).join(" ");

// The link's certificate (EC P-256, for a hundred years), made the first time.
async function certificate(dir) {
  const certFile = join(dir, "cert.pem"), keyFile = join(dir, "key.pem");
  try {
    return { cert: await Deno.readTextFile(certFile), key: await Deno.readTextFile(keyFile) };
  } catch { /* made below */ }
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const { success, stderr } = await new Deno.Command("openssl", {
    args: ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "36500", "-subj", "/CN=phil"],
    stdin: "null", stdout: "null", stderr: "piped",
  }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr).trim() || "openssl failed");
  await Deno.chmod(keyFile, 0o600);
  return { cert: await Deno.readTextFile(certFile), key: await Deno.readTextFile(keyFile) };
}

async function hostname() {
  return (await Deno.readTextFile("/etc/hostname").catch(() => "")).trim() || Deno.env.get("HOSTNAME") || "PC";
}

// This PC's IPv4 addresses (ip's): the Wi-Fi's and wired ones, Tailscale's; not containers'.
async function interfaces() {
  try {
    const out = await new Deno.Command("ip", { args: ["-j", "-4", "addr", "show", "up"], stdin: "null", stdout: "piped", stderr: "null" }).output();
    return JSON.parse(new TextDecoder().decode(out.stdout))
      .filter((i) => !/^(lo|docker\d*|br-|veth|virbr|podman|cni|flannel)/.test(i.ifname))
      .flatMap((i) => (i.addr_info ?? []).filter((a) => a.family === "inet").map((a) => ({ address: a.local, prefix: a.prefixlen, ifname: i.ifname })));
  } catch {
    return [];
  }
}

async function addressesHere() {
  const all = await interfaces();
  // Wi-Fi and wired first, Tailscale's last.
  return all.sort((a, b) => isTailscale(a.address) - isTailscale(b.address)).map((a) => a.address);
}

const ipNumber = (ip) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const sameNet = (a, b, prefix) => prefix > 0 && Math.floor(ipNumber(a) / 2 ** (32 - prefix)) === Math.floor(ipNumber(b) / 2 ** (32 - prefix));
const isTailscale = (ip) => sameNet(ip, "100.64.0.0", 10);

// The phone's address to reach it at: one on a network this PC is on (its
// Wi-Fi) first, then its Tailscale one, then where its last check-in came from;
// the first of those whose SFTP port answers.
async function reachableHost(phone) {
  const here = await interfaces();
  const candidates = [...new Set([...(phone.addresses ?? []), phone.remote].filter(Boolean))];
  const rank = (ip) => here.some((h) => !isTailscale(h.address) && sameNet(ip, h.address, h.prefix)) ? 0 : isTailscale(ip) ? 1 : ip === phone.remote ? 2 : 3;
  candidates.sort((a, b) => rank(a) - rank(b));
  const answers = candidates.map((host) => answersAt(host, phone.sftp.port));
  for (let i = 0; i < candidates.length; i++) if (await answers[i]) return candidates[i];
  return null;
}

// Whether something takes a TCP connection at host:port within `ms`.
function answersAt(host, port, ms = 2000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    Deno.connect({ hostname: host, port }).then((conn) => {
      clearTimeout(timer);
      conn.close();
      resolve(true);
    }, () => (clearTimeout(timer), resolve(false)));
  });
}

// An SSH public key as known_hosts has it, and its fingerprint as ssh shows it (SHA256:..., base64 unpadded).
const KEY_LINE = /^(ecdsa-sha2-nistp(256|384|521)|ssh-ed25519|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;
async function keyFingerprint(line) {
  const blob = Uint8Array.from(atob(line.split(" ")[1]), (c) => c.charCodeAt(0));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
  return "SHA256:" + btoa(String.fromCharCode(...hash)).replace(/=+$/, "");
}

// ssh's known_hosts (~/.ssh/known_hosts): `key` for [host]:port, and nothing else
// for it (what was there for it before, another phone's at that address or this
// one's before it paired again, removed by ssh-keygen -R).
async function knowHostKey(host, port, key) {
  const dir = join(Deno.env.get("HOME") ?? "/", ".ssh"), file = join(dir, "known_hosts");
  const entry = `[${host}]:${port} ${key}`;
  const lines = (await Deno.readTextFile(file).catch(() => "")).split("\n");
  const found = await new Deno.Command("ssh-keygen", { args: ["-F", `[${host}]:${port}`], stdin: "null", stdout: "piped", stderr: "null" }).output().catch(() => null);
  const theirs = new TextDecoder().decode(found?.stdout ?? new Uint8Array()).split("\n").filter((l) => l && !l.startsWith("#"));
  if (lines.includes(entry) && theirs.length === 1) return;
  if (theirs.length) await new Deno.Command("ssh-keygen", { args: ["-R", `[${host}]:${port}`], stdin: "null", stdout: "null", stderr: "null" }).output().catch(() => {});
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const now = await Deno.readTextFile(file).catch(() => "");
  await Deno.writeTextFile(file, (now && !now.endsWith("\n") ? "\n" : "") + entry + "\n", { append: true, mode: 0o600 });
}

// ufw on, with nothing letting the link's port in: the commands that would, from
// this PC's own networks (its Wi-Fi's, wired ones') and Tailscale's, not from anywhere.
async function firewallBlocks() {
  try {
    if (!/^ENABLED=yes/m.test(await Deno.readTextFile("/etc/ufw/ufw.conf"))) return null;
    const rules = await Deno.readTextFile("/etc/ufw/user.rules").catch(() => "");
    if (new RegExp(`--dport ${LINK_PORT}\\b[^\\n]*-j ACCEPT`).test(rules)) return null;
    const nets = (await interfaces()).filter((i) => !isTailscale(i.address) && i.ifname !== "tailscale0")
      .map((i) => `${networkOf(i.address, i.prefix)}/${i.prefix}`);
    const commands = [...new Set(nets)].map((net) => `sudo ufw allow from ${net} to any port ${LINK_PORT} proto tcp`);
    commands.push(`sudo ufw allow in on tailscale0 to any port ${LINK_PORT} proto tcp`);
    return commands.join("\n");
  } catch {
    return null;
  }
}

// The network an address is on (its prefix's bits), as an address.
function networkOf(ip, prefix) {
  const n = ipNumber(ip), size = 2 ** (32 - prefix), net = n - (n % size);
  return [24, 16, 8, 0].map((shift) => Math.floor(net / 2 ** shift) % 256).join(".");
}


// The cameras phil knows: found on the local network (onvif.js), or added by
// address; named, logged into and forgotten by the user. Shared by phil's
// server (its sidebar lists them) and camview's (it shows one), which run in
// the same worker, so this module's state is one for both.
//
// Kept in ~/.config/phil/cameras.json (readable only by you: logins are in it):
// {"cameras": [{id, host, port, url, manufacturer, model, name, user,
// password, added, hidden, seen, invert, absent}]}. `invert`: mounted upside
// down, its pan and tilt turned around (camview's toggle). `absent`: not found
// the last time it was looked for (off, gone): not listed until it's found
// again, with its name, login and the rest.
//
// A camera with nothing local (a Tuya one: its maker's cloud only) is
// {type: "rtsp", streams: [{token, name, url}], tuya: {deviceId, region,
// clientId, clientSecret}}: its video from go2rtc (which gets it through the
// cloud), its pan and tilt as Tuya cloud commands (tuya.js). Added by hand; the
// network scan leaves it alone. `hidden`: forgotten, so finding it again
// doesn't bring it back; `added`: by address, kept even when not found.
import { dirname, join } from "@std/path";
import * as onvif from "./onvif.js";
import * as tuya from "./tuya.js";

const RESCAN_MS = 10 * 60 * 1000; // looked for again at most this often, unless asked
const DETAILS_MS = 5 * 60 * 1000; // a camera's services and profiles: asked again after this

const file = () => join(Deno.env.get("XDG_CONFIG_HOME") ?? join(Deno.env.get("HOME") ?? "/", ".config"), "phil", "cameras.json");
let memory = null; // incognito, or when the file can't be written: the session's
let incognito = false;
let scanning = null, scannedAt = 0;
const listeners = new Set();
const details = new Map(); // id -> {at, value: Promise}

async function load() {
  if (memory) return structuredClone(memory);
  try {
    const { cameras } = JSON.parse(await Deno.readTextFile(file()));
    return Array.isArray(cameras) ? cameras : [];
  } catch {
    return [];
  }
}

async function save(cameras) {
  if (incognito) memory = cameras;
  else try {
    await Deno.mkdir(dirname(file()), { recursive: true });
    const tmp = `${file()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify({ cameras }, null, 2) + "\n", { mode: 0o600 });
    await Deno.rename(tmp, file());
    memory = null;
  } catch {
    memory = cameras;
  }
  for (const fn of listeners) fn();
}

const idOf = (host, port) => `${host}:${port}`;
const shown = (c) => ({
  id: c.id, host: c.host, port: c.port, name: c.name || c.model || c.host, model: [c.manufacturer, c.model].filter(Boolean).join(" "),
  login: !!c.user, needsLogin: !!c.auth && !c.user, seen: c.seen ?? 0, invert: !!c.invert,
});

/** The cameras for the sidebar (no logins), by name. */
export async function list() {
  return (await load()).filter((c) => !c.hidden && !c.absent).map(shown).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** A camera's record, with its login; throws if there's none. */
export async function get(id) {
  const c = (await load()).find((c) => c.id === id && !c.hidden);
  if (!c) throw Object.assign(new Error("No such camera"), { status: 404 });
  return c;
}

/** `fn` runs whenever the list changes. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Looks for cameras (onvif.discover) and adds the new ones; at most every 10
 * minutes unless `force`. Resolves to the list.
 */
export function discover({ force = false } = {}) {
  if (scanning) return scanning;
  if (!force && Date.now() - scannedAt < RESCAN_MS) return list();
  scanning = (async () => {
    try {
      const known = await load();
      const extra = known.filter((c) => c.added && !c.hidden).map((c) => `${c.host}:${c.port}`);
      console.error(`phil: TEMPORARY looking for cameras (${new Date().toTimeString().slice(0, 8)})`);
      const found = await onvif.discover({ extra });
      console.error(`phil: TEMPORARY cameras looked for (${new Date().toTimeString().slice(0, 8)})`);
      let changed = false;
      const foundIds = new Set(found.map((f) => idOf(f.host, f.port)));
      // Not found in the sweep: asked twice more, given longer (a camera on Wi-Fi
      // can be slow to answer), then left out of the list until it's back.
      for (const c of known.filter((c) => !c.hidden && c.type !== "rtsp" && !foundIds.has(c.id))) {
        let again = null;
        for (let i = 0; i < 2 && !again; i++) again = await onvif.probe(c.host, [c.port], loginOf(c), { wait: 2500 }).catch(() => null);
        if (again) found.push(again), foundIds.add(c.id);
        else if (!c.absent) (c.absent = true), (changed = true);
      }
      for (const f of found) {
        const id = idOf(f.host, f.port);
        const c = known.find((c) => c.id === id);
        if (!c) {
          known.push({ id, host: f.host, port: f.port, url: f.url, manufacturer: f.manufacturer, model: f.model, name: f.name ?? "", auth: f.auth, seen: Date.now() });
          changed = true;
        } else if (!c.hidden) {
          Object.assign(c, { url: f.url, seen: Date.now(), auth: f.auth && !c.user, absent: false, ...(f.model ? { manufacturer: f.manufacturer, model: f.model } : {}) });
          if (!c.name && f.name) c.name = f.name;
          changed = true;
        }
      }
      if (changed) await save(known);
      return list();
    } finally {
      scannedAt = Date.now();
      scanning = null;
    }
  })();
  return scanning;
}

/** A camera at an address ("host" or "host:port"), added if it speaks ONVIF. */
export async function add(address, login = {}) {
  const a = onvif.parseAddress(address);
  if (!a) throw Object.assign(new Error("An address, like 192.168.1.20 or camera.local:8899"), { status: 400 });
  const f = await onvif.probe(a.host, a.ports, login);
  if (!f) throw Object.assign(new Error(`No ONVIF camera answers at ${address}`), { status: 404 });
  const known = await load();
  const id = idOf(f.host, f.port);
  const c = known.find((c) => c.id === id);
  const fields = { url: f.url, manufacturer: f.manufacturer, model: f.model, auth: f.auth && !login.user, added: true, hidden: false, absent: false, seen: Date.now(), ...(login.user ? login : {}) };
  if (c) Object.assign(c, fields);
  else known.push({ id, host: f.host, port: f.port, name: f.name ?? "", ...fields });
  await save(known);
  return shown(known.find((c) => c.id === id));
}

/** Changes a camera: {name}, {user, password} (checked first: rejected if the camera says no), {hidden}, {invert}. */
export async function update(id, changes) {
  const known = await load();
  const c = known.find((c) => c.id === id);
  if (!c) throw Object.assign(new Error("No such camera"), { status: 404 });
  if ("user" in changes) {
    const login = { user: String(changes.user ?? ""), password: String(changes.password ?? "") };
    try {
      const info = await onvif.deviceInfo(c.url, login);
      await onvif.services(c.url, login); // device information is often open to all: this one usually isn't
      Object.assign(c, { manufacturer: info.manufacturer || c.manufacturer, model: info.model || c.model });
    } catch (err) {
      throw Object.assign(new Error(err.auth ? "The camera didn't take that user name and password" : err.message), { status: 403 });
    }
    Object.assign(c, login, { auth: false });
  }
  if ("name" in changes) c.name = String(changes.name ?? "").trim().slice(0, 80);
  if ("hidden" in changes) c.hidden = !!changes.hidden;
  if ("invert" in changes) c.invert = !!changes.invert;
  details.delete(id);
  await save(known);
  return shown(c);
}

const loginOf = (c) => (c.user ? { user: c.user, password: c.password ?? "" } : {});

/**
 * What camview needs of a camera: {camera, services, profiles, ptz} (ptz:
 * {zoom, presets, home} or null). Asked of the camera, kept for 5 minutes.
 */
export async function info(id) {
  const cached = details.get(id);
  if (cached && Date.now() - cached.at < DETAILS_MS) return cached.value;
  const value = (async () => {
    const c = await get(id);
    if (c.type === "rtsp") { // its streams as given; PTZ if it's a Tuya camera
      const profiles = (c.streams ?? []).map((s) => ({ token: s.token, name: s.name, width: s.width ?? 0, height: s.height ?? 0, encoding: "", ptz: !!c.tuya }));
      if (!profiles.length) throw new Error("The camera has no streams set");
      return { camera: shown(c), services: {}, profiles, ptz: c.tuya ? { zoom: false, presets: 0, home: false } : null };
    }
    const login = loginOf(c);
    const svc = await onvif.services(c.url, login);
    if (!svc.media) throw new Error("The camera has no video service");
    const profiles = await onvif.profiles(svc.media, login);
    if (!profiles.length) throw new Error("The camera has no video profiles");
    const ptz = svc.ptz && profiles.some((p) => p.ptz) ? await onvif.ptzAbilities(svc.ptz, login).catch(() => ({ zoom: false, presets: 0, home: false })) : null;
    return { camera: shown(c), services: svc, profiles, ptz };
  })();
  details.set(id, { at: Date.now(), value });
  value.catch(() => details.delete(id));
  return value;
}

/** The RTSP URL of a camera's profile (`token`; default its best), with its login in it. */
export async function rtspUrl(id, token = null) {
  const c = await get(id);
  if (c.type === "rtsp") return ((c.streams ?? []).find((s) => s.token === token) ?? c.streams[0]).url;
  const { services, profiles } = await info(id);
  const profile = profiles.find((p) => p.token === token) ?? profiles[0];
  const uri = new URL(await onvif.streamUri(services.media, profile.token, loginOf(c)));
  if (c.user && !uri.username) {
    uri.username = encodeURIComponent(c.user);
    uri.password = encodeURIComponent(c.password ?? "");
  }
  return uri.href;
}

/** The PTZ service and profile token for a camera, and its login: for onvif.move() and the rest. */
export async function ptzOf(id) {
  const c = await get(id);
  if (c.type === "rtsp") {
    if (!c.tuya) throw Object.assign(new Error("This camera can't pan, tilt or zoom"), { status: 400 });
    return { tuya: c.tuya, invert: !!c.invert };
  }
  const { services, profiles, ptz } = await info(id);
  if (!ptz) throw Object.assign(new Error("This camera can't pan, tilt or zoom"), { status: 400 });
  return { url: services.ptz, token: (profiles.find((p) => p.ptz) ?? profiles[0]).token, login: loginOf(c), invert: !!c.invert };
}

/** Incognito: nothing is written; changes last the session. */
export async function keepInMemory() {
  memory = await load();
  incognito = true;
}

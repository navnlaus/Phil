// ONVIF, the standard network cameras speak (SOAP over HTTP): what a camera is,
// its streams, and its pan, tilt and zoom (PTZ). Only what camview needs.
// Cameras that want a login get it as a WS-Security UsernameToken (a digest of
// the password, never the password itself).

const TIMEOUT_MS = 4000;
const NS = {
  tds: "http://www.onvif.org/ver10/device/wsdl",
  trt: "http://www.onvif.org/ver10/media/wsdl",
  tptz: "http://www.onvif.org/ver20/ptz/wsdl",
  tt: "http://www.onvif.org/ver10/schema",
};
const WSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";

/** A SOAP call failed: `auth` when the camera wants a (different) login. */
export class OnvifError extends Error {
  constructor(message, { auth = false } = {}) {
    super(message);
    this.auth = auth;
  }
}

// ---------------------------------------------------------------- XML, the little that's needed

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, "&");

/** Every element named `name` (any namespace prefix): [{attrs, body}]. */
export function elements(xml, name) {
  const out = [];
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}((?:\\s[^>]*?)?)(/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>)`, "g");
  for (const m of xml.matchAll(re)) out.push({ attrs: m[1] ?? "", body: m[3] ?? "" });
  return out;
}
/** The text of the first element named `name`, or null. */
export const textOf = (xml, name) => {
  const e = elements(xml, name)[0];
  return e ? unesc(e.body.replace(/<[^>]+>/g, "").trim()) : null;
};
/** An attribute's value from an element's `attrs`, or null. */
export const attrOf = (attrs, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? unesc(m[1]) : null;
};

// ---------------------------------------------------------------- SOAP

async function security(user, password) {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const created = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const bytes = new Uint8Array([...nonce, ...new TextEncoder().encode(created + password)]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  const b64 = (a) => btoa(String.fromCharCode(...a));
  return `<s:Header><wsse:Security s:mustUnderstand="1" xmlns:wsse="${WSSE}" xmlns:wsu="${WSU}"><wsse:UsernameToken>` +
    `<wsse:Username>${esc(user)}</wsse:Username>` +
    `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${b64(digest)}</wsse:Password>` +
    `<wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${b64(nonce)}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
}

// What a request is answered with: its body's first element, "...Response"
// (cameras with slipshod servers answer some requests with an earlier answer).
const opOf = (body) => /^\s*<(?:([\w-]+):)?(\w+)/.exec(body);
// Requests some cameras answer with nothing at all, having done it.
const NO_ANSWER_NEEDED = new Set(["ContinuousMove", "Stop", "GotoPreset", "RemovePreset", "RelativeMove", "AbsoluteMove"]);

/**
 * Calls `body` (a request element, using the prefixes in NS) at `url`; resolves
 * to the answer's XML. Copes with cameras that get HTTP wrong: an answer is
 * read up to its end (some send a wrong Content-Length and close the
 * connection early), and some move or stop with an empty answer. An answer to
 * something else (the previous request's, from a camera that doesn't do this
 * one) throws an OnvifError with `unsupported`.
 */
export async function soap(url, body, { user = "", password = "", timeout = TIMEOUT_MS } = {}) {
  const xmlns = Object.entries(NS).map(([p, uri]) => ` xmlns:${p}="${uri}"`).join("");
  const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"${xmlns}>` +
    (user ? await security(user, password) : "") + `<s:Body>${body}</s:Body></s:Envelope>`;
  const [, prefix, op] = opOf(body) ?? [];
  const action = NS[prefix] && op ? `; action="${NS[prefix]}/${op}"` : "";
  let res, xml;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": `application/soap+xml; charset=utf-8${action}` }, body: envelope, signal: AbortSignal.timeout(timeout) });
    xml = await readEnvelope(res);
  } catch (err) {
    throw new OnvifError(err.name === "TimeoutError" ? "the camera didn't answer" : `can't reach the camera (${err.message})`);
  }
  if (/<(?:[\w-]+:)?Fault\b/.test(xml) || !res.ok) {
    const reason = textOf(xml, "Text") ?? textOf(xml, "Reason") ?? `HTTP ${res.status}`;
    const auth = res.status === 401 || /NotAuthorized|not ?authori[sz]ed|Sender not Authorized|password|authenticat/i.test(xml);
    throw new OnvifError(auth ? "the camera wants a login (user name and password)" : reason, { auth });
  }
  if (!xml.trim() && NO_ANSWER_NEEDED.has(op)) return "";
  if (!/Envelope/.test(xml)) throw new OnvifError("not an ONVIF answer");
  const answer = /<(?:[\w-]+:)?Body[^>]*>\s*<(?:[\w-]+:)?(\w+)/.exec(xml)?.[1];
  if (op && answer && answer !== `${op}Response` && !NO_ANSWER_NEEDED.has(op)) throw Object.assign(new OnvifError(`the camera doesn't do ${op}`), { unsupported: true });
  return xml;
}

// The answer's text, up to the end of its envelope: not waiting for more when a
// camera's Content-Length is wrong, and keeping what came when it then closes.
async function readEnvelope(res) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (/<\/(?:[\w-]+:)?Envelope\s*>/.test(text)) {
        reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (err) {
    if (!text) throw err;
  }
  return text;
}

// ---------------------------------------------------------------- what a camera is

/** {manufacturer, model, firmware, serial} of the device service at `url`. */
export async function deviceInfo(url, login) {
  const xml = await soap(url, "<tds:GetDeviceInformation/>", login);
  return {
    manufacturer: textOf(xml, "Manufacturer") ?? "",
    model: textOf(xml, "Model") ?? "",
    firmware: textOf(xml, "FirmwareVersion") ?? "",
    serial: textOf(xml, "SerialNumber") ?? "",
  };
}

/** The name the camera gives itself (its onvif://www.onvif.org/name/ scope), or null. */
export async function scopeName(url, login) {
  try {
    const xml = await soap(url, "<tds:GetScopes/>", login);
    const m = /onvif:\/\/www\.onvif\.org\/name\/([^<\s]+)/.exec(xml);
    return m ? decodeURIComponent(m[1]).replace(/_/g, " ") : null;
  } catch {
    return null;
  }
}

/** Its media and PTZ services' URLs: {media, ptz} (ptz null without one). */
export async function services(url, login) {
  const xml = await soap(url, "<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>", login);
  const addr = (section) => {
    const e = elements(xml, section)[0];
    return e ? textOf(e.body, "XAddr") : null;
  };
  return { media: addr("Media"), ptz: addr("PTZ") };
}

/**
 * Its stream profiles, best first: [{token, name, width, height, encoding, ptz}]
 * (`ptz`: the profile has a PTZ configuration).
 */
export async function profiles(mediaUrl, login) {
  const xml = await soap(mediaUrl, "<trt:GetProfiles/>", login);
  return elements(xml, "Profiles").map(({ attrs, body }) => {
    const encoder = elements(body, "VideoEncoderConfiguration")[0]?.body ?? "";
    return {
      token: attrOf(attrs, "token"),
      name: textOf(body, "Name") ?? attrOf(attrs, "token"),
      width: Number(textOf(encoder, "Width") ?? 0),
      height: Number(textOf(encoder, "Height") ?? 0),
      encoding: textOf(encoder, "Encoding") ?? "",
      ptz: elements(body, "PTZConfiguration").length > 0,
    };
  }).filter((p) => p.token).sort((a, b) => b.width * b.height - a.width * a.height);
}

/** The RTSP URL of a profile's stream. */
export async function streamUri(mediaUrl, token, login) {
  const xml = await soap(mediaUrl,
    `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${esc(token)}</trt:ProfileToken></trt:GetStreamUri>`,
    login);
  const uri = textOf(xml, "Uri");
  if (!uri) throw new OnvifError("the camera gave no stream address");
  return uri;
}

// ---------------------------------------------------------------- pan, tilt, zoom

/** What its PTZ can do: {zoom, presets (how many it keeps), home}. */
export async function ptzAbilities(ptzUrl, login) {
  const xml = await soap(ptzUrl, "<tptz:GetNodes/>", login);
  return {
    zoom: /ContinuousZoomVelocitySpace/.test(xml),
    presets: Number(textOf(xml, "MaximumNumberOfPresets") ?? 0),
    home: textOf(xml, "HomeSupported") === "true",
  };
}

/** Moves at a speed (each -1 to 1) until stop(): pan `x` (right +), tilt `y` (up +), `zoom` (in +). */
export async function move(ptzUrl, token, { x = 0, y = 0, zoom = 0 }, login) {
  const n = (v) => Math.max(-1, Math.min(1, Number(v) || 0)).toFixed(3);
  await soap(ptzUrl,
    `<tptz:ContinuousMove><tptz:ProfileToken>${esc(token)}</tptz:ProfileToken><tptz:Velocity>` +
    `<tt:PanTilt x="${n(x)}" y="${n(y)}"/><tt:Zoom x="${n(zoom)}"/></tptz:Velocity></tptz:ContinuousMove>`,
    login);
}

export async function stop(ptzUrl, token, login) {
  await soap(ptzUrl, `<tptz:Stop><tptz:ProfileToken>${esc(token)}</tptz:ProfileToken><tptz:PanTilt>true</tptz:PanTilt><tptz:Zoom>true</tptz:Zoom></tptz:Stop>`, login);
}

/** Its saved positions: [{token, name}]. */
export async function presets(ptzUrl, token, login) {
  const xml = await soap(ptzUrl, `<tptz:GetPresets><tptz:ProfileToken>${esc(token)}</tptz:ProfileToken></tptz:GetPresets>`, login);
  return elements(xml, "Preset").map(({ attrs, body }) => ({ token: attrOf(attrs, "token"), name: textOf(body, "Name") ?? attrOf(attrs, "token") }))
    .filter((p) => p.token);
}

export async function gotoPreset(ptzUrl, token, preset, login) {
  await soap(ptzUrl, `<tptz:GotoPreset><tptz:ProfileToken>${esc(token)}</tptz:ProfileToken><tptz:PresetToken>${esc(preset)}</tptz:PresetToken></tptz:GotoPreset>`, login);
}

/** Saves where it points now as a preset called `name`; resolves to its token. */
export async function savePreset(ptzUrl, token, name, login) {
  const xml = await soap(ptzUrl, `<tptz:SetPreset><tptz:ProfileToken>${esc(token)}</tptz:ProfileToken><tptz:PresetName>${esc(name)}</tptz:PresetName></tptz:SetPreset>`, login);
  return textOf(xml, "PresetToken");
}

export async function removePreset(ptzUrl, token, preset, login) {
  await soap(ptzUrl, `<tptz:RemovePreset><tptz:ProfileToken>${esc(token)}</tptz:ProfileToken><tptz:PresetToken>${esc(preset)}</tptz:PresetToken></tptz:RemovePreset>`, login);
}

// ---------------------------------------------------------------- finding cameras

// Where ONVIF usually is, most likely first (8899: cheap Chinese cameras; 2020: TP-Link's; 80: most).
const ONVIF_PORTS = [8899, 80, 2020, 8000, 8080, 5000, 6688, 8999];

/**
 * The cameras on the local networks: every address in this computer's own
 * /24s (not loopback, containers or VPNs) with RTSP (554) open, then asked for
 * ONVIF on the usual ports. (WS-Discovery, ONVIF's own way, needs a UDP
 * socket, and firewalls drop the answers.) `extra`: "host[:port]" to ask too.
 * Resolves to [{host, port, url, ...deviceInfo, name, auth}].
 */
export async function discover({ extra = [] } = {}) {
  const hosts = new Set();
  for (const net of await localNetworks()) for (let i = 1; i < 255; i++) if (`${net}.${i}` !== net.self) hosts.add(`${net}.${i}`);
  const rtsp = (await mapLimit([...hosts], 96, async (h) => (await tcpOpen(h, 554, 500)) ? h : null)).filter(Boolean);
  const candidates = [...rtsp.map((host) => ({ host, ports: ONVIF_PORTS })), ...extra.map(parseAddress).filter(Boolean)];
  const found = await mapLimit(candidates, 16, ({ host, ports }) => probe(host, ports));
  return found.filter(Boolean);
}

/** "host", "host:port" → {host, ports}. */
export function parseAddress(address) {
  const m = /^\s*([\w.-]+|\[[\w:]+\])(?::(\d{1,5}))?\s*$/.exec(String(address ?? ""));
  return m ? { host: m[1], ports: m[2] ? [Number(m[2])] : ONVIF_PORTS } : null;
}

/** The ONVIF camera at `host` (the first of `ports` that answers), or null. */
export async function probe(host, ports = ONVIF_PORTS, login = {}) {
  for (const port of ports) {
    if (!(await tcpOpen(host, port, 600))) continue;
    const url = `http://${host}${port === 80 ? "" : `:${port}`}/onvif/device_service`;
    try {
      const info = await deviceInfo(url, login);
      const name = await scopeName(url, login); // not when it's only the maker's name ("NVT")
      // What it is is often told to anyone; its services, only with a login.
      const auth = await services(url, login).then(() => false, (err) => err instanceof OnvifError && err.auth);
      return { host, port, url, ...info, name: name && name !== info.manufacturer ? name : null, auth };
    } catch (err) {
      if (err instanceof OnvifError && err.auth) return { host, port, url, manufacturer: "", model: "", name: null, auth: true };
    }
  }
  return null;
}

// This computer's IPv4 networks, as their first three numbers ("192.168.1"),
// each with `self` (its own address there). Containers, bridges and VPNs aren't.
async function localNetworks() {
  const out = await new Deno.Command("ip", { args: ["-4", "-o", "addr", "show", "scope", "global"], stdout: "piped", stderr: "null" }).output().catch(() => null);
  if (!out?.success) return [];
  const nets = [];
  for (const line of new TextDecoder().decode(out.stdout).split("\n")) {
    const m = /^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+)\.(\d+)\/(\d+)/.exec(line);
    if (!m || /^(docker|br-|veth|virbr|lxc|tailscale|wg|tun|tap|zt)/.test(m[1]) || Number(m[4]) < 16) continue;
    const net = Object.assign(new String(m[2]), { self: `${m[2]}.${m[3]}` });
    if (!nets.some((n) => String(n) === m[2])) nets.push(net);
  }
  return nets;
}

async function tcpOpen(hostname, port, ms) {
  let timer;
  const connect = Deno.connect({ hostname, port });
  const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  try {
    const conn = await Promise.race([connect, timeout]);
    if (!conn) {
      connect.then((c) => c.close(), () => {}); // too slow: closed whenever it does connect
      return false;
    }
    conn.close();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]).catch(() => null);
    }
  }));
  return results;
}

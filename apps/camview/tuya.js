// Tuya's cloud API (openapi.tuya*.com), the little camview needs: sending a
// Tuya camera commands (its pan and tilt), for cameras that have nothing local
// (their video comes through go2rtc, which also speaks to Tuya's cloud). With a
// cloud project's client ID and secret (platform.tuya.com), each request signed
// as Tuya's API wants (HMAC-SHA256 of the request and a token).

const HOSTS = { eu: "openapi.tuyaeu.com", "eu-w": "openapi-weaz.tuyaeu.com", us: "openapi.tuyaus.com", "us-e": "openapi-ueaz.tuyaus.com", cn: "openapi.tuyacn.com", in: "openapi.tuyain.com" };
const tokens = new Map(); // client id -> {token, expires}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))).toUpperCase();
}

/**
 * Calls Tuya's API: `account` is {region, clientId, clientSecret}; resolves to
 * the answer's `result`, or throws with Tuya's message.
 */
export async function request(account, method, path, body = null, { token = true } = {}) {
  const host = HOSTS[account.region] ?? HOSTS.eu;
  const t = String(Date.now()), nonce = "";
  const content = body ? JSON.stringify(body) : "";
  const stringToSign = [method, await sha256(content), "", path].join("\n");
  const access = token ? await accessToken(account) : "";
  const sign = await hmac(account.clientSecret, account.clientId + access + t + nonce + stringToSign);
  const res = await fetch(`https://${host}${path}`, {
    method,
    headers: { client_id: account.clientId, sign, t, sign_method: "HMAC-SHA256", nonce, ...(access ? { access_token: access } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: content || undefined,
    signal: AbortSignal.timeout(8000),
  });
  const answer = await res.json().catch(() => ({}));
  if (!answer.success) {
    if (answer.code === 1010 || answer.code === 1011) tokens.delete(account.clientId); // token expired or invalid: a new one next time
    throw new Error(`Tuya: ${answer.msg ?? res.statusText} (${answer.code ?? res.status})`);
  }
  return answer.result;
}

async function accessToken(account) {
  const cached = tokens.get(account.clientId);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const result = await request(account, "GET", "/v1.0/token?grant_type=1", null, { token: false });
  tokens.set(account.clientId, { token: result.access_token, expires: Date.now() + result.expire_time * 1000 });
  return result.access_token;
}

/** Sends a device commands: {code: value, ...} (its data points, by code). */
export async function command(account, deviceId, codes) {
  await request(account, "POST", `/v1.0/devices/${encodeURIComponent(deviceId)}/commands`, {
    commands: Object.entries(codes).map(([code, value]) => ({ code, value })),
  });
}

// Tuya cameras' ptz_control: a direction, up first, clockwise.
const DIRECTIONS = { "0,1": "0", "1,1": "1", "1,0": "2", "1,-1": "3", "0,-1": "4", "-1,-1": "5", "-1,0": "6", "-1,1": "7" };

/** Starts moving towards x (right +), y (up +): each just its sign counts (Tuya cameras have one speed). */
export async function move(account, deviceId, { x = 0, y = 0 }) {
  const dir = DIRECTIONS[`${Math.sign(x)},${Math.sign(y)}`];
  if (dir === undefined) return stop(account, deviceId);
  await command(account, deviceId, { ptz_control: dir });
}

export async function stop(account, deviceId) {
  await command(account, deviceId, { ptz_stop: true });
}

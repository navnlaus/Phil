// The engine's servers speak HTTPS to its own windows, for HTTP/2: over plain
// HTTP a page gets six connections to its server at most, one request each, so
// a few slow requests (a camera search, a hung network share, videos playing)
// left a click waiting its turn. HTTP/2 carries them all at once over one
// connection, and WebKit (like every engine) only speaks it over TLS. The
// certificate is made afresh each run (a few ms), for 127.0.0.1 only, kept in
// memory, and trusted by this engine's windows alone (window.js).

/** {cert, key} as PEM, or null when it can't be made (openssl missing): then plain HTTP. */
export async function localCertificate() {
  try {
    const { success, stdout } = await new Deno.Command("openssl", {
      args: [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "-", "-out", "-",
        "-days", "3650", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      ],
      stdin: "null", stdout: "piped", stderr: "null",
    }).output();
    if (!success) return null;
    const out = new TextDecoder().decode(stdout);
    const key = out.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n?/)?.[0];
    const cert = out.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/)?.[0];
    return key && cert ? { cert, key } : null;
  } catch {
    return null;
  }
}

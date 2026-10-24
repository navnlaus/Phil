package io.github.navnlaus.phil;

import android.net.http.SslCertificate;
import android.os.Bundle;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONException;
import org.json.JSONObject;

// HTTPS to the PC's link server (apps/phil/link.js). Its certificate is its own
// (self-signed), so it's trusted by its fingerprint, the one seen when pairing
// (and checked by eye then: the PC shows it too), never by a CA.
final class Net {
    private Net() {}

    // The SHA-256 of a certificate, hex.
    static String fingerprint(byte[] der) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(der);
            StringBuilder s = new StringBuilder();
            for (byte b : d) s.append(String.format("%02x", b));
            return s.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // A WebView's certificate (onReceivedSslError), its fingerprint; null if it has none.
    static String fingerprint(SslCertificate cert) {
        Bundle b = SslCertificate.saveState(cert);
        byte[] der = b == null ? null : b.getByteArray("x509-certificate");
        return der == null ? null : fingerprint(der);
    }

    // How a fingerprint is shown to compare (the PC shows the same): its first 8 bytes, in pairs.
    static String shortFingerprint(String hex) {
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < 16 && i < hex.length(); i += 4) s.append(i == 0 ? "" : " ").append(hex, i, Math.min(i + 4, hex.length()));
        return s.toString().toUpperCase();
    }

    // Trusts the certificate whose fingerprint is `pinned`; with null, any, and puts its fingerprint in seen[0].
    static HttpsURLConnection open(String host, int port, String path, String pinned, String[] seen, int timeoutMs) throws IOException {
        URL url = new URL("https://" + (host.contains(":") ? "[" + host + "]" : host) + ":" + port + path);
        HttpsURLConnection c = (HttpsURLConnection) url.openConnection();
        try {
            SSLContext ssl = SSLContext.getInstance("TLS");
            ssl.init(null, new TrustManager[] {new X509TrustManager() {
                @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    throw new CertificateException("no clients");
                }
                @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                    if (chain == null || chain.length == 0) throw new CertificateException("no certificate");
                    String fp = fingerprint(chain[0].getEncoded());
                    if (seen != null) seen[0] = fp;
                    if (pinned != null && !pinned.equals(fp)) throw new CertificateException("not the PC paired with (its certificate changed)");
                }
                @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            }}, null);
            c.setSSLSocketFactory(ssl.getSocketFactory());
        } catch (Exception e) {
            throw new IOException(e);
        }
        c.setHostnameVerifier((name, session) -> true); // (the fingerprint is what's checked)
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(Math.max(timeoutMs, 15000));
        return c;
    }

    // A request to the paired PC, at the first of its addresses that answers;
    // its JSON answer. Throws with the PC's message when it says no.
    static JSONObject call(Store store, String method, String path, JSONObject body) throws IOException {
        IOException last = null;
        for (String host : store.hosts()) {
            HttpsURLConnection c;
            try {
                c = open(host, store.pcPort(), path, store.fingerprint(), null, 3000);
                c.setRequestMethod(method);
                c.setRequestProperty("authorization", "Bearer " + store.token());
                if (body != null) send(c, body);
                int status = c.getResponseCode();
                store.answered(host);
                return answer(c, status);
            } catch (Answer e) {
                throw e;
            } catch (IOException e) {
                last = e;
            }
        }
        throw last != null ? last : new IOException("No address for " + store.pcName());
    }

    // The first of the PC's addresses that answers (a quick TLS handshake), or null.
    static String reachable(Store store) {
        for (String host : store.hosts()) {
            try {
                HttpsURLConnection c = open(host, store.pcPort(), "/link/info", store.fingerprint(), null, 2500);
                if (c.getResponseCode() == 200) {
                    store.answered(host);
                    return host;
                }
            } catch (IOException ignored) { /* the next */ }
        }
        return null;
    }

    static void send(HttpURLConnection c, JSONObject body) throws IOException {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setRequestProperty("content-type", "application/json");
        c.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = c.getOutputStream()) {
            out.write(bytes);
        }
    }

    // A refusal from the PC (its message): not a reason to try another address.
    static final class Answer extends IOException {
        final int status;
        Answer(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    static JSONObject answer(HttpURLConnection c, int status) throws IOException {
        InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
        String text = in == null ? "" : read(in);
        if (status >= 400) throw new Answer(status, text.isEmpty() ? "HTTP " + status : messageOf(text));
        try {
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } catch (JSONException e) {
            throw new IOException("Not an answer from phil");
        }
    }

    private static String messageOf(String text) {
        try {
            return new JSONObject(text).optString("error", text);
        } catch (JSONException e) {
            return text;
        }
    }

    static String read(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    // This phone's IPv4 addresses (Wi-Fi's, Tailscale's, mobile data's), for the PC to reach it at.
    static List<String> addresses() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress() && !a.isLinkLocalAddress()) out.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) { /* none */ }
        return out;
    }
}

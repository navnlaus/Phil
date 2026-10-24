package io.github.navnlaus.phil;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// A camera's video straight from it, on its network: RTSP (over TCP, the RTP
// interleaved in it), its H.264 out of the RTP packets, and written as
// fragmented MP4 (Fmp4) as it comes, for the page's Media Source. What ffmpeg
// does for camview's page on the PC, without the PC. Its login (in the URL, as
// the PC gave it) answered as the camera asks: Digest or Basic. No Android in it
// (tried on the PC too).
final class Rtsp implements Closeable {
    private static final int CONNECT_MS = 3000, READ_MS = 10_000;
    private final URI uri;
    private final String url; // (without the login)
    private final String user, password;
    private Socket socket;
    private DataInputStream in;
    private OutputStream out;
    private int cseq = 1;
    private String session, authorization, realm, nonce, opaque, qop, digestAlgorithm;
    private boolean digest;
    private int nc;
    private long keepAliveMs = 25_000;
    private boolean getParameter;
    private volatile boolean closed;

    Rtsp(String address) throws IOException {
        try {
            uri = new URI(address);
        } catch (Exception e) {
            throw new IOException("Not an RTSP address");
        }
        if (!"rtsp".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) throw new IOException("Not an RTSP address");
        String info = uri.getRawUserInfo();
        String u = null, p = null;
        if (info != null) {
            int colon = info.indexOf(':');
            u = decode(colon < 0 ? info : info.substring(0, colon));
            p = colon < 0 ? "" : decode(info.substring(colon + 1));
        }
        user = u;
        password = p;
        url = "rtsp://" + uri.getHost() + ":" + port() + (uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath())
            + (uri.getRawQuery() != null ? "?" + uri.getRawQuery() : "");
    }

    String host() {
        return uri.getHost();
    }

    int port() {
        return uri.getPort() > 0 ? uri.getPort() : 554;
    }

    private static String decode(String s) {
        try {
            return URLDecoder.decode(s.replace("+", "%2B"), "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    /** Plays it into `video` (fragmented MP4) until it ends, fails, or close(). */
    void play(OutputStream video) throws IOException {
        socket = new Socket();
        socket.connect(new InetSocketAddress(uri.getHost(), port()), CONNECT_MS);
        socket.setSoTimeout(READ_MS);
        socket.setTcpNoDelay(true);
        in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 64 * 1024));
        out = socket.getOutputStream();

        Answer options = ask("OPTIONS", url, null);
        getParameter = options.header("public") != null && options.header("public").toUpperCase(Locale.ROOT).contains("GET_PARAMETER");
        Answer describe = ask("DESCRIBE", url, Map.of("Accept", "application/sdp"));
        if (describe.status != 200) throw new IOException(describe.status == 401 ? "The camera didn't take the login" : "The camera said " + describe.status);
        String base = describe.header("content-base") != null ? describe.header("content-base") : describe.header("content-location") != null ? describe.header("content-location") : url;
        Sdp sdp = Sdp.parse(new String(describe.body, StandardCharsets.UTF_8));
        if (sdp.control == null) throw new IOException("The camera has no H.264 video");
        String track = sdp.control.matches("(?i)^rtsp://.*") ? sdp.control : sdp.control.equals("*") ? base
            : base + (base.endsWith("/") ? "" : "/") + sdp.control;
        track = withoutLogin(track);

        Answer setup = ask("SETUP", track, Map.of("Transport", "RTP/AVP/TCP;unicast;interleaved=0-1"));
        if (setup.status != 200) throw new IOException("The camera said " + setup.status + " to its video");
        String s = setup.header("session");
        if (s == null) throw new IOException("The camera gave no session");
        Matcher t = Pattern.compile(";\\s*timeout=(\\d+)").matcher(s);
        if (t.find()) keepAliveMs = Math.max(5, Integer.parseInt(t.group(1))) * 1000L / 2;
        session = s.split(";")[0].trim();
        int channel = 0;
        Matcher ch = Pattern.compile("interleaved=(\\d+)").matcher(setup.header("transport") == null ? "" : setup.header("transport"));
        if (ch.find()) channel = Integer.parseInt(ch.group(1));
        Answer playing = ask("PLAY", sdp.control.equals("*") ? track : withoutLogin(base), Map.of("Range", "npt=0.000-"));
        if (playing.status != 200) throw new IOException("The camera said " + playing.status + " to playing");

        H264 h264 = new H264(new Fmp4(video), sdp.sps, sdp.pps);
        long kept = System.currentTimeMillis();
        while (!closed) {
            if (System.currentTimeMillis() - kept > keepAliveMs) {
                kept = System.currentTimeMillis();
                send(getParameter ? "GET_PARAMETER" : "OPTIONS", url, null, false);
            }
            int first = in.readUnsignedByte();
            if (first == '$') {
                int c = in.readUnsignedByte();
                int length = in.readUnsignedShort();
                byte[] packet = new byte[length];
                in.readFully(packet);
                if (c == channel) h264.packet(packet);
            } else if (first == 'R') { // an answer (to the keep-alive) among the video
                readAnswer(first);
            } else {
                throw new IOException("The camera's stream went wrong");
            }
        }
    }

    @Override public void close() {
        closed = true;
        Socket s = socket;
        if (s == null) return;
        try {
            if (session != null) send("TEARDOWN", url, null, false);
        } catch (IOException ignored) { /* gone already */ }
        try {
            s.close();
        } catch (IOException ignored) { /* closed */ }
    }

    private static String withoutLogin(String address) {
        return address.replaceFirst("(?i)^(rtsp://)[^/@]*@", "$1");
    }

    // ---------------------------------------------------------------- requests

    private static final class Answer {
        int status;
        final Map<String, String> headers = new HashMap<>();
        byte[] body = new byte[0];

        String header(String name) {
            return headers.get(name.toLowerCase(Locale.ROOT));
        }
    }

    // A request and its answer; asked again with the login when the camera wants it.
    private Answer ask(String method, String target, Map<String, String> headers) throws IOException {
        send(method, target, headers, true);
        Answer a = readAnswer(-1);
        if (a.status == 401 && user != null && authorization == null) {
            String how = a.header("www-authenticate");
            if (how == null) return a;
            login(how);
            send(method, target, headers, true);
            a = readAnswer(-1);
        }
        return a;
    }

    private synchronized void send(String method, String target, Map<String, String> headers, boolean wait) throws IOException {
        StringBuilder r = new StringBuilder(method).append(' ').append(target).append(" RTSP/1.0\r\n");
        r.append("CSeq: ").append(cseq++).append("\r\n");
        r.append("User-Agent: phil\r\n");
        if (session != null) r.append("Session: ").append(session).append("\r\n");
        String auth = authorization(method, target);
        if (auth != null) r.append("Authorization: ").append(auth).append("\r\n");
        if (headers != null) for (Map.Entry<String, String> h : headers.entrySet()) r.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
        r.append("\r\n");
        out.write(r.toString().getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    // An answer: its status line, headers and body (`first`: its first byte, read already; else -1).
    private Answer readAnswer(int first) throws IOException {
        Answer a = new Answer();
        String status = line(first);
        // (interleaved video before the answer, a stream starting: skipped)
        while (status.isEmpty()) status = line(-1);
        Matcher m = Pattern.compile("^RTSP/\\d\\.\\d\\s+(\\d{3})").matcher(status);
        if (!m.find()) throw new IOException("Not an RTSP camera");
        a.status = Integer.parseInt(m.group(1));
        for (String l; !(l = line(-1)).isEmpty(); ) {
            int colon = l.indexOf(':');
            if (colon > 0) {
                String key = l.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String value = l.substring(colon + 1).trim();
                // (several WWW-Authenticate: Digest preferred)
                if (key.equals("www-authenticate") && a.headers.containsKey(key) && !value.regionMatches(true, 0, "digest", 0, 6)) continue;
                a.headers.put(key, value);
            }
        }
        String length = a.header("content-length");
        if (length != null) {
            a.body = new byte[Integer.parseInt(length.trim())];
            in.readFully(a.body);
        }
        return a;
    }

    private String line(int first) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c = first >= 0 ? first : in.readUnsignedByte();
        if (c == '$' && first < 0) { // interleaved data before an answer: passed over
            in.readUnsignedByte();
            in.readFully(new byte[in.readUnsignedShort()]);
            return "";
        }
        while (c != '\n') {
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("Not an RTSP camera");
            c = in.readUnsignedByte();
        }
        return b.toString("UTF-8");
    }

    // ---------------------------------------------------------------- the login

    private void login(String how) {
        if (how.regionMatches(true, 0, "digest", 0, 6)) {
            digest = true;
            realm = param(how, "realm");
            nonce = param(how, "nonce");
            opaque = param(how, "opaque");
            digestAlgorithm = param(how, "algorithm");
            String q = param(how, "qop");
            qop = q != null && q.contains("auth") ? "auth" : null;
            authorization = "digest";
        } else {
            digest = false;
            authorization = "Basic " + Base64.getEncoder().encodeToString((user + ":" + password).getBytes(StandardCharsets.UTF_8));
        }
    }

    private String authorization(String method, String target) {
        if (authorization == null) return null;
        if (!digest) return authorization;
        String ha1 = md5(user + ":" + realm + ":" + password);
        String ha2 = md5(method + ":" + target);
        StringBuilder a = new StringBuilder("Digest username=\"").append(user).append("\", realm=\"").append(realm)
            .append("\", nonce=\"").append(nonce).append("\", uri=\"").append(target).append('"');
        if (qop != null) {
            String count = String.format(Locale.ROOT, "%08x", ++nc);
            String cnonce = Long.toHexString(Double.doubleToLongBits(Math.random()));
            a.append(", qop=auth, nc=").append(count).append(", cnonce=\"").append(cnonce).append('"');
            a.append(", response=\"").append(md5(ha1 + ":" + nonce + ":" + count + ":" + cnonce + ":auth:" + ha2)).append('"');
        } else {
            a.append(", response=\"").append(md5(ha1 + ":" + nonce + ":" + ha2)).append('"');
        }
        if (opaque != null) a.append(", opaque=\"").append(opaque).append('"');
        if (digestAlgorithm != null) a.append(", algorithm=").append(digestAlgorithm);
        return a.toString();
    }

    private static String param(String header, String name) {
        Matcher m = Pattern.compile("(?i)\\b" + name + "=(?:\"([^\"]*)\"|([^,\\s]+))").matcher(header);
        return m.find() ? (m.group(1) != null ? m.group(1) : m.group(2)) : null;
    }

    private static String md5(String s) {
        try {
            byte[] d = MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder h = new StringBuilder();
            for (byte b : d) h.append(String.format("%02x", b));
            return h.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------------------------------------------------------------- what the camera has

    // Its SDP's H.264 video: where to set it up, and its SPS and PPS if it gives them there.
    static final class Sdp {
        String control;
        byte[] sps, pps;

        static Sdp parse(String text) {
            Sdp s = new Sdp();
            boolean video = false, h264 = false;
            String control = null, payload = null, sprop = null;
            for (String raw : text.split("\r?\n")) {
                String l = raw.trim();
                if (l.startsWith("m=")) {
                    if (video && h264 && s.control == null) {
                        s.control = control;
                        s.setSprop(sprop);
                    }
                    video = l.startsWith("m=video");
                    String[] parts = l.split("\\s+");
                    payload = parts.length > 3 ? parts[3] : null;
                    h264 = false;
                    control = null;
                    sprop = null;
                } else if (video && l.startsWith("a=rtpmap:" + payload + " ") && l.toUpperCase(Locale.ROOT).contains("H264/")) {
                    h264 = true;
                } else if (video && l.startsWith("a=control:")) {
                    control = l.substring(10).trim();
                } else if (video && l.startsWith("a=fmtp:" + payload + " ")) {
                    Matcher m = Pattern.compile("sprop-parameter-sets=([^;\\s]+)").matcher(l);
                    if (m.find()) sprop = m.group(1);
                }
            }
            if (video && h264 && s.control == null) {
                s.control = control == null ? "*" : control;
                s.setSprop(sprop);
            }
            return s;
        }

        private void setSprop(String sprop) {
            if (sprop == null) return;
            for (String part : sprop.split(",")) {
                try {
                    byte[] nal = Base64.getDecoder().decode(part.trim());
                    if (nal.length == 0) continue;
                    if ((nal[0] & 0x1f) == 7) sps = nal;
                    else if ((nal[0] & 0x1f) == 8) pps = nal;
                } catch (IllegalArgumentException ignored) { /* not base64 */ }
            }
        }
    }

    // ---------------------------------------------------------------- H.264 out of RTP

    // RTP packets in, frames out (Fmp4): NAL units whole (single, STAP-A) or put
    // back together (FU-A), a frame's gathered till its marker (or the next
    // timestamp), each sent when the next is whole (a frame late: its length known).
    // It starts at the first key frame; a packet lost, and the frame it was in
    // goes, and what follows till the next key frame.
    static final class H264 {
        private final Fmp4 mp4;
        private byte[] sps, pps;
        private final List<byte[]> frame = new ArrayList<>();
        private ByteArrayOutputStream fu;
        private static final long MAX_STEP = 90_000; // a second
        private long frameTs = -1, heldTs, time, lastStep = 90_000 / 15;
        private List<byte[]> held;
        private boolean heldKey;
        private int lastSeq = -1;
        private boolean broken, waitKey = true;

        H264(Fmp4 mp4, byte[] sps, byte[] pps) {
            this.mp4 = mp4;
            this.sps = sps;
            this.pps = pps;
        }

        void packet(byte[] p) throws IOException {
            if (p.length < 12 || (p[0] & 0xc0) != 0x80) return;
            int cc = p[0] & 0x0f;
            boolean marker = (p[1] & 0x80) != 0;
            int seq = ((p[2] & 0xff) << 8) | (p[3] & 0xff);
            long ts = ((p[4] & 0xffL) << 24) | ((p[5] & 0xff) << 16) | ((p[6] & 0xff) << 8) | (p[7] & 0xff);
            int at = 12 + 4 * cc;
            if ((p[0] & 0x10) != 0 && p.length >= at + 4) at += 4 + 4 * (((p[at + 2] & 0xff) << 8) | (p[at + 3] & 0xff));
            int end = p.length - ((p[0] & 0x20) != 0 ? p[p.length - 1] & 0xff : 0);
            if (at >= end) return;
            boolean gap = lastSeq >= 0 && seq != ((lastSeq + 1) & 0xffff);
            lastSeq = seq;
            if (gap) { // (the frame it was in, and the one before if it was its end, go)
                frame.clear();
                fu = null;
                broken = true;
            } else if (frameTs >= 0 && ts != frameTs && !frame.isEmpty()) endFrame();
            frameTs = ts;

            int type = p[at] & 0x1f;
            if (type >= 1 && type <= 23) {
                nal(slice(p, at, end));
            } else if (type == 24) { // STAP-A: several
                for (int i = at + 1; i + 2 <= end; ) {
                    int size = ((p[i] & 0xff) << 8) | (p[i + 1] & 0xff);
                    i += 2;
                    if (size == 0 || i + size > end) break;
                    nal(slice(p, i, i + size));
                    i += size;
                }
            } else if (type == 28 && end - at >= 2) { // FU-A: one in pieces
                int header = p[at + 1] & 0xff;
                if ((header & 0x80) != 0) {
                    fu = new ByteArrayOutputStream();
                    fu.write((p[at] & 0xe0) | (header & 0x1f));
                }
                if (fu != null) {
                    fu.write(p, at + 2, end - at - 2);
                    if ((header & 0x40) != 0) {
                        nal(fu.toByteArray());
                        fu = null;
                    }
                }
            }
            if (marker) endFrame();
        }

        private static byte[] slice(byte[] p, int from, int to) {
            byte[] b = new byte[to - from];
            System.arraycopy(p, from, b, 0, b.length);
            return b;
        }

        private void nal(byte[] n) {
            int type = n[0] & 0x1f;
            if (type == 7) sps = n;
            else if (type == 8) pps = n;
            else if (type == 9) return; // (access unit delimiters: not needed)
            frame.add(n);
        }

        private void endFrame() throws IOException {
            if (frame.isEmpty()) return;
            boolean picture = false, key = false;
            for (byte[] n : frame) {
                int type = n[0] & 0x1f;
                picture |= type >= 1 && type <= 5;
                key |= type == 5;
            }
            // (an SPS, PPS or SEI sent on its own, marked as a frame: with the picture that follows)
            if (!picture) return;
            List<byte[]> nals = new ArrayList<>(frame);
            frame.clear();
            if (broken) { // (a piece lost: nothing till the next key frame)
                broken = false;
                waitKey = true;
                return;
            }
            if (waitKey && !key) return;
            if (!mp4.started()) {
                if (sps == null || pps == null) return;
                mp4.start(sps, pps);
            }
            waitKey = false;
            // Sent when the next is here: how long it lasts is known then (RTP's 90 kHz
            // timestamps, 32 bits, wrapping). A step back, or a jump (cameras that start
            // with an old key frame, or restart their clock): as long as the one before.
            if (held != null) {
                long step = (int) (frameTs - heldTs);
                if (step <= 0 || step > MAX_STEP) step = lastStep;
                lastStep = step;
                mp4.frame(held, time, step, heldKey);
                time += step;
            }
            held = nals;
            heldKey = key;
            heldTs = frameTs;
        }
    }
}

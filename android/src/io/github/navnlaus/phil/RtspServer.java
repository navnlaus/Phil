package io.github.navnlaus.phil;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// The phone's camera for the PC (camview, through phil): an RTSP server,
// rtsp://phil:<password>@<phone>:47223/camera, its H.264 sent as RTP in the RTSP
// connection itself (TCP, interleaved: what camview's players ask for; UDP isn't
// offered). The login's Digest's. The camera runs only while someone watches
// (Feed: started for the first, stopped a while after the last). A viewer that
// can't keep up has frames dropped, then waits for the next key frame.
final class RtspServer {
    interface Feed {
        /** The camera on (true) or off; while on, config() and frame() come. */
        void watched(boolean on);
        void keyFrame();
    }

    static final int PORT = 47223;
    static final String PATH = "/camera";
    private static final String REALM = "phil camera";
    private static final int MTU = 1400, BACKLOG_FRAMES = 45;
    private final String user, password;
    private final Feed feed;
    private final Set<Client> playing = new CopyOnWriteArraySet<>();
    private final Set<Client> clients = new CopyOnWriteArraySet<>(); // (connected, playing or not)
    private final SecureRandom random = new SecureRandom();
    private final int ssrc = new SecureRandom().nextInt();
    private ServerSocket server;
    private volatile byte[] sps, pps;
    private int seq = new SecureRandom().nextInt(0xffff);
    private final Object configLock = new Object();
    private int asking; // viewers set up or playing: the camera's on while there are any
    private Runnable onViewers = () -> {};

    RtspServer(String user, String password, Feed feed) {
        this.user = user;
        this.password = password;
        this.feed = feed;
    }

    void onViewers(Runnable r) {
        onViewers = r;
    }

    int viewers() {
        return playing.size();
    }

    synchronized void start() throws IOException {
        if (server != null) return;
        server = new ServerSocket(PORT, 8);
        Thread t = new Thread(this::accept, "rtsp");
        t.setDaemon(true);
        t.start();
    }

    synchronized void stop() {
        try {
            if (server != null) server.close();
        } catch (IOException ignored) { /* closed */ }
        server = null;
        for (Client c : clients) c.close();
        playing.clear();
    }

    /**
     * Every viewer let go (the picture changed: another camera, size or turn); their
     * players connect again (camview's do, in a few seconds) and get the new one.
     */
    void dropViewers() {
        for (Client c : clients) c.close();
    }

    // ---------------------------------------------------------------- from the camera

    void config(byte[] sps, byte[] pps) {
        synchronized (configLock) {
            this.sps = sps;
            this.pps = pps;
            configLock.notifyAll();
        }
    }

    /** The camera stopped (failed, or off): what was known of it, forgotten. */
    void reset() {
        synchronized (configLock) {
            sps = pps = null;
        }
    }

    /** A frame, to everyone watching (a key frame: its SPS and PPS before it). */
    void frame(List<byte[]> nals, long ptsUs, boolean key) {
        if (playing.isEmpty()) return;
        long ts = (ptsUs * 9 / 100) & 0xffffffffL;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        synchronized (this) {
            if (key && sps != null && pps != null) {
                packetize(out, sps, ts, false);
                packetize(out, pps, ts, false);
            }
            for (int i = 0; i < nals.size(); i++) packetize(out, nals.get(i), ts, i == nals.size() - 1);
        }
        byte[] packets = out.toByteArray();
        for (Client c : playing) c.send(packets, key);
    }

    // One NAL unit as RTP (one packet, or FU-A pieces), each framed for the RTSP connection ($, channel 0).
    private void packetize(ByteArrayOutputStream out, byte[] nal, long ts, boolean last) {
        if (nal.length <= MTU) {
            rtp(out, ts, last, nal, 0, nal.length, null);
            return;
        }
        int indicator = (nal[0] & 0xe0) | 28, type = nal[0] & 0x1f;
        for (int at = 1; at < nal.length; ) {
            int n = Math.min(MTU - 2, nal.length - at);
            boolean first = at == 1, end = at + n >= nal.length;
            byte[] fu = {(byte) indicator, (byte) ((first ? 0x80 : 0) | (end ? 0x40 : 0) | type)};
            rtp(out, ts, last && end, nal, at, n, fu);
            at += n;
        }
    }

    private void rtp(ByteArrayOutputStream out, long ts, boolean marker, byte[] data, int off, int len, byte[] prefix) {
        int size = 12 + (prefix == null ? 0 : prefix.length) + len;
        out.write('$');
        out.write(0);
        out.write(size >> 8);
        out.write(size & 0xff);
        out.write(0x80);
        out.write((marker ? 0x80 : 0) | 96);
        seq = (seq + 1) & 0xffff;
        out.write(seq >> 8);
        out.write(seq & 0xff);
        for (int s = 24; s >= 0; s -= 8) out.write((int) (ts >> s) & 0xff);
        for (int s = 24; s >= 0; s -= 8) out.write((ssrc >> s) & 0xff);
        if (prefix != null) out.write(prefix, 0, prefix.length);
        out.write(data, off, len);
    }

    // ---------------------------------------------------------------- viewers

    private void accept() {
        ServerSocket s = server;
        while (s != null && !s.isClosed()) {
            try {
                Socket socket = s.accept();
                Client c = new Client(socket);
                clients.add(c);
                Thread t = new Thread(c::serve, "rtsp client");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                return;
            }
        }
    }

    private synchronized void asked(boolean more) {
        int before = asking;
        asking = Math.max(0, asking + (more ? 1 : -1));
        if (before == 0 && asking > 0) feed.watched(true);
        else if (before > 0 && asking == 0) feed.watched(false);
    }

    private final class Client {
        private final Socket socket;
        private OutputStream out;
        private final LinkedBlockingQueue<byte[]> queue = new LinkedBlockingQueue<>();
        private final String nonce = Long.toHexString(random.nextLong()) + Long.toHexString(random.nextLong());
        private boolean authorized, counted, waitKey = true;
        private String session;
        private volatile boolean closed;

        Client(Socket socket) {
            this.socket = socket;
        }

        void serve() {
            try {
                socket.setTcpNoDelay(true);
                socket.setSoTimeout(90_000); // (a viewer says something every minute: its keep-alive)
                DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
                out = socket.getOutputStream();
                for (;;) {
                    int first = in.read();
                    if (first < 0) break;
                    if (first == '$') { // its RTCP reports: read past
                        in.readUnsignedByte();
                        in.readFully(new byte[in.readUnsignedShort()]);
                        continue;
                    }
                    Map<String, String> h = new HashMap<>();
                    String line = line(in, first);
                    String[] request = line.split(" ");
                    for (String l; !(l = line(in, -1)).isEmpty(); ) {
                        int colon = l.indexOf(':');
                        if (colon > 0) h.put(l.substring(0, colon).trim().toLowerCase(Locale.ROOT), l.substring(colon + 1).trim());
                    }
                    if (h.containsKey("content-length")) in.readFully(new byte[Integer.parseInt(h.get("content-length").trim())]);
                    if (request.length < 3) break;
                    if (!answer(request[0], request[1], h)) break;
                }
            } catch (IOException | RuntimeException ignored) { /* gone */ }
            close();
        }

        private boolean answer(String method, String uri, Map<String, String> h) throws IOException {
            String cseq = h.getOrDefault("cseq", "0");
            if (method.equals("OPTIONS")) return reply(cseq, "200 OK", "Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER\r\n", null);
            if (!authorized) {
                authorized = checks(method, h.get("authorization"));
                if (!authorized) return reply(cseq, "401 Unauthorized", "WWW-Authenticate: Digest realm=\"" + REALM + "\", nonce=\"" + nonce + "\"\r\n", null);
            }
            String base = uri.replaceFirst("(?i)^(rtsp://[^/]*" + Pattern.quote(PATH) + ").*$", "$1");
            switch (method) {
                case "DESCRIBE": {
                    if (!uri.matches("(?i)^rtsp://[^/]*" + Pattern.quote(PATH) + "/?$")) return reply(cseq, "404 Not Found", "", null);
                    count();
                    byte[][] c = waitConfig();
                    if (c == null) return reply(cseq, "503 Service Unavailable", "", null);
                    String local = socket.getLocalAddress().getHostAddress();
                    String sdp = "v=0\r\no=- " + System.currentTimeMillis() + " 1 IN IP4 " + local + "\r\ns=phil camera\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\na=control:*\r\n"
                        + "m=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n"
                        + String.format(Locale.ROOT, "a=fmtp:96 packetization-mode=1;profile-level-id=%02x%02x%02x;sprop-parameter-sets=%s,%s\r\n",
                            c[0][1], c[0][2], c[0][3], Base64.getEncoder().encodeToString(c[0]), Base64.getEncoder().encodeToString(c[1]))
                        + "a=control:track0\r\n";
                    return reply(cseq, "200 OK", "Content-Base: " + base + "/\r\nContent-Type: application/sdp\r\n", sdp);
                }
                case "SETUP": {
                    String t = h.getOrDefault("transport", "");
                    if (!t.contains("RTP/AVP/TCP")) return reply(cseq, "461 Unsupported Transport", "", null);
                    Matcher m = Pattern.compile("interleaved=(\\d+)-(\\d+)").matcher(t);
                    String channels = m.find() ? m.group(1) + "-" + m.group(2) : "0-1";
                    if (!channels.startsWith("0-")) return reply(cseq, "461 Unsupported Transport", "", null);
                    count();
                    session = Long.toHexString(random.nextLong() & Long.MAX_VALUE);
                    return reply(cseq, "200 OK", "Transport: RTP/AVP/TCP;unicast;interleaved=" + channels + "\r\nSession: " + session + ";timeout=60\r\n", null);
                }
                case "PLAY":
                    if (session == null) return reply(cseq, "455 Method Not Valid in This State", "", null);
                    boolean ok = reply(cseq, "200 OK", "Session: " + session + "\r\nRange: npt=0.000-\r\n", null);
                    if (playing.add(this)) {
                        Thread w = new Thread(this::write, "rtsp sender");
                        w.setDaemon(true);
                        w.start();
                        onViewers.run();
                    }
                    feed.keyFrame();
                    return ok;
                case "GET_PARAMETER":
                    return reply(cseq, "200 OK", session != null ? "Session: " + session + "\r\n" : "", null);
                case "TEARDOWN":
                    reply(cseq, "200 OK", "", null);
                    return false;
                default:
                    return reply(cseq, "405 Method Not Allowed", "", null);
            }
        }

        private void count() {
            if (counted) return;
            counted = true;
            asked(true);
        }

        // The camera's SPS and PPS (it's started for the first viewer): waited for a few seconds.
        private byte[][] waitConfig() {
            synchronized (configLock) {
                long until = System.currentTimeMillis() + 6000;
                while ((sps == null || pps == null) && System.currentTimeMillis() < until) {
                    try {
                        configLock.wait(Math.max(1, until - System.currentTimeMillis()));
                    } catch (InterruptedException e) {
                        return null;
                    }
                }
                return sps == null || pps == null ? null : new byte[][] {sps, pps};
            }
        }

        private boolean checks(String method, String auth) {
            if (auth == null || !auth.regionMatches(true, 0, "digest", 0, 6)) return false;
            String u = param(auth, "username"), uri = param(auth, "uri"), response = param(auth, "response"), n = param(auth, "nonce");
            if (u == null || uri == null || response == null || !nonce.equals(n) || !user.equals(u)) return false;
            String ha1 = md5(user + ":" + REALM + ":" + password), ha2 = md5(method + ":" + uri);
            String qop = param(auth, "qop");
            String want = qop != null
                ? md5(ha1 + ":" + n + ":" + param(auth, "nc") + ":" + param(auth, "cnonce") + ":" + qop + ":" + ha2)
                : md5(ha1 + ":" + n + ":" + ha2);
            return MessageDigest.isEqual(want.getBytes(StandardCharsets.UTF_8), response.toLowerCase(Locale.ROOT).getBytes(StandardCharsets.UTF_8));
        }

        private boolean reply(String cseq, String status, String headers, String body) throws IOException {
            byte[] b = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
            String head = "RTSP/1.0 " + status + "\r\nCSeq: " + cseq + "\r\nServer: phil\r\n" + headers
                + (b.length > 0 ? "Content-Length: " + b.length + "\r\n" : "") + "\r\n";
            synchronized (this) {
                out.write(head.getBytes(StandardCharsets.UTF_8));
                out.write(b);
                out.flush();
            }
            return true;
        }

        // A frame's packets, queued for its sender; too many waiting (it can't keep up):
        // dropped, and nothing till the next key frame.
        void send(byte[] packets, boolean key) {
            if (closed) return;
            if (waitKey && !key) return;
            if (queue.size() > BACKLOG_FRAMES) {
                queue.clear();
                waitKey = true;
                feed.keyFrame();
                return;
            }
            waitKey = false;
            queue.offer(packets);
        }

        private void write() {
            try {
                while (!closed) {
                    byte[] p = queue.take();
                    synchronized (this) {
                        out.write(p);
                        out.flush();
                    }
                }
            } catch (IOException | InterruptedException ignored) { /* gone */ }
            close();
        }

        void close() {
            if (closed) return;
            closed = true;
            clients.remove(this);
            queue.offer(new byte[0]);
            if (playing.remove(this)) onViewers.run();
            if (counted) asked(false);
            counted = false;
            try {
                socket.close();
            } catch (IOException ignored) { /* closed */ }
        }
    }

    private static String line(DataInputStream in, int first) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c = first >= 0 ? first : in.read();
        while (c >= 0 && c != '\n') {
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new IOException("Too long");
            c = in.read();
        }
        if (c < 0 && b.size() == 0) throw new IOException("Closed");
        return b.toString("UTF-8");
    }

    private static String param(String header, String name) {
        Matcher m = Pattern.compile("(?i)\\b" + name + "=(?:\"([^\"]*)\"|([^,\\s]+))").matcher(header);
        return m.find() ? (m.group(1) != null ? m.group(1) : m.group(2)) : null;
    }

    private static String md5(String s) {
        try {
            byte[] d = MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder h = new StringBuilder();
            for (byte x : d) h.append(String.format("%02x", x));
            return h.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}

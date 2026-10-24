package io.github.navnlaus.phil;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.Uri;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONObject;

// The cameras' view (cams.js): camview's cameras, as the PC lists them (kept
// here, for when it's away), and their video: straight from a camera when it's
// on this network and the phone can reach it (Rtsp: its address and login are
// in the PC's list), else through the PC (link.js's /m/cam/stream: ffmpeg's
// copy there), as on mobile data. Which it was is in the answer's x-via.
final class Cams {
    private static final int REACH_MS = 1200; // a camera's port answering within this: reachable
    private static final long REACH_KEPT_MS = 20_000; // and that known for this long
    private static final long DIRECT_FAILED_MS = 60_000; // straight from it failed: through the PC this long
    private static final int PIPE_MAX = 8 * 1024 * 1024; // video not read yet: more than this, and it's stopped
    private static final Map<String, long[]> reach = new ConcurrentHashMap<>(); // host:port -> {at, 1/0}
    private static final Map<String, Long> directFailed = new ConcurrentHashMap<>(); // id -> when

    private Cams() {}

    /** {cameras, from: "pc" or "kept", metered}: the PC's list, else the one kept. */
    static JSONObject list(Context context, Store store) throws Exception {
        watch(context);
        File kept = new File(context.getFilesDir(), "cameras.json");
        JSONArray cams = null;
        String from = "pc";
        if (store.paired()) {
            try {
                cams = Net.call(store, "GET", "/m/api/cameras", null).optJSONArray("cameras");
                if (cams != null) Serve.write(kept, cams.toString());
            } catch (Net.Answer e) {
                throw e;
            } catch (IOException e) {
                cams = null;
            }
        }
        if (cams == null) {
            from = "kept";
            cams = kept.exists() ? new JSONArray(Net.read(new FileInputStream(kept))) : new JSONArray();
        }
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        return new JSONObject().put("cameras", cams).put("from", from).put("metered", cm != null && cm.isActiveNetworkMetered());
    }

    /** A camera's live video: [the stream, "direct" or "pc"]. */
    static Object[] stream(Context context, Store store, String id, String profile, String mode) throws Exception {
        watch(context);
        String direct = "copy".equals(mode) ? directUrl(context, id, profile) : null;
        if (direct != null) {
            Rtsp rtsp = new Rtsp(direct);
            Long failed = directFailed.get(id);
            if ((failed == null || System.currentTimeMillis() - failed > DIRECT_FAILED_MS) && reachable(rtsp.host(), rtsp.port())) {
                return new Object[] {play(id, rtsp), "direct"};
            }
        }
        if (!store.paired()) throw new Net.Answer(409, "Not paired with a PC");
        String path = "/m/cam/stream?id=" + Uri.encode(id) + "&profile=" + Uri.encode(profile == null ? "" : profile) + "&mode=" + Uri.encode(mode);
        return new Object[] {Net.request(store, "GET", path, null).getInputStream(), "pc"};
    }

    // Its RTSP address for `profile` (the PC's list, as kept), if it's on a network it can be reached on straight.
    private static String directUrl(Context context, String id, String profile) {
        try {
            File kept = new File(context.getFilesDir(), "cameras.json");
            if (!kept.exists()) return null;
            JSONArray cams = new JSONArray(Net.read(new FileInputStream(kept)));
            for (int i = 0; i < cams.length(); i++) {
                JSONObject c = cams.getJSONObject(i);
                if (!id.equals(c.optString("id"))) continue;
                JSONObject direct = c.optJSONObject("direct");
                if (direct == null) return null;
                String url = profile == null || profile.isEmpty() ? null : direct.optString(profile, null);
                if (url == null && c.optJSONArray("profiles") != null && c.getJSONArray("profiles").length() > 0) {
                    url = direct.optString(c.getJSONArray("profiles").getJSONObject(0).optString("token"), null);
                }
                return url;
            }
        } catch (Exception ignored) { /* none kept */ }
        return null;
    }

    private static boolean reachable(String host, int port) {
        String key = host + ":" + port;
        long[] r = reach.get(key);
        if (r != null && System.currentTimeMillis() - r[0] < REACH_KEPT_MS) return r[1] == 1;
        boolean ok;
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), REACH_MS);
            ok = true;
        } catch (IOException e) {
            ok = false;
        }
        reach.put(key, new long[] {System.currentTimeMillis(), ok ? 1 : 0});
        return ok;
    }

    // The network changing (Wi-Fi to mobile data, say): what's reachable is asked again.
    private static boolean watching;
    private static synchronized void watch(Context context) {
        if (watching) return;
        watching = true;
        ConnectivityManager cm = context.getApplicationContext().getSystemService(ConnectivityManager.class);
        if (cm != null) cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { forget(); }
            @Override public void onLinkPropertiesChanged(Network network, LinkProperties lp) { forget(); }
            @Override public void onLost(Network network) { forget(); }
            private void forget() {
                reach.clear();
                directFailed.clear();
            }
        });
    }

    // The camera played into a pipe the page reads, on a thread of its own; the
    // page letting go (the pipe closed) stops it.
    private static InputStream play(String id, Rtsp rtsp) {
        Pipe pipe = new Pipe();
        Thread t = new Thread(() -> {
            try {
                rtsp.play(pipe.sink());
            } catch (IOException e) {
                if (pipe.written == 0 && !pipe.closed) directFailed.put(id, System.currentTimeMillis());
            } finally {
                rtsp.close();
                pipe.end();
            }
        }, "camera " + id);
        t.setDaemon(true);
        t.start();
        return pipe;
    }

    // Bytes from the camera's thread to the WebView's: as they come, read in
    // whatever pieces it asks for. Closed by the WebView: the writer's next write
    // fails. Too much unread (the page stalled): it fails too.
    private static final class Pipe extends InputStream {
        private final ArrayDeque<byte[]> chunks = new ArrayDeque<>();
        private byte[] head;
        private int headAt, queued;
        private boolean ended;
        volatile boolean closed;
        volatile long written;

        OutputStream sink() {
            return new OutputStream() {
                @Override public void write(int b) throws IOException {
                    write(new byte[] {(byte) b}, 0, 1);
                }
                @Override public void write(byte[] b, int off, int len) throws IOException {
                    byte[] copy = new byte[len];
                    System.arraycopy(b, off, copy, 0, len);
                    synchronized (Pipe.this) {
                        if (closed) throw new IOException("The page let go");
                        if (queued + len > PIPE_MAX) throw new IOException("The page isn't reading");
                        chunks.add(copy);
                        queued += len;
                        written += len;
                        Pipe.this.notifyAll();
                    }
                }
            };
        }

        synchronized void end() {
            ended = true;
            notifyAll();
        }

        @Override public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
        }

        @Override public synchronized int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            while (head == null) {
                if (closed) throw new IOException("Closed");
                head = chunks.poll();
                headAt = 0;
                if (head != null) break;
                if (ended) return -1;
                try {
                    wait();
                } catch (InterruptedException e) {
                    throw new IOException("Interrupted");
                }
            }
            int n = Math.min(len, head.length - headAt);
            System.arraycopy(head, headAt, b, off, n);
            headAt += n;
            queued -= n;
            if (headAt >= head.length) head = null;
            return n;
        }

        @Override public synchronized int available() {
            return queued;
        }

        @Override public synchronized void close() {
            closed = true;
            chunks.clear();
            head = null;
            notifyAll();
        }
    }
}

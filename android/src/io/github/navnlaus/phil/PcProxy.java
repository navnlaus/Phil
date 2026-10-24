package io.github.navnlaus.phil;

import android.net.Uri;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

// The PC's songs for Android's MediaPlayer, which can't be given phil's pinned
// certificate or the token: http://127.0.0.1:<port>/<secret>/song?path=... here,
// passed on through the pinned link (Net.request: /m/file, its Range too). Only
// this phone's own apps can reach 127.0.0.1, and only with the secret (made anew
// each time it starts).
final class PcProxy {
    private final Store store;
    private final String secret;
    private final ServerSocket server;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    PcProxy(Store store) throws IOException {
        this.store = store;
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        secret = s.toString();
        server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        pool.execute(this::accept);
    }

    /** The address MediaPlayer plays the PC's song `path` from. */
    String url(String path) {
        return "http://127.0.0.1:" + server.getLocalPort() + "/" + secret + "/song?path=" + Uri.encode(path);
    }

    void close() {
        try {
            server.close();
        } catch (IOException ignored) { /* closed */ }
        pool.shutdownNow();
    }

    private void accept() {
        while (!server.isClosed()) {
            try {
                Socket s = server.accept();
                pool.execute(() -> serve(s));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket socket) {
        try (Socket s = socket) {
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
            String request = in.readLine();
            Map<String, String> headers = new HashMap<>();
            for (String line; (line = in.readLine()) != null && !line.isEmpty(); ) {
                int colon = line.indexOf(':');
                if (colon > 0) headers.put(line.substring(0, colon).trim().toLowerCase(), line.substring(colon + 1).trim());
            }
            OutputStream out = s.getOutputStream();
            String[] parts = request == null ? new String[0] : request.split(" ");
            Uri u = parts.length > 1 ? Uri.parse("http://x" + parts[1]) : null;
            if (u == null || !("/" + secret + "/song").equals(u.getPath()) || u.getQueryParameter("path") == null) {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                return;
            }
            Map<String, String> ask = new HashMap<>();
            if (headers.containsKey("range")) ask.put("range", headers.get("range"));
            HttpsURLConnection c;
            try {
                c = Net.request(store, "GET", "/m/file?path=" + Uri.encode(u.getQueryParameter("path")), ask);
            } catch (IOException e) {
                out.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                return;
            }
            StringBuilder head = new StringBuilder("HTTP/1.1 " + c.getResponseCode() + (c.getResponseCode() == 206 ? " Partial Content" : " OK") + "\r\n");
            for (String h : new String[] {"content-type", "content-length", "content-range", "accept-ranges"}) {
                if (c.getHeaderField(h) != null) head.append(h).append(": ").append(c.getHeaderField(h)).append("\r\n");
            }
            head.append("Connection: close\r\n\r\n");
            out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
            try (InputStream body = c.getInputStream()) {
                Thumbs.copy(body, out);
            }
        } catch (IOException ignored) { /* the player let go */ }
    }
}

package io.github.navnlaus.phil;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

// The light phil's page and everything it asks for, at https://phil.invalid/
// (a name that's never anyone's: the WebView's requests to it are answered here,
// MainActivity's shouldInterceptRequest, and go nowhere else):
//
//   /, /ui/...            the page (assets/www/)
//   /theme/base.css       phil's look: the shared styles and the theme in use,
//   /theme/theme.css      as the PC last had them (else the ones built in)
//   /phone/...            the phone's own files (Local), their thumbnails (Thumbs)
//   /pc/...               the PC's (link.js's /m/...), through the pinned link
//                         (Net); their thumbnails kept here (Thumbs)
final class Serve {
    static final String HOST = "phil.invalid";
    static final String ORIGIN = "https://" + HOST + "/";
    private static final long STATUS_MS = 15_000; // the PC's reachability, asked again after
    private final Context context;
    private final Store store;
    private final Thumbs thumbs;
    private final SharedPreferences prefs;
    private JSONObject status;
    private long statusAt;

    Serve(Context context) {
        this.context = context.getApplicationContext();
        store = new Store(context);
        thumbs = new Thumbs(context);
        prefs = context.getSharedPreferences("theme", Context.MODE_PRIVATE);
    }

    WebResourceResponse handle(WebResourceRequest req) {
        Uri u = req.getUrl();
        if (!HOST.equals(u.getHost())) return null;
        String p = u.getPath() == null ? "/" : u.getPath();
        try {
            if (p.equals("/")) return asset("index.html");
            if (p.startsWith("/ui/")) return asset(p.substring(4));
            if (p.startsWith("/theme/")) return theme(p.substring(7));
            if (p.startsWith("/phone/")) return phone(p.substring(7), u, req.getRequestHeaders());
            if (p.startsWith("/pc/")) return pc(p.substring(4), u, req.getRequestHeaders());
            return error(404, "Not found");
        } catch (Net.Answer e) {
            if (e.status == 401) forget();
            return error(e.status, e.getMessage());
        } catch (Exception e) {
            return error(502, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
    }

    // ---------------------------------------------------------------- the page, its look

    private WebResourceResponse asset(String name) throws IOException {
        if (!name.matches("[\\w.-]+")) return error(404, "Not found");
        InputStream in = context.getAssets().open("www/" + name);
        String type = name.endsWith(".html") ? "text/html" : name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css"
            : name.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
        return response(200, type, in, Map.of("cache-control", "no-cache"));
    }

    private WebResourceResponse theme(String name) throws IOException {
        if (!name.equals("base.css") && !name.equals("theme.css")) return error(404, "Not found");
        File kept = new File(context.getFilesDir(), "theme-" + name);
        InputStream in = kept.exists() ? new FileInputStream(kept) : context.getAssets().open("www/theme-" + name);
        return response(200, "text/css", in, Map.of("cache-control", "no-cache"));
    }

    // The PC's look, if it's another than the one kept: kept. True if it changed.
    private boolean fetchTheme() {
        try {
            JSONObject t = Net.call(store, "GET", "/link/theme", null);
            String base = t.optString("base"), css = t.optString("css");
            if (css.isEmpty() || (base + "\0" + css).hashCode() == prefs.getInt("hash", 0)) return false;
            write(new File(context.getFilesDir(), "theme-base.css"), base);
            write(new File(context.getFilesDir(), "theme-theme.css"), css);
            prefs.edit().putInt("hash", (base + "\0" + css).hashCode()).putString("name", t.optString("name")).apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void write(File f, String text) throws IOException {
        File part = new File(f.getPath() + ".part");
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(part)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
        if (!part.renameTo(f)) throw new IOException("Couldn't keep " + f.getName());
    }

    // ---------------------------------------------------------------- the phone's

    private WebResourceResponse phone(String what, Uri u, Map<String, String> headers) throws Exception {
        switch (what) {
            case "places":
                return json(Local.places(context));
            case "list":
                return json(Local.list(new File(param(u, "path")), "1".equals(u.getQueryParameter("hidden"))));
            case "summary":
                return json(Local.summary(thumbs, new File(param(u, "path"))));
            case "thumb": {
                File t = thumbs.local(new File(param(u, "path")));
                return t == null ? error(404, "No thumbnail") : response(200, "image/jpeg", new FileInputStream(t), Map.of("cache-control", "max-age=31536000, immutable"));
            }
            case "file": {
                File f = new File(param(u, "path"));
                return f.isFile() ? file(f, headers) : error(404, "No such file");
            }
            default:
                return error(404, "Not found");
        }
    }

    // A file, or the part of it asked for (Range: a video seeking).
    private static WebResourceResponse file(File f, Map<String, String> headers) throws IOException {
        long length = f.length(), start = 0, end = length - 1;
        String range = header(headers, "range");
        java.util.regex.Matcher m = range == null ? null : java.util.regex.Pattern.compile("bytes=(\\d*)-(\\d*)").matcher(range.trim());
        Map<String, String> out = new HashMap<>();
        out.put("accept-ranges", "bytes");
        out.put("cache-control", "no-cache");
        int status = 200;
        if (m != null && m.matches() && (!m.group(1).isEmpty() || !m.group(2).isEmpty())) {
            if (m.group(1).isEmpty()) start = Math.max(0, length - Long.parseLong(m.group(2)));
            else {
                start = Long.parseLong(m.group(1));
                if (!m.group(2).isEmpty()) end = Math.min(Long.parseLong(m.group(2)), length - 1);
            }
            if (start > end) return error(416, "Range Not Satisfiable");
            status = 206;
            out.put("content-range", "bytes " + start + "-" + end + "/" + length);
        }
        InputStream in = new FileInputStream(f);
        for (long left = start; left > 0; ) left -= in.skip(left);
        out.put("content-length", String.valueOf(end - start + 1));
        return response(status, Local.mime(f), limited(in, end - start + 1), out);
    }

    // ---------------------------------------------------------------- the PC's

    private WebResourceResponse pc(String what, Uri u, Map<String, String> headers) throws Exception {
        if (what.equals("status")) return json(status(true));
        if (!store.paired()) return error(409, "Not paired with a PC");
        switch (what) {
            case "places":
                return json(Net.call(store, "GET", "/m/api/places", null));
            case "list":
                return json(Net.call(store, "GET", "/m/api/list?path=" + Uri.encode(param(u, "path")) + ("1".equals(u.getQueryParameter("hidden")) ? "&hidden=1" : ""), null));
            case "summary":
                return json(Net.call(store, "GET", "/m/api/summary?path=" + Uri.encode(param(u, "path")), null));
            case "thumb": { // a thumbnail phil there may have to make: kept here by the file's path, size and time
                String path = param(u, "path");
                File t = thumbs.pc(Thumbs.pcName(path, num(u, "size"), num(u, "mtime")), (o) -> fetch("/m/thumb?path=" + Uri.encode(path), o));
                return t == null ? error(404, "No thumbnail") : response(200, "image/jpeg", new FileInputStream(t), Map.of("cache-control", "max-age=31536000, immutable"));
            }
            case "file": { // played or shown: from the PC as it's asked for (its Range passed on)
                Map<String, String> ask = new HashMap<>();
                String range = header(headers, "range");
                if (range != null) ask.put("range", range);
                HttpsURLConnection c = Net.request(store, "GET", "/m/file?path=" + Uri.encode(param(u, "path")), ask);
                Map<String, String> out = new HashMap<>();
                for (String h : new String[] {"content-length", "content-range", "accept-ranges"}) if (c.getHeaderField(h) != null) out.put(h, c.getHeaderField(h));
                String type = c.getContentType() == null ? "application/octet-stream" : c.getContentType().split(";")[0];
                return response(c.getResponseCode(), type, c.getInputStream(), out);
            }
            default:
                if (what.startsWith("m/thumbs/")) { // one by its name there (a listing's, a folder summary's): the same picture always
                    String name = what.substring(what.lastIndexOf('/') + 1);
                    File t = thumbs.pc("n-" + name, (o) -> fetch("/" + what, o));
                    return t == null ? error(404, "No thumbnail") : response(200, "image/jpeg", new FileInputStream(t), Map.of("cache-control", "max-age=31536000, immutable"));
                }
                return error(404, "Not found");
        }
    }

    private boolean fetch(String path, java.io.OutputStream out) throws IOException {
        HttpsURLConnection c;
        try {
            c = Net.request(store, "GET", path, null);
        } catch (Net.Answer e) {
            if (e.status == 404) return false;
            throw e;
        }
        try (InputStream in = c.getInputStream()) {
            Thumbs.copy(in, out);
        }
        return true;
    }

    // Paired? In reach (asked again every STATUS_MS)? The PC's look fetched when it is.
    synchronized JSONObject status(boolean cached) throws Exception {
        if (cached && status != null && System.currentTimeMillis() - statusAt < STATUS_MS && status.optBoolean("paired") == store.paired()) return status;
        JSONObject s = new JSONObject().put("paired", store.paired()).put("name", store.pcName()).put("reachable", false);
        if (store.paired() && Net.reachable(store) != null) {
            try {
                JSONObject me = Net.call(store, "GET", "/link/me", null);
                Updater.offered(context, me.optJSONObject("app"));
                s.put("reachable", true).put("themeChanged", fetchTheme());
            } catch (Net.Answer e) {
                if (e.status == 401) {
                    forget();
                    s.put("paired", false).put("forgotten", true);
                }
            }
        }
        String update = Updater.waiting(context);
        if (update != null) s.put("update", update); // (a newer app on the PC: its version's name)
        status = s;
        statusAt = System.currentTimeMillis();
        return s;
    }

    // The PC forgot this phone: so does the app (pairing again is the setup page's).
    private void forget() {
        if (!store.paired()) return;
        store.unpair();
        context.stopService(new android.content.Intent(context, LinkService.class));
    }

    // ---------------------------------------------------------------- answers

    private static String param(Uri u, String key) throws IOException {
        String v = u.getQueryParameter(key);
        if (v == null || !v.startsWith("/")) throw new Net.Answer(400, key + ", please");
        return v;
    }

    private static long num(Uri u, String key) {
        try {
            return Long.parseLong(u.getQueryParameter(key));
        } catch (Exception e) {
            return 0;
        }
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> h : headers.entrySet()) if (h.getKey().equalsIgnoreCase(name)) return h.getValue();
        return null;
    }

    private static WebResourceResponse json(Object o) {
        return response(200, "application/json", new ByteArrayInputStream(o.toString().getBytes(StandardCharsets.UTF_8)), Map.of("cache-control", "no-store"));
    }

    private static WebResourceResponse error(int status, String message) {
        String body;
        try {
            body = new JSONObject().put("error", message).toString();
        } catch (Exception e) {
            body = "{}";
        }
        return response(status, "application/json", new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)), Map.of("cache-control", "no-store"));
    }

    private static WebResourceResponse response(int status, String type, InputStream in, Map<String, String> headers) {
        String reason = status == 200 ? "OK" : status == 206 ? "Partial Content" : status == 404 ? "Not Found" : status < 400 ? "OK" : "Error";
        WebResourceResponse r = new WebResourceResponse(type, type.startsWith("text/") || type.equals("application/json") ? "utf-8" : null, status, reason, new HashMap<>(headers), in);
        return r;
    }

    private static InputStream limited(InputStream in, long length) {
        return new FilterInputStream(in) {
            long left = length;
            @Override public int read() throws IOException {
                if (left <= 0) return -1;
                int b = super.read();
                if (b >= 0) left--;
                return b;
            }
            @Override public int read(byte[] buf, int off, int len) throws IOException {
                if (left <= 0) return -1;
                int n = super.read(buf, off, (int) Math.min(len, left));
                if (n > 0) left -= n;
                return n;
            }
        };
    }
}

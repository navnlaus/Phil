package io.github.navnlaus.phil;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;
import org.json.JSONArray;
import org.json.JSONObject;

// phil on PCs on this Wi-Fi: its link server announces itself over mDNS
// (_phil._tcp, avahi; apps/phil/link.js), with its certificate's fingerprint's
// start in its TXT record ("fp").
final class Discovery {
    private Discovery() {}

    interface Found {
        void found(String host, int port, String fp);
    }

    // NsdManager resolves one service at a time (before Android 14): they wait their turn.
    private static final ArrayDeque<Runnable> waiting = new ArrayDeque<>();
    private static boolean resolving;

    static void resolve(NsdManager nsd, NsdServiceInfo service, Found found) {
        Runnable job = () -> nsd.resolveService(service, new NsdManager.ResolveListener() {
            @Override public void onResolveFailed(NsdServiceInfo s, int code) { next(); }
            @Override public void onServiceResolved(NsdServiceInfo s) {
                byte[] fp = s.getAttributes().get("fp");
                if (s.getHost() != null) found.found(s.getHost().getHostAddress(), s.getPort(), fp == null ? null : new String(fp, StandardCharsets.UTF_8));
                next();
            }
        });
        synchronized (waiting) {
            if (resolving) {
                waiting.add(job);
                return;
            }
            resolving = true;
        }
        job.run();
    }

    private static void next() {
        Runnable job;
        synchronized (waiting) {
            job = waiting.poll();
            if (job == null) resolving = false;
        }
        if (job != null) job.run();
    }

    // The PCs found within `ms`: [{name, host, port, fp}], to `done` (on the main thread).
    static void find(Context context, long ms, Consumer<JSONArray> done) {
        NsdManager nsd = context.getSystemService(NsdManager.class);
        Map<String, JSONObject> pcs = new LinkedHashMap<>();
        Handler main = new Handler(Looper.getMainLooper());
        NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String type, int code) {}
            @Override public void onStopDiscoveryFailed(String type, int code) {}
            @Override public void onDiscoveryStarted(String type) {}
            @Override public void onDiscoveryStopped(String type) {}
            @Override public void onServiceLost(NsdServiceInfo s) {}
            @Override public void onServiceFound(NsdServiceInfo s) {
                String name = s.getServiceName();
                resolve(nsd, s, (host, port, fp) -> {
                    try {
                        synchronized (pcs) {
                            pcs.put(host + ":" + port, new JSONObject().put("name", name).put("host", host).put("port", port).put("fp", fp == null ? "" : fp));
                        }
                    } catch (Exception ignored) { /* skipped */ }
                });
            }
        };
        nsd.discoverServices("_phil._tcp", NsdManager.PROTOCOL_DNS_SD, listener);
        main.postDelayed(() -> {
            try {
                nsd.stopServiceDiscovery(listener);
            } catch (IllegalArgumentException ignored) { /* it never started */ }
            JSONArray out = new JSONArray();
            synchronized (pcs) {
                for (JSONObject pc : pcs.values()) out.put(pc);
            }
            done.accept(out);
        }, ms);
    }
}

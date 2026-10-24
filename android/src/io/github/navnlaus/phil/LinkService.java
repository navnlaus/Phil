package io.github.navnlaus.phil;

import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

// Runs while the phone is shared with the PC (a notification says so, with
// Stop): the SFTP server (Sftp), the phone announced on the Wi-Fi (mDNS,
// _phil-phone._tcp) and the PC looked for there (_phil._tcp: its address now),
// and a check-in with the PC (POST /link/hello: this phone's addresses, so phil
// can reach it on the Wi-Fi or over Tailscale) when it starts, when the network
// changes, and every few minutes. Also what's sent to the PC (Share → phil) and
// downloaded from it (the light phil's downloads), one at a time, in notifications.
public class LinkService extends Service {
    static final String SHARE = "share", DOWNLOAD = "download", STOP = "stop", HELLO = "hello";
    private static final int ONGOING = 1;
    private static final long HELLO_EVERY_MS = 5 * 60_000;

    // The light phil's window, told what's done (JSON: {sent: dir}, {downloaded: path}) while it's open.
    static volatile java.util.function.Consumer<String> listener;
    private final Sftp sftp = new Sftp();
    private final ExecutorService work = Executors.newSingleThreadExecutor(); // transfers, one at a time
    private final ExecutorService net = Executors.newSingleThreadExecutor(); // check-ins
    private final Handler main = new Handler(Looper.getMainLooper());
    private Store store;
    private NsdManager nsd;
    private NsdManager.RegistrationListener announced;
    private NsdManager.DiscoveryListener looking;
    private ConnectivityManager.NetworkCallback networkWatch;
    private int nextNote = 100;
    private String status = "";

    static void start(Context context, Intent intent) {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
        else context.startService(intent);
    }

    static void start(Context context) {
        start(context, new Intent(context, LinkService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        store = new Store(this);
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("link", "Sharing with the PC", NotificationManager.IMPORTANCE_MIN));
        nm.createNotificationChannel(new NotificationChannel("transfers", "Files sent and received", NotificationManager.IMPORTANCE_LOW));
        goForeground("Starting…");
        if (!store.paired()) {
            stopSelf();
            return;
        }
        net.execute(() -> {
            try {
                sftp.start(this, store.sftpPassword());
                status = "Its files are shared with " + store.pcName();
            } catch (Exception e) {
                status = "Can't share its files: " + e.getMessage();
            }
            main.post(() -> goForeground(status));
            hello();
        });
        announce();
        lookForPc();
        watchNetwork();
        main.postDelayed(this::helloLater, HELLO_EVERY_MS);
    }

    private void goForeground(String text) {
        Intent open = new Intent(this, MainActivity.class);
        Intent stop = new Intent(this, LinkService.class).setAction(STOP);
        Notification n = new Notification.Builder(this, "link")
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("phil")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
            .addAction(new Notification.Action.Builder(null, "Stop sharing", PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE)).build())
            .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ONGOING, n);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (STOP.equals(action)) {
            store.setSharing(false);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (SHARE.equals(action)) {
            List<Uri> uris = new ArrayList<>();
            ClipData clip = intent.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getUri() != null) uris.add(clip.getItemAt(i).getUri());
            String text = intent.getStringExtra(Intent.EXTRA_TEXT), dir = intent.getStringExtra("dir");
            work.execute(() -> send(uris, uris.isEmpty() ? text : null, dir));
        } else if (DOWNLOAD.equals(action)) {
            String path = intent.getStringExtra("path"), name = intent.getStringExtra("name");
            work.execute(() -> download(path, name));
        } else if (HELLO.equals(action)) {
            net.execute(this::hello);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        if (networkWatch != null) getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkWatch);
        if (nsd != null) {
            try {
                if (announced != null) nsd.unregisterService(announced);
                if (looking != null) nsd.stopServiceDiscovery(looking);
            } catch (IllegalArgumentException ignored) { /* never started */ }
        }
        net.execute(sftp::stop);
        net.shutdown();
        work.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------ the PC

    private void helloLater() {
        net.execute(this::hello);
        main.postDelayed(this::helloLater, HELLO_EVERY_MS);
    }

    // Tells the PC where this phone is; it answers with its own addresses (new ones kept).
    private void hello() {
        if (!store.paired()) return;
        try {
            JSONObject body = new JSONObject()
                .put("phoneId", store.phoneId())
                .put("name", Store.deviceName(this))
                .put("model", Build.MANUFACTURER + " " + Build.MODEL)
                .put("sftpPort", Store.SFTP_PORT)
                .put("sharing", sftp.running())
                .put("addresses", new JSONArray(Net.addresses()));
            Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery != null) {
                int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                int plugged = battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
                if (level >= 0) body.put("battery", new JSONObject().put("percent", level * 100 / Math.max(1, scale)).put("charging", plugged != 0));
            }
            JSONObject answer = Net.call(store, "POST", "/link/hello", body);
            Updater.offered(this, answer.optJSONObject("app")); // (a newer app there: offered)
            JSONArray hosts = answer.optJSONArray("hosts");
            if (hosts != null) {
                List<String> all = store.hosts();
                for (int i = 0; i < hosts.length(); i++) if (!all.contains(hosts.getString(i))) all.add(hosts.getString(i));
                store.setHosts(all);
            }
        } catch (Net.Answer e) {
            if (e.status == 401) { // the PC forgot this phone (unpaired there)
                store.unpair();
                main.post(this::stopSelf);
            }
        } catch (Exception ignored) { /* not reachable now: next time */ }
    }

    private void watchNetwork() {
        ConnectivityManager cm = getSystemService(ConnectivityManager.class);
        networkWatch = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { soon(); }
            @Override public void onLinkPropertiesChanged(Network network, LinkProperties lp) { soon(); }
            private void soon() {
                main.removeCallbacks(helloNow);
                main.postDelayed(helloNow, 2000);
            }
        };
        cm.registerDefaultNetworkCallback(networkWatch);
    }

    private final Runnable helloNow = () -> net.execute(this::hello);

    // mDNS: this phone, for the PC; the PC (its certificate's fingerprint in its TXT), for its address on this Wi-Fi.
    private void announce() {
        nsd = getSystemService(NsdManager.class);
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName(Store.deviceName(this));
        info.setServiceType("_phil-phone._tcp");
        info.setPort(Store.SFTP_PORT);
        info.setAttribute("id", store.phoneId());
        announced = new NsdManager.RegistrationListener() {
            @Override public void onRegistrationFailed(NsdServiceInfo s, int code) { announced = null; }
            @Override public void onUnregistrationFailed(NsdServiceInfo s, int code) {}
            @Override public void onServiceRegistered(NsdServiceInfo s) {}
            @Override public void onServiceUnregistered(NsdServiceInfo s) {}
        };
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, announced);
    }

    private void lookForPc() {
        looking = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String type, int code) { looking = null; }
            @Override public void onStopDiscoveryFailed(String type, int code) {}
            @Override public void onDiscoveryStarted(String type) {}
            @Override public void onDiscoveryStopped(String type) {}
            @Override public void onServiceLost(NsdServiceInfo s) {}
            @Override public void onServiceFound(NsdServiceInfo s) {
                Discovery.resolve(nsd, s, (host, port, fp) -> {
                    String mine = store.fingerprint();
                    if (mine == null || fp == null || !mine.startsWith(fp) || port != store.pcPort()) return;
                    List<String> hosts = store.hosts();
                    if (!hosts.isEmpty() && hosts.get(0).equals(host)) return;
                    hosts.remove(host);
                    hosts.add(0, host);
                    store.setHosts(hosts);
                    net.execute(LinkService.this::hello);
                });
            }
        };
        nsd.discoverServices("_phil._tcp", NsdManager.PROTOCOL_DNS_SD, looking);
    }

    // ------------------------------------------------------------ transfers

    // Files shared to phil (or text): sent to the PC, into `dir` there (null: its Downloads).
    private void send(List<Uri> uris, String text, String dir) {
        int id = nextNote++;
        int done = 0;
        String failed = null;
        try {
            if (text != null) {
                byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
                upload(id, "Note " + new java.text.SimpleDateFormat("yyyy-MM-dd HH.mm", java.util.Locale.ROOT).format(new java.util.Date()) + ".txt",
                    bytes.length, new java.io.ByteArrayInputStream(bytes), dir);
                done++;
            }
            for (Uri uri : uris) {
                String name = uri.getLastPathSegment() != null ? uri.getLastPathSegment() : "file"; // (a file:// one: no display name)
                long size = -1;
                try (Cursor c = getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        if (!c.isNull(0)) name = c.getString(0);
                        if (!c.isNull(1)) size = c.getLong(1);
                    }
                }
                if ("file".equals(uri.getScheme()) && size < 0) size = new File(uri.getPath()).length();
                try (InputStream in = getContentResolver().openInputStream(uri)) {
                    upload(id, name, size, in, dir);
                }
                done++;
            }
        } catch (Exception e) {
            failed = e.getMessage();
        }
        int total = uris.size() + (text != null ? 1 : 0);
        String where = dir == null ? "its Downloads" : new File(dir).getName();
        note(id, failed == null ? "Sent to " + store.pcName() : "Couldn't send it to " + store.pcName(),
            failed == null ? (total == 1 ? "1 file, into " + where : total + " files, into " + where) : done + " of " + total + " sent. " + failed, -1, null);
        tell("sent", dir == null ? "" : dir);
    }

    private void upload(int id, String name, long size, InputStream in, String dir) throws IOException {
        IOException last = null;
        String to = (dir == null ? "/link/upload?" : "/m/api/upload?dir=" + URLEncoder.encode(dir, "UTF-8") + "&")
            + "name=" + URLEncoder.encode(name, "UTF-8") + (size >= 0 ? "&size=" + size : "");
        for (String host : store.hosts()) {
            HttpsURLConnection c;
            try {
                c = Net.open(host, store.pcPort(), to, store.fingerprint(), null, 4000);
                c.setRequestMethod("POST");
                c.setRequestProperty("authorization", "Bearer " + store.token());
                c.setRequestProperty("content-type", "application/octet-stream");
                c.setDoOutput(true);
                if (size >= 0) c.setFixedLengthStreamingMode(size);
                else c.setChunkedStreamingMode(64 * 1024);
                c.connect();
            } catch (IOException e) {
                last = e;
                continue;
            }
            store.answered(host);
            byte[] buf = new byte[64 * 1024];
            long sent = 0, shown = 0;
            try (OutputStream out = c.getOutputStream()) {
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    sent += n;
                    if (sent - shown > 512 * 1024) {
                        shown = sent;
                        note(id, "Sending " + name, null, size > 0 ? (int) (sent * 100 / size) : 0, null);
                    }
                }
            }
            Net.answer(c, c.getResponseCode());
            return;
        }
        throw last != null ? last : new IOException("No address for " + store.pcName());
    }

    // A PC file (the light phil's "Save to phone"), into the phone's Download folder.
    private void download(String path, String suggested) {
        String name = suggested;
        int id = nextNote++;
        try {
            HttpsURLConnection c = Net.request(store, "GET", "/m/file?dl=1&path=" + Uri.encode(path), null);
            long size = c.getContentLengthLong();
            String given = nameIn(c.getHeaderField("content-disposition"));
            if (given != null) name = given;
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            dir.mkdirs();
            File file = freeName(dir, name);
            File part = new File(dir, "." + file.getName() + ".part");
            byte[] buf = new byte[64 * 1024];
            long got = 0, shown = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                for (int n; (n = in.read(buf)) > 0; ) {
                    out.write(buf, 0, n);
                    got += n;
                    if (got - shown > 512 * 1024) {
                        shown = got;
                        note(id, "Downloading " + file.getName(), null, size > 0 ? (int) (got * 100 / size) : 0, null);
                    }
                }
            } catch (IOException e) {
                part.delete();
                throw e;
            }
            if (!part.renameTo(file)) throw new IOException("Couldn't save it as " + file.getName());
            MediaScannerConnection.scanFile(this, new String[] {file.getPath()}, null, null);
            note(id, "Downloaded " + file.getName(), "In Download", -1, new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
            tell("downloaded", file.getPath());
        } catch (Exception e) {
            note(id, "Couldn't download " + name, e.getMessage(), -1, null);
        }
    }

    // The file's name in a Content-Disposition (filename*=UTF-8''..., else filename="..."), or null.
    static String nameIn(String disposition) {
        if (disposition == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("filename\\*\\s*=\\s*UTF-8''([^;]+)", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(disposition);
        try {
            if (m.find()) return java.net.URLDecoder.decode(m.group(1).trim().replace("+", "%2B"), "UTF-8");
        } catch (Exception ignored) { /* the plain one */ }
        m = java.util.regex.Pattern.compile("filename\\s*=\\s*\"([^\"]*)\"").matcher(disposition);
        return m.find() && !m.group(1).isEmpty() ? m.group(1) : null;
    }

    private static void tell(String what, String value) {
        java.util.function.Consumer<String> to = listener;
        if (to == null) return;
        try {
            to.accept(new JSONObject().put(what, value).toString());
        } catch (Exception ignored) { /* no window */ }
    }

    static File freeName(File dir, String name) {
        name = name.replace('/', '_');
        File f = new File(dir, name);
        int dot = name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length();
        for (int n = 2; f.exists(); n++) f = new File(dir, name.substring(0, dot) + " (" + n + ")" + name.substring(dot));
        return f;
    }

    // A transfer's notification: `percent` 0-100 while it goes (-1: done).
    private void note(int id, String title, String text, int percent, Intent open) {
        Notification.Builder b = new Notification.Builder(this, "transfers")
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setOnlyAlertOnce(true);
        if (text != null) b.setContentText(text);
        if (percent >= 0) b.setProgress(100, percent, percent == 0).setOngoing(true);
        else b.setAutoCancel(true);
        if (open != null) b.setContentIntent(PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE));
        getSystemService(NotificationManager.class).notify(id, b.build());
    }
}

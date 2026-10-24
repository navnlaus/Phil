package io.github.navnlaus.phil;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

// The phone as a camera for the PC (camview): while it's on (the Cams view's
// "This phone as a camera"), an RTSP server (RtspServer) with the camera behind
// it, opened only while something watches (CameraFeed), Wi-Fi and the CPU kept
// awake then. Its picture is upright the way the phone's held (its tilt, from the
// accelerometer: the screen may be off); turned for a second, or another camera
// or size chosen, the camera starts again that way and the viewers are let go,
// so their players connect again and get it (camview's do, in a few seconds). The PC is told it's there (POST /link/camera: its port and login),
// and camview lists it. A foreground service of the camera's kind: started with
// the app open (Android lets the camera be used in the background only so).
public class CameraService extends Service {
    private static final int NOTE = 3;
    private static final long CLOSE_AFTER_MS = 4000; // the last viewer gone: the camera closed after this
    static volatile CameraService running;
    static volatile java.util.function.Consumer<String> listener; // the page, told the state as it changes

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private RtspServer rtsp;
    private CameraFeed feed;
    private boolean watched;
    private String error;
    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;
    private android.view.OrientationEventListener tilt;
    private int phoneTurn = 0; // how the phone's held: 0, 90, 180, 270° clockwise from upright
    private int turnSeen = -1;
    private static final long TURN_SETTLE_MS = 1000;

    // ---------------------------------------------------------------- settings

    static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("camera", Context.MODE_PRIVATE);
    }

    static boolean wanted(Context c) {
        return prefs(c).getBoolean("on", false);
    }

    static boolean front(Context c) {
        return prefs(c).getBoolean("front", false);
    }

    static int height(Context c) {
        return prefs(c).getInt("height", 720);
    }

    // The RTSP login's password: made once (the PC's given it).
    static String password(Context c) {
        SharedPreferences p = prefs(c);
        String pw = p.getString("password", null);
        if (pw == null) {
            StringBuilder s = new StringBuilder();
            java.security.SecureRandom r = new java.security.SecureRandom();
            String chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
            for (int i = 0; i < 24; i++) s.append(chars.charAt(r.nextInt(chars.length())));
            p.edit().putString("password", pw = s.toString()).apply();
        }
        return pw;
    }

    /** {cmd: "on"|"off", front?, height?}: the page's (MainActivity). */
    static void command(Context c, JSONObject cmd) {
        SharedPreferences.Editor e = prefs(c).edit();
        if (cmd.has("front")) e.putBoolean("front", cmd.optBoolean("front"));
        if (cmd.has("height")) e.putInt("height", cmd.optInt("height") >= 1080 ? 1080 : 720);
        String what = cmd.optString("cmd");
        if (what.equals("on")) e.putBoolean("on", true);
        if (what.equals("off")) e.putBoolean("on", false);
        e.apply();
        Context app = c.getApplicationContext();
        // (The service tells the page as it starts, changes and stops: not here, which would
        // come after it, from another thread.)
        if (what.equals("off")) {
            if (running != null) running.stopSelf();
            return;
        }
        if (wanted(app)) {
            Intent i = new Intent(app, CameraService.class).putExtra("restart", cmd.has("front") || cmd.has("height"));
            if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i);
            else app.startService(i);
        } else {
            tell(app); // (only its settings: the page shows them)
        }
    }

    /**
     * What the page shows: {on, front, height, watching, error, address} (address:
     * its stream on the Wi-Fi, rtsp://phil:<password>@<its address>:47223/camera, for
     * another player).
     */
    static JSONObject state(Context c) {
        CameraService s = running;
        try {
            String address = null;
            if (s != null) {
                String here = null;
                for (String a : Net.addresses()) if (here == null || (here.startsWith("100.") && !a.startsWith("100."))) here = a; // (the Wi-Fi's before Tailscale's)
                if (here != null) address = "rtsp://" + Store.SFTP_USER + ":" + password(c) + "@" + here + ":" + RtspServer.PORT + RtspServer.PATH;
            }
            return new JSONObject().put("on", s != null).put("front", front(c)).put("height", height(c))
                .put("watching", s != null && s.rtsp != null ? s.rtsp.viewers() : 0).putOpt("error", s != null ? s.error : null).putOpt("address", address);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /** For the PC (its check-in, LinkService): the camera's port and login, or null when it's off. */
    static JSONObject announce(Context c) {
        if (running == null) return null;
        try {
            return new JSONObject().put("port", RtspServer.PORT).put("path", RtspServer.PATH).put("user", Store.SFTP_USER).put("password", password(c));
        } catch (Exception e) {
            return null;
        }
    }

    private static void tell(Context c) {
        java.util.function.Consumer<String> to = listener;
        if (to == null) return;
        try {
            to.accept(new JSONObject().put("camera", state(c)).toString());
        } catch (Exception ignored) { /* no page */ }
    }

    // ---------------------------------------------------------------- the service

    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("camera", "Camera for the PC", NotificationManager.IMPORTANCE_LOW));
        notifyNow();
        running = this;
        rtsp = new RtspServer(Store.SFTP_USER, password(this), new RtspServer.Feed() {
            @Override public void watched(boolean on) {
                main.post(() -> setWatched(on));
            }
            @Override public void keyFrame() {
                CameraFeed f = feed;
                if (f != null) f.keyFrame();
            }
        });
        rtsp.onViewers(() -> main.post(() -> {
            notifyNow();
            tell(this);
        }));
        try {
            rtsp.start();
        } catch (IOException e) {
            error = "Its port (" + RtspServer.PORT + ") is taken";
        }
        tilt = new android.view.OrientationEventListener(this) {
            @Override public void onOrientationChanged(int degrees) {
                if (degrees == ORIENTATION_UNKNOWN) return; // (flat: as it was)
                int nearest = ((degrees + 45) / 90 * 90) % 360;
                int off = Math.abs(degrees - nearest);
                if (Math.min(off, 360 - off) > 30) return; // (between two: as it was)
                if (nearest == turnSeen) return;
                turnSeen = nearest;
                main.removeCallbacks(turned);
                // (not watched: taken at once, for the next viewer; watched: once it's held so a second)
                main.postDelayed(turned, feed == null ? 0 : TURN_SETTLE_MS);
            }
        };
        if (tilt.canDetectOrientation()) tilt.enable();
        announceToPc(true);
        tell(this);
    }

    // The phone held another way (for a second): the picture turned with it.
    private final Runnable turned = () -> {
        if (turnSeen < 0 || turnSeen == phoneTurn) return;
        phoneTurn = turnSeen;
        restartPicture();
    };

    // The camera started again as it's set now (its turn, which, its size), the viewers let go to get it.
    private void restartPicture() {
        if (feed == null) return; // (not watched: the next viewer gets it)
        closeCamera();
        if (rtsp != null) rtsp.dropViewers();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!wanted(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && intent.getBooleanExtra("restart", false)) restartPicture(); // (another camera or size)
        notifyNow();
        tell(this);
        return START_STICKY;
    }

    @Override public void onDestroy() {
        running = null;
        if (tilt != null) tilt.disable();
        main.removeCallbacks(turned);
        closeCamera();
        if (rtsp != null) rtsp.stop();
        announceToPc(false);
        net.shutdown();
        tell(this);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }

    private final Runnable closeLater = this::closeCamera;

    private void setWatched(boolean on) {
        main.removeCallbacks(closeLater);
        if (!on) {
            main.postDelayed(closeLater, CLOSE_AFTER_MS);
            return;
        }
        if (feed != null) return;
        error = null;
        feed = new CameraFeed(this, new CameraFeed.Listener() {
            @Override public void config(byte[] sps, byte[] pps) {
                rtsp.config(sps, pps);
            }
            @Override public void frame(List<byte[]> nals, long ptsUs, boolean key) {
                rtsp.frame(nals, ptsUs, key);
            }
            @Override public void failed(String why) {
                main.post(() -> {
                    error = why;
                    closeCamera();
                    notifyNow();
                    tell(CameraService.this);
                });
            }
        });
        feed.start(front(this), height(this), phoneTurn);
        hold(true);
        watched = true;
        notifyNow();
        tell(this);
    }

    private void closeCamera() {
        main.removeCallbacks(closeLater);
        if (feed != null) feed.stop();
        feed = null;
        if (rtsp != null) rtsp.reset();
        hold(false);
        watched = false;
        notifyNow();
    }

    // While it's watched: the CPU and Wi-Fi kept awake (the screen may be off).
    private void hold(boolean on) {
        if (on) {
            if (wake == null) wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "phil:camera");
            if (!wake.isHeld()) wake.acquire(12 * 60 * 60 * 1000L);
            if (wifi == null) wifi = getApplicationContext().getSystemService(WifiManager.class).createWifiLock(
                Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF, "phil:camera");
            if (!wifi.isHeld()) wifi.acquire();
        } else {
            if (wake != null && wake.isHeld()) wake.release();
            if (wifi != null && wifi.isHeld()) wifi.release();
        }
    }

    // The PC told it's on (its port and login) or off: camview lists it, or not.
    private void announceToPc(boolean on) {
        Store store = new Store(this);
        if (!store.paired()) return;
        JSONObject cam = on ? announce(this) : null;
        JSONObject body = new JSONObject();
        try {
            body.put("phoneId", store.phoneId()).put("camera", cam == null ? JSONObject.NULL : cam).put("addresses", new org.json.JSONArray(Net.addresses()));
        } catch (Exception ignored) { /* never */ }
        Runnable send = () -> {
            try {
                Net.call(store, "POST", "/link/camera", body);
            } catch (IOException ignored) { /* the next check-in says it */ }
        };
        if (on) net.execute(send);
        else new Thread(send).start(); // (the executor's going)
    }

    private void notifyNow() {
        int viewers = rtsp == null ? 0 : rtsp.viewers();
        String text = error != null ? error : viewers > 0 ? "Watched on " + new Store(this).pcName() : watched ? "Starting…" : "Ready: the camera opens when " + new Store(this).pcName() + " watches";
        Intent open = new Intent(this, MainActivity.class).setAction("cams");
        Notification n = new Notification.Builder(this, "camera")
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(viewers > 0 ? "Camera on: watched" : "Camera for the PC")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
            .addAction(new Notification.Action.Builder(null, "Turn off", PendingIntent.getBroadcast(this, 7, new Intent(this, Off.class), PendingIntent.FLAG_IMMUTABLE)).build())
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        else startForeground(NOTE, n);
    }

    /** The notification's "Turn off". */
    public static class Off extends android.content.BroadcastReceiver {
        @Override public void onReceive(Context c, Intent i) {
            try {
                command(c, new JSONObject().put("cmd", "off"));
            } catch (Exception ignored) { /* never */ }
        }
    }
}

package io.github.navnlaus.phil;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

// The app updating itself from the PC: phil there has the app's latest build
// (its version in its check-in answers and /link/me: {code, name, sha256}); one
// newer than this is offered (a notification, once a version; the light phil's
// "Update" chip). Updating downloads it through the pinned link
// (/link/app.apk), checks its SHA-256, and hands it to Android's installer,
// which asks the user to confirm. Android takes it only if it's signed with
// the same key as this app (the build's own: android/build.sh).
final class Updater {
    private Updater() {}

    static final String UPDATE = "io.github.navnlaus.phil.UPDATE"; // MainActivity's intent action: update now
    private static final int NOTE = 7;
    private static volatile boolean busy;

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("update", Context.MODE_PRIVATE);
    }

    // This app's version's name (1.0.<code>).
    static String myVersionName(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    static long myVersion(Context c) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    // The PC's version of the app (null: none): kept if it's newer than this one, and told once.
    static void offered(Context c, JSONObject app) {
        SharedPreferences p = prefs(c);
        if (app == null || app.optLong("code") <= myVersion(c)) {
            if (p.contains("code")) p.edit().clear().apply();
            return;
        }
        long code = app.optLong("code");
        boolean told = p.getLong("told", 0) == code;
        p.edit().putLong("code", code).putString("name", app.optString("name")).putString("sha256", app.optString("sha256")).putLong("told", code).apply();
        if (!told) note(c, "phil " + app.optString("name") + " is ready", "On " + new Store(c).pcName() + ". Tap to update.", -1, true);
    }

    // The version waiting (its name), or null.
    static String waiting(Context c) {
        SharedPreferences p = prefs(c);
        return p.getLong("code", 0) > myVersion(c) ? p.getString("name", "") : null;
    }

    // Downloads the update and asks Android to install it. On a background thread.
    static void install(Context c) {
        Context app = c.getApplicationContext();
        if (busy || waiting(app) == null) return;
        // Installing apps is this app's to ask for, once (Settings: "Install unknown apps").
        if (Build.VERSION.SDK_INT >= 26 && !app.getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + app.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            app.startActivity(allow);
            note(app, "phil can't install it yet", "Allow \"Install unknown apps\" for phil, then tap Update again.", -1, true);
            return;
        }
        busy = true;
        new Thread(() -> {
            File apk = new File(app.getCacheDir(), "update.apk");
            try {
                Store store = new Store(app);
                String want = prefs(app).getString("sha256", "");
                HttpsURLConnection conn = Net.request(store, "GET", "/link/app.apk", null);
                long size = conn.getContentLengthLong(), got = 0, shown = 0;
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                byte[] buf = new byte[64 * 1024];
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                    for (int n; (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        sha.update(buf, 0, n);
                        got += n;
                        if (got - shown > 128 * 1024) {
                            shown = got;
                            note(app, "Downloading phil " + waiting(app), null, size > 0 ? (int) (got * 100 / size) : 0, false);
                        }
                    }
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : sha.digest()) hex.append(String.format("%02x", b));
                if (!hex.toString().equals(want)) throw new IOException("It isn't the one phil said (its SHA-256 differs)");
                PackageInstaller installer = app.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(app.getPackageName());
                int id = installer.createSession(params);
                try (PackageInstaller.Session session = installer.openSession(id)) {
                    try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("phil.apk", 0, apk.length())) {
                        Thumbs.copy(in, out);
                        session.fsync(out);
                    }
                    Intent done = new Intent(app, Done.class);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    session.commit(PendingIntent.getBroadcast(app, id, done, flags).getIntentSender());
                }
                note(app, "Installing phil " + waiting(app) + "…", null, -1, false);
            } catch (Exception e) {
                note(app, "Couldn't update phil", e.getMessage(), -1, true);
            } finally {
                apk.delete();
                busy = false;
            }
        }).start();
    }

    // What Android's installer says: the user's to confirm (its screen shown), done, or why not.
    public static class Done extends BroadcastReceiver {
        @Override public void onReceive(Context c, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return;
            }
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            if (status == PackageInstaller.STATUS_SUCCESS) nm.cancel(NOTE);
            else note(c, "Couldn't update phil", intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE), -1, true);
        }
    }

    // Its notification: tapping it updates (`tap`), `percent` while downloading.
    private static void note(Context c, String title, String text, int percent, boolean tap) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("update", "Updates", NotificationManager.IMPORTANCE_DEFAULT));
        Notification.Builder b = new Notification.Builder(c, "update").setSmallIcon(R.drawable.ic_notify).setContentTitle(title).setOnlyAlertOnce(true);
        if (text != null) b.setContentText(text);
        if (percent >= 0) b.setProgress(100, percent, false).setOngoing(true);
        else b.setAutoCancel(true);
        if (tap) {
            Intent open = new Intent(c, MainActivity.class).setAction(UPDATE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            b.setContentIntent(PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        nm.notify(NOTE, b.build());
    }
}

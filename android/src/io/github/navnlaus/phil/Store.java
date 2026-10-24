package io.github.navnlaus.phil;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;

// What the app keeps (its private preferences): the PC it's paired with (its name,
// addresses, port, certificate's fingerprint, the token it gave this phone) and the
// SFTP server's login (the PC has it too). Nothing else leaves the phone.
final class Store {
    static final int SFTP_PORT = 47222; // the phone's files, for the PC (Sftp)
    static final String SFTP_USER = "phil";

    private final SharedPreferences prefs;

    Store(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences("link", Context.MODE_PRIVATE);
    }

    boolean paired() {
        return token() != null && fingerprint() != null;
    }

    String token() { return prefs.getString("token", null); }
    String fingerprint() { return prefs.getString("fingerprint", null); } // the PC's certificate's SHA-256, hex
    String pcName() { return prefs.getString("pcName", "your PC"); }
    int pcPort() { return prefs.getInt("pcPort", 47210); }
    boolean sharing() { return prefs.getBoolean("sharing", true); } // the notification's Stop turns it off

    // The PC's addresses, the one that answered last first.
    List<String> hosts() {
        List<String> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs.getString("hosts", "[]"));
            for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        } catch (JSONException ignored) { /* none */ }
        return out;
    }

    void setHosts(List<String> hosts) {
        List<String> unique = new ArrayList<>();
        for (String h : hosts) if (h != null && !h.isEmpty() && !unique.contains(h)) unique.add(h);
        prefs.edit().putString("hosts", new JSONArray(unique).toString()).apply();
    }

    // `host` answered: first from now on.
    void answered(String host) {
        List<String> hosts = hosts();
        if (!hosts.isEmpty() && hosts.get(0).equals(host)) return;
        hosts.remove(host);
        hosts.add(0, host);
        setHosts(hosts);
    }

    void pair(String pcName, String fingerprint, int port, String token, List<String> hosts) {
        prefs.edit().putString("pcName", pcName).putString("fingerprint", fingerprint).putInt("pcPort", port)
            .putString("token", token).putBoolean("sharing", true).apply();
        setHosts(hosts);
    }

    void unpair() {
        prefs.edit().remove("token").remove("fingerprint").remove("pcName").remove("hosts").apply();
    }

    void setSharing(boolean on) {
        prefs.edit().putBoolean("sharing", on).apply();
    }

    // This phone's id, made once.
    String phoneId() {
        String id = prefs.getString("phoneId", null);
        if (id == null) prefs.edit().putString("phoneId", id = random(16)).apply();
        return id;
    }

    // The SFTP server's password, made once (the PC is given it when they pair).
    String sftpPassword() {
        String p = prefs.getString("sftpPassword", null);
        if (p == null) prefs.edit().putString("sftpPassword", p = random(32)).apply();
        return p;
    }

    static String deviceName(Context context) {
        String name = Settings.Global.getString(context.getContentResolver(), Settings.Global.DEVICE_NAME);
        return name != null && !name.isEmpty() ? name : Build.MODEL;
    }

    private static String random(int length) {
        String chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        SecureRandom r = new SecureRandom();
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < length; i++) s.append(chars.charAt(r.nextInt(chars.length())));
        return s.toString();
    }
}

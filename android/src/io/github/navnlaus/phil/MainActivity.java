package io.github.navnlaus.phil;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.util.ArrayList;
import java.util.List;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;

// The app's one window: a WebView. Paired, it shows the PC's light phil (its link
// server's /m/: the PC's files, to look at, download and add to); not yet, or
// the PC out of reach, the setup page (assets/setup.html: pairing, the
// permissions sharing needs, Stop). The setup page talks to the app through
// `Phil` (Bridge, below).
public class MainActivity extends Activity {
    private static final String SETUP = "file:///android_asset/setup.html";
    private static final int CHOOSE_FILES = 1;
    private WebView web;
    private Store store;
    private ValueCallback<Uri[]> choosing;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        store = new Store(this);
        web = new WebView(this);
        web.setBackgroundColor(0xFF1C1D21);
        FrameLayout frame = new FrameLayout(this); // (a WebView keeps no padding of its own)
        frame.setBackgroundColor(0xFF1C1D21);
        frame.addView(web);
        setContentView(frame);
        // Edge to edge (Android 15 on): the page kept clear of the status and navigation bars, and of the keyboard.
        if (Build.VERSION.SDK_INT >= 30) {
            frame.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true); // (the setup page, from the app's assets)
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new Bridge(), "Phil");
        web.setWebViewClient(new WebViewClient() {
            // The PC's certificate: trusted when it's the one paired with.
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                String fp = Net.fingerprint(error.getCertificate());
                if (fp != null && fp.equals(store.fingerprint())) handler.proceed();
                else {
                    handler.cancel();
                    view.loadUrl(SETUP + "#wrong-certificate");
                }
            }

            // Links elsewhere: the phone's browser.
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("file".equals(u.getScheme()) || store.hosts().contains(u.getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, u));
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (choosing != null) choosing.onReceiveValue(null);
                choosing = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                startActivityForResult(Intent.createChooser(pick, "Files to send"), CHOOSE_FILES);
                return true;
            }

            // The camera and microphone, for the PC's pages only (the phone as a camera).
            @Override public void onPermissionRequest(PermissionRequest request) {
                Uri origin = request.getOrigin();
                if (origin != null && store.hosts().contains(origin.getHost())) request.grant(request.getResources());
                else request.deny();
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            Intent get = new Intent(this, LinkService.class).setAction(LinkService.DOWNLOAD)
                .putExtra("url", url).putExtra("name", URLUtil.guessFileName(url, disposition, mime));
            LinkService.start(this, get);
        });
        if (store.paired() && store.sharing()) LinkService.start(this);
        show();
    }

    // The PC's light phil, when it's paired and in reach; the setup page otherwise.
    private void show() {
        if (!store.paired()) {
            web.loadUrl(SETUP);
            return;
        }
        web.loadUrl(SETUP + "#connecting");
        new Thread(() -> {
            String host = Net.reachable(store);
            if (host != null) {
                try {
                    Net.call(store, "GET", "/link/me", null); // (still paired there?)
                } catch (Net.Answer e) {
                    if (e.status == 401) { // forgotten there: pairing again
                        String pc = store.pcName();
                        store.unpair();
                        stopService(new Intent(this, LinkService.class));
                        runOnUiThread(() -> web.loadUrl(SETUP + "#forgotten:" + Uri.encode(pc)));
                        return;
                    }
                } catch (Exception ignored) { /* gone again: the page says so */ }
            }
            runOnUiThread(() -> web.loadUrl(host == null ? SETUP + "#offline"
                : "https://" + host + ":" + store.pcPort() + "/m/?token=" + Uri.encode(store.token())));
        }).start();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != CHOOSE_FILES || choosing == null) return;
        List<Uri> uris = new ArrayList<>();
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
        }
        choosing.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
        choosing = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.evaluateJavascript("window.philResumed && philResumed()", null); // (the setup page: permissions given meanwhile)
    }

    private void callback(String id, Object value) {
        String js = "window.philCallback && philCallback(" + JSONObject.quote(id) + "," + (value instanceof String ? JSONObject.quote((String) value) : String.valueOf(value)) + ")";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    private boolean allFiles() {
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    // The setup page's (and the light phil's) way to the app.
    final class Bridge {
        @JavascriptInterface public String status() {
            try {
                PowerManager pm = getSystemService(PowerManager.class);
                return new JSONObject()
                    .put("paired", store.paired())
                    .put("pc", store.pcName())
                    .put("sharing", store.sharing())
                    .put("name", Store.deviceName(MainActivity.this))
                    .put("files", allFiles())
                    .put("notifications", Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                    .put("battery", pm.isIgnoringBatteryOptimizations(getPackageName()))
                    .put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName)
                    .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        // PCs with phil on this Wi-Fi: [{name, host, port, fp}].
        @JavascriptInterface public void find(String id) {
            runOnUiThread(() -> Discovery.find(MainActivity.this, 2500, (list) -> callback(id, list)));
        }

        // A PC's name and certificate fingerprint (to compare with what it shows), before pairing.
        @JavascriptInterface public void probe(String id, String host, int port) {
            new Thread(() -> {
                try {
                    String[] seen = new String[1];
                    HttpsURLConnection c = Net.open(host.trim(), port, "/link/info", null, seen, 4000);
                    JSONObject info = Net.answer(c, c.getResponseCode());
                    callback(id, new JSONObject().put("name", info.optString("name")).put("pairing", info.optBoolean("pairing"))
                        .put("fp", seen[0]).put("short", Net.shortFingerprint(seen[0])));
                } catch (Exception e) {
                    callback(id, errorOf(e));
                }
            }).start();
        }

        // Pairs with that PC: its code, as phil shows it; the certificate seen when probing.
        @JavascriptInterface public void pair(String id, String host, int port, String fp, String code) {
            new Thread(() -> {
                try {
                    String[] hostKey = Sftp.hostKey(MainActivity.this);
                    HttpsURLConnection c = Net.open(host.trim(), port, "/link/pair", fp, null, 5000);
                    c.setRequestMethod("POST");
                    Net.send(c, new JSONObject()
                        .put("code", code.trim())
                        .put("phoneId", store.phoneId())
                        .put("name", Store.deviceName(MainActivity.this))
                        .put("model", Build.MANUFACTURER + " " + Build.MODEL)
                        .put("sftp", new JSONObject()
                            .put("port", Store.SFTP_PORT)
                            .put("user", Store.SFTP_USER)
                            .put("password", store.sftpPassword())
                            .put("hostKey", hostKey[0])
                            .put("publicKey", hostKey[1])));
                    JSONObject answer = Net.answer(c, c.getResponseCode());
                    List<String> hosts = new ArrayList<>();
                    hosts.add(host.trim());
                    JSONArray more = answer.optJSONArray("hosts");
                    if (more != null) for (int i = 0; i < more.length(); i++) hosts.add(more.getString(i));
                    store.pair(answer.optString("name", host), fp, port, answer.getString("token"), hosts);
                    LinkService.start(MainActivity.this);
                    callback(id, new JSONObject().put("ok", true));
                } catch (Exception e) {
                    callback(id, errorOf(e));
                }
            }).start();
        }

        @JavascriptInterface public void askFiles() {
            if (Build.VERSION.SDK_INT >= 30) {
                startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
            } else {
                requestPermissions(new String[] {Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE}, 2);
            }
        }

        @JavascriptInterface public void askNotifications() {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 3);
        }

        @JavascriptInterface public void askBattery() {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        }

        @JavascriptInterface public void setSharing(boolean on) {
            store.setSharing(on);
            if (on) LinkService.start(MainActivity.this);
            else stopService(new Intent(MainActivity.this, LinkService.class));
        }

        // Forgets the PC (and tells it to forget this phone, if it's in reach).
        @JavascriptInterface public void unpair() {
            new Thread(() -> {
                try {
                    Net.call(store, "POST", "/link/unpair", new JSONObject());
                } catch (Exception ignored) { /* out of reach: it learns at the next check-in */ }
                store.unpair();
                stopService(new Intent(MainActivity.this, LinkService.class));
                runOnUiThread(() -> web.loadUrl(SETUP));
            }).start();
        }

        @JavascriptInterface public void setup() {
            runOnUiThread(() -> web.loadUrl(SETUP));
        }

        @JavascriptInterface public void home() {
            runOnUiThread(MainActivity.this::show);
        }
    }

    private static JSONObject errorOf(Exception e) {
        String m = e.getMessage();
        if (e instanceof java.net.SocketTimeoutException || e instanceof java.net.ConnectException) m = "No answer there (is phil running, and its port open?)";
        try {
            return new JSONObject().put("error", m == null ? e.getClass().getSimpleName() : m);
        } catch (Exception never) {
            return new JSONObject();
        }
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

}

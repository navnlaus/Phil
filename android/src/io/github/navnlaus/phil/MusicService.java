package io.github.navnlaus.phil;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

// The app's music player: on the phone, not in the page, so music goes on with
// the app closed and the screen off (a notification, with its media session: the
// lock screen's controls, headphones' and Bluetooth buttons). Songs are the
// phone's own (by their path), the PC's (through PcProxy: the pinned link) and
// radio stations (a stream, or a .pls or .m3u playlist resolved when played).
// The queue (Next up), shuffle and repeat are here, as musicview's player.js on
// the PC; the light phil's music view is its remote (Bridge.music, Serve's
// /music/state, `listener`).
//
// An item: {kind: "phone" | "pc" | "radio", path, title, artist, album, duration
// (s), mtime, cover} or, a station, {kind: "radio", station: {id, name, url,
// image, nowPlaying}}.
public class MusicService extends Service {
    private static final int NOTE = 9;
    private static final long RADIO_NOW_MS = 20_000;
    static volatile MusicService running;
    static volatile java.util.function.Consumer<String> listener; // the page, told the state as it changes

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private List<JSONObject> queue = new ArrayList<>();
    private int at = -1;
    private boolean paused = true, shuffle, prepared, resumeOnFocus;
    private String repeat = "off";
    private JSONObject radioNow;
    private Bitmap art;
    private MediaPlayer player;
    private MediaSession session;
    private AudioManager audio;
    private AudioFocusRequest focus;
    private PcProxy proxy;
    private Thumbs thumbs;
    private Store store;
    private int loading; // (a newer one asked for: an older one's answers ignored)

    /** A command for the player ({cmd, ...}: Bridge.music's), the service started if need be. */
    static void command(Context context, String json) {
        Intent i = new Intent(context, MusicService.class).putExtra("command", json);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
        else context.startService(i);
    }

    /** What the page shows. */
    static JSONObject stateNow() {
        MusicService m = running;
        try {
            return m != null ? m.state() : new JSONObject().put("now", JSONObject.NULL).put("queue", new JSONArray()).put("at", -1).put("paused", true).put("shuffle", false).put("repeat", "off");
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        store = new Store(this);
        thumbs = new Thumbs(this);
        audio = getSystemService(AudioManager.class);
        android.content.SharedPreferences p = getSharedPreferences("music", MODE_PRIVATE);
        shuffle = p.getBoolean("shuffle", false);
        repeat = p.getString("repeat", "off");
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("music", "Music", NotificationManager.IMPORTANCE_LOW));
        session = new MediaSession(this, "phil");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { play(); }
            @Override public void onPause() { pause(); }
            @Override public void onSkipToNext() { next(false); }
            @Override public void onSkipToPrevious() { previous(); }
            @Override public void onSeekTo(long ms) { seek(ms / 1000.0); }
            @Override public void onStop() { stop(); }
        });
        session.setActive(true);
        registerReceiver(noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        main.post(this::tick);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        notifyNow(); // (foreground at once, as a started foreground service must be)
        String json = intent == null ? null : intent.getStringExtra("command");
        if (json != null) {
            try {
                handle(new JSONObject(json));
            } catch (Exception ignored) { /* not one */ }
        }
        if (queue.isEmpty()) stopSelf();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = null;
        main.removeCallbacksAndMessages(null);
        try {
            unregisterReceiver(noisy);
        } catch (Exception ignored) { /* never */ }
        if (player != null) player.release();
        if (proxy != null) proxy.close();
        if (focus != null) audio.abandonAudioFocusRequest(focus);
        session.release();
        work.shutdownNow();
        tell();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void handle(JSONObject c) throws Exception {
        switch (c.optString("cmd")) {
            case "list": {
                JSONArray items = c.getJSONArray("items");
                List<JSONObject> list = new ArrayList<>();
                for (int i = 0; i < items.length(); i++) list.add(items.getJSONObject(i));
                int i = c.optInt("at", 0);
                if (shuffle && list.size() > 1) {
                    JSONObject first = list.remove(i);
                    Collections.shuffle(list);
                    list.add(0, first);
                    i = 0;
                }
                queue = list;
                playAt(i);
                break;
            }
            case "station": queue = new ArrayList<>(Collections.singletonList(new JSONObject().put("kind", "radio").put("station", c.getJSONObject("station")))); playAt(0); break;
            case "queueNext": case "queueAdd": {
                JSONArray items = c.getJSONArray("items");
                List<JSONObject> add = new ArrayList<>();
                for (int i = 0; i < items.length(); i++) add.add(items.getJSONObject(i));
                if (at < 0) {
                    queue = add;
                    playAt(0);
                } else if (c.optString("cmd").equals("queueNext")) queue.addAll(at + 1, add);
                else queue.addAll(add);
                tell();
                break;
            }
            case "play": play(); break;
            case "pause": pause(); break;
            case "toggle": if (paused) play(); else pause(); break;
            case "next": next(false); break;
            case "previous": previous(); break;
            case "seek": seek(c.optDouble("at", 0)); break;
            case "playAt": playAt(c.optInt("i", 0)); break;
            case "remove": {
                int i = c.optInt("i", -1);
                if (i > at && i < queue.size()) queue.remove(i);
                tell();
                break;
            }
            case "clearNext": while (queue.size() > at + 1) queue.remove(queue.size() - 1); tell(); break;
            case "shuffle":
                shuffle = c.optBoolean("on");
                if (shuffle && at >= 0 && at + 1 < queue.size()) Collections.shuffle(queue.subList(at + 1, queue.size()));
                keep();
                tell();
                break;
            case "repeat": repeat = c.optString("mode", "off"); keep(); tell(); break;
            case "stop": stop(); break;
            default: break;
        }
    }

    private void keep() {
        getSharedPreferences("music", MODE_PRIVATE).edit().putBoolean("shuffle", shuffle).putString("repeat", repeat).apply();
    }

    // ---------------------------------------------------------------- playing

    private void playAt(int i) {
        if (i < 0 || i >= queue.size()) {
            stop();
            return;
        }
        at = i;
        JSONObject item = queue.get(i);
        prepared = false;
        radioNow = null;
        art = null;
        paused = false;
        int mine = ++loading;
        if (player != null) player.reset();
        else {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build());
            player.setWakeMode(this, android.os.PowerManager.PARTIAL_WAKE_LOCK);
            player.setOnPreparedListener((mp) -> {
                prepared = true;
                if (!paused && takeFocus()) mp.start();
                tell();
            });
            player.setOnCompletionListener((mp) -> next(true));
            player.setOnErrorListener((mp, what, extra) -> {
                JSONObject now = at >= 0 && at < queue.size() ? queue.get(at) : null;
                if (now != null && !"radio".equals(now.optString("kind"))) next(true); // (a song that won't play: the next)
                else {
                    paused = true;
                    tell();
                }
                return true;
            });
        }
        tell();
        work.execute(() -> {
            String source;
            try {
                source = sourceOf(item);
            } catch (Exception e) {
                main.post(() -> {
                    if (mine != loading) return;
                    paused = true;
                    tell();
                });
                return;
            }
            Bitmap cover = coverOf(item);
            main.post(() -> {
                if (mine != loading) return;
                art = cover;
                try {
                    player.setDataSource(source);
                    player.prepareAsync();
                } catch (IOException | IllegalStateException e) {
                    paused = true;
                }
                tell();
            });
            if ("radio".equals(item.optString("kind"))) radioNow(item, mine);
        });
    }

    // What MediaPlayer plays: a phone song's path, a PC song through PcProxy, a station's stream.
    private String sourceOf(JSONObject item) throws IOException {
        switch (item.optString("kind")) {
            case "pc":
                if (proxy == null) proxy = new PcProxy(store);
                return proxy.url(item.optString("path"));
            case "radio":
                JSONObject station = item.optJSONObject("station");
                if (station == null) throw new IOException("No station");
                return streamOf(station.optString("url"));
            default:
                return item.optString("path");
        }
    }

    private static String streamOf(String url) throws IOException {
        if (!url.toLowerCase().matches(".*\\.(pls|m3u)(\\?.*)?$")) return url;
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10_000);
        c.setReadTimeout(10_000);
        String text = Net.read(c.getInputStream());
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?mi)^File\\d+=(\\S+)").matcher(text);
        if (m.find()) return m.group(1);
        for (String line : text.split("\n")) if (line.trim().matches("(?i)^https?://\\S+")) return line.trim();
        throw new IOException("The playlist has no stream in it");
    }

    // What's playing on a station (its own list of songs, SomaFM's), asked again every RADIO_NOW_MS.
    private void radioNow(JSONObject item, int mine) {
        JSONObject station = item.optJSONObject("station");
        String url = station == null ? "" : station.optString("nowPlaying", "");
        if (url.isEmpty()) return;
        while (mine == loading && running != null) {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(10_000);
                c.setReadTimeout(10_000);
                JSONArray songs = new JSONObject(Net.read(c.getInputStream())).optJSONArray("songs");
                JSONObject song = songs != null && songs.length() > 0 ? songs.getJSONObject(0) : null;
                main.post(() -> {
                    if (mine != loading) return;
                    radioNow = song;
                    tell();
                });
            } catch (Exception ignored) { /* next time */ }
            try {
                Thread.sleep(RADIO_NOW_MS);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    // Its cover, for the notification and the lock screen.
    private Bitmap coverOf(JSONObject item) {
        try {
            File f;
            switch (item.optString("kind")) {
                case "phone": f = thumbs.local(new File(item.optString("path"))); break;
                case "pc": f = Serve.pcCover(thumbs, store, item.optString("path"), item.optLong("mtime")); break;
                default: f = Serve.logo(thumbs, item.optJSONObject("station") == null ? "" : item.optJSONObject("station").optString("image")); break;
            }
            return f == null ? null : BitmapFactory.decodeFile(f.getPath());
        } catch (Exception e) {
            return null;
        }
    }

    private void play() {
        if (at < 0 || player == null) return;
        paused = false;
        if (prepared && takeFocus()) player.start();
        tell();
    }

    private void pause() {
        if (at < 0 || player == null) return;
        paused = true;
        if (prepared && player.isPlaying()) player.pause();
        tell();
    }

    /** The next (a song's end: `ended`, as repeat says). */
    private void next(boolean ended) {
        if (at < 0) return;
        if (ended && "one".equals(repeat)) {
            playAt(at);
            return;
        }
        if ("radio".equals(queue.get(at).optString("kind")) && !ended) return; // (a station plays on)
        int i = at + 1;
        if (i >= queue.size()) {
            if (!"all".equals(repeat)) {
                if (ended) stop();
                return;
            }
            i = 0;
        }
        playAt(i);
    }

    private void previous() {
        if (at < 0) return;
        if (prepared && player.getCurrentPosition() > 4000 && !"radio".equals(queue.get(at).optString("kind"))) {
            seek(0);
            return;
        }
        playAt(at - 1 >= 0 ? at - 1 : "all".equals(repeat) ? queue.size() - 1 : 0);
    }

    private void seek(double seconds) {
        if (!prepared || at < 0 || "radio".equals(queue.get(at).optString("kind"))) return;
        player.seekTo((int) (Math.max(0, seconds) * 1000));
        tell();
    }

    private void stop() {
        ++loading;
        queue = new ArrayList<>();
        at = -1;
        paused = true;
        prepared = false;
        if (player != null) player.reset();
        if (focus != null) audio.abandonAudioFocusRequest(focus);
        tell();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    // ---------------------------------------------------------------- the rest of the phone

    private boolean takeFocus() {
        if (focus == null) {
            focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setOnAudioFocusChangeListener((change) -> {
                    if (change == AudioManager.AUDIOFOCUS_LOSS) pause();
                    else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
                        resumeOnFocus = !paused;
                        pause();
                    } else if (change == AudioManager.AUDIOFOCUS_GAIN && resumeOnFocus) {
                        resumeOnFocus = false;
                        play();
                    }
                }, main)
                .build();
        }
        return audio.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }

    // Headphones unplugged (a Bluetooth headset gone): paused, not out of the speaker.
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { pause(); }
    };

    // Every second while it plays: the position, for the lock screen.
    private void tick() {
        if (running == null) return;
        if (!paused && prepared) updateSession();
        main.postDelayed(this::tick, 1000);
    }

    JSONObject state() throws Exception {
        JSONObject now = at >= 0 && at < queue.size() ? queue.get(at) : null;
        JSONArray q = new JSONArray();
        for (JSONObject item : queue) q.put(item);
        boolean radio = now != null && "radio".equals(now.optString("kind"));
        return new JSONObject()
            .put("now", now == null ? JSONObject.NULL : now)
            .put("playing", radioNow == null ? JSONObject.NULL : radioNow)
            .put("queue", q).put("at", at)
            .put("paused", paused)
            .put("loading", now != null && !prepared)
            .put("position", prepared && !radio ? player.getCurrentPosition() / 1000.0 : 0)
            .put("duration", prepared && !radio && player.getDuration() > 0 ? player.getDuration() / 1000.0 : now != null ? now.optDouble("duration", 0) : 0)
            .put("shuffle", shuffle).put("repeat", repeat);
    }

    private void tell() {
        updateSession();
        notifyNow();
        java.util.function.Consumer<String> to = listener;
        if (to == null) return;
        try {
            to.accept(new JSONObject().put("music", state()).toString());
        } catch (Exception ignored) { /* no page */ }
    }

    private String[] titles() {
        JSONObject now = at >= 0 && at < queue.size() ? queue.get(at) : null;
        if (now == null) return new String[] {"phil", ""};
        if ("radio".equals(now.optString("kind"))) {
            JSONObject s = now.optJSONObject("station");
            String on = radioNow == null ? "Radio" : (radioNow.optString("artist") + " — " + radioNow.optString("title")).replaceAll("^ — | — $", "");
            return new String[] {s == null ? "Radio" : s.optString("name"), on};
        }
        String title = now.optString("title", "");
        if (title.isEmpty()) title = new File(now.optString("path")).getName().replaceAll("\\.[^.]+$", "");
        return new String[] {title, now.optString("artist", "")};
    }

    private void updateSession() {
        String[] t = titles();
        MediaMetadata.Builder m = new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, t[0]).putString(MediaMetadata.METADATA_KEY_ARTIST, t[1]);
        if (art != null) m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        boolean radio = at >= 0 && "radio".equals(queue.get(at).optString("kind"));
        if (prepared && !radio && player.getDuration() > 0) m.putLong(MediaMetadata.METADATA_KEY_DURATION, player.getDuration());
        session.setMetadata(m.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP
            | (radio ? 0 : PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO);
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
            .setState(paused ? PlaybackState.STATE_PAUSED : prepared ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_BUFFERING,
                prepared && !radio ? player.getCurrentPosition() : PlaybackState.PLAYBACK_POSITION_UNKNOWN, paused ? 0 : 1)
            .build());
    }

    // The notification: what's playing, with previous, play/pause, next (the lock screen's too).
    private void notifyNow() {
        String[] t = titles();
        Intent open = new Intent(this, MainActivity.class).setAction("music");
        Notification.Builder b = new Notification.Builder(this, "music")
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(t[0])
            .setContentText(t[1])
            .setLargeIcon(art)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
            .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2))
            .addAction(new Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(this, android.R.drawable.ic_media_previous), "Previous", action("previous")).build())
            .addAction(new Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(this, paused ? android.R.drawable.ic_media_play : android.R.drawable.ic_media_pause), paused ? "Play" : "Pause", action("toggle")).build())
            .addAction(new Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(this, android.R.drawable.ic_media_next), "Next", action("next")).build())
            .setDeleteIntent(action("stop"));
        Notification n = b.build();
        if (paused && at >= 0) {
            // Paused: the notification stays (play from it), but it can be swiped away (that stops it).
            getSystemService(NotificationManager.class).notify(NOTE, n);
            stopForeground(STOP_FOREGROUND_DETACH);
        } else if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTE, n);
    }

    private PendingIntent action(String cmd) {
        Intent i = new Intent(this, MusicService.class).putExtra("command", "{\"cmd\":\"" + cmd + "\"}");
        return PendingIntent.getService(this, cmd.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** A station's logo, or a page's picture: fetched with the phone's own trust (it's on the web), kept. */
    static void fetchWeb(String url, java.io.OutputStream out) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10_000);
        c.setReadTimeout(15_000);
        try (InputStream in = c.getInputStream()) {
            Thumbs.copy(in, out);
        }
    }
}

package io.github.navnlaus.phil;

import android.content.Context;
import android.os.Build;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.text.Collator;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// The phone's own files, for the light phil (Serve: /phone/...): folders listed
// as phil's server lists them (name, path, kind, size, mtime; folders first),
// and a folder's summary for its tile (folders.js's: how many files and
// folders, their size, and its first four pictures, or its first subfolders'
// when it has too few), from the thumbnails made here (Thumbs).
final class Local {
    private Local() {}

    // As engine/media.js has them, and audio (whose cover art is its thumbnail here).
    private static final Set<String> IMAGE = set("jpg jpeg jpe jfif png gif webp avif heic heif jxl tif tiff bmp svg ico jp2");
    private static final Set<String> VIDEO = set("mp4 m4v mkv webm mov avi wmv flv mpg mpeg m2ts mts ts 3gp ogv vob");
    private static final Set<String> AUDIO = set("mp3 m4a aac flac ogg oga opus wav wma alac aif aiff");
    private static final int PREVIEWS = 4;
    private static final Collator ORDER = Collator.getInstance();
    private static final Map<String, Object[]> summaries = new ConcurrentHashMap<>(); // folder -> {its mtime, summary}

    static {
        ORDER.setStrength(Collator.SECONDARY);
    }

    private static Set<String> set(String words) {
        return new HashSet<>(Arrays.asList(words.split(" ")));
    }

    static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
    }

    static String kind(File f) {
        if (f.isDirectory()) return "dir";
        String ext = extension(f.getName());
        if (IMAGE.contains(ext)) return "image";
        if (VIDEO.contains(ext)) return "video";
        if (AUDIO.contains(ext)) return "audio";
        if (ext.equals("pdf")) return "pdf";
        return "file";
    }

    static String mime(File f) {
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension(f.getName()));
        return m != null ? m : "application/octet-stream";
    }

    // The phone's storage (its own, and any SD card), and the usual folders in it.
    static JSONObject places(Context context) throws JSONException {
        JSONArray out = new JSONArray();
        File root = Environment.getExternalStorageDirectory();
        out.put(place("Phone", root, "phone"));
        String[][] usual = {{"Camera", "DCIM/Camera", "camera"}, {"Pictures", "Pictures", "image"}, {"Download", "Download", "download"},
            {"Documents", "Documents", "file-text"}, {"Music", "Music", "music"}, {"Movies", "Movies", "film"}};
        for (String[] u : usual) {
            File f = new File(root, u[1]);
            if (f.isDirectory()) out.put(place(u[0], f, u[2]));
        }
        if (Build.VERSION.SDK_INT >= 30) {
            for (StorageVolume v : context.getSystemService(StorageManager.class).getStorageVolumes()) {
                File dir = v.getDirectory();
                if (v.isPrimary() || dir == null || !dir.isDirectory()) continue;
                out.put(place(v.getDescription(context), dir, "drive"));
            }
        }
        return new JSONObject().put("home", root.getPath()).put("places", out);
    }

    private static JSONObject place(String name, File path, String icon) throws JSONException {
        return new JSONObject().put("name", name).put("path", path.getPath()).put("icon", icon);
    }

    static JSONObject list(File dir, boolean hidden) throws Exception {
        File[] files = dir.listFiles();
        if (files == null) throw new java.io.IOException(dir.isDirectory() ? "phil can't read it (all files access?)" : "No such folder");
        List<File> shown = new ArrayList<>();
        for (File f : files) if (hidden || !f.getName().startsWith(".")) shown.add(f);
        sort(shown);
        JSONArray entries = new JSONArray();
        for (File f : shown) {
            String kind = kind(f);
            JSONObject e = new JSONObject().put("name", f.getName()).put("path", f.getPath()).put("kind", kind)
                .put("size", f.isDirectory() ? 0 : f.length()).put("mtime", f.lastModified());
            if (kind.equals("dir")) {
                Object[] known = summaries.get(f.getPath());
                if (known != null && (long) known[0] == f.lastModified()) e.put("summary", known[1]);
            } else if (Thumbs.hasThumb(kind)) {
                e.put("thumb", "/phone/thumb?path=" + android.net.Uri.encode(f.getPath()) + "&v=" + f.lastModified());
            }
            entries.put(e);
        }
        String parent = dir.getParent();
        return new JSONObject().put("path", dir.getPath()).put("parent", parent == null ? JSONObject.NULL : parent).put("entries", entries);
    }

    // Folders first, then by name (numbers as numbers would be nice; the collator is close enough).
    private static void sort(List<File> files) {
        files.sort((a, b) -> a.isDirectory() != b.isDirectory() ? (a.isDirectory() ? -1 : 1) : ORDER.compare(a.getName(), b.getName()));
    }

    // A folder's summary (made, its thumbnails too: Thumbs).
    static JSONObject summary(Thumbs thumbs, File dir) throws Exception {
        Object[] known = summaries.get(dir.getPath());
        if (known != null && (long) known[0] == dir.lastModified()) return (JSONObject) known[1];
        File[] files = dir.listFiles();
        if (files == null) files = new File[0];
        List<File> list = new ArrayList<>();
        for (File f : files) if (!f.getName().startsWith(".")) list.add(f);
        sort(list);
        int nFiles = 0, nDirs = 0;
        long size = 0;
        for (File f : files) {
            if (f.isDirectory()) nDirs++;
            else {
                nFiles++;
                size += f.length();
            }
        }
        JSONArray previews = new JSONArray();
        int tried = 0;
        for (File f : list) {
            if (previews.length() >= PREVIEWS || tried >= 12) break;
            if (f.isDirectory() || !Thumbs.hasThumb(kind(f))) continue;
            tried++;
            if (thumbs.local(f) != null) previews.put(new JSONObject().put("url", "/phone/thumb?path=" + android.net.Uri.encode(f.getPath()) + "&v=" + f.lastModified()));
        }
        // Too few of its own (a folder of folders): its first subfolders' first pictures.
        for (File sub : list) {
            if (previews.length() >= PREVIEWS) break;
            if (!sub.isDirectory()) continue;
            File first = firstPicture(sub);
            if (first != null && thumbs.local(first) != null) {
                previews.put(new JSONObject().put("url", "/phone/thumb?path=" + android.net.Uri.encode(first.getPath()) + "&v=" + first.lastModified()));
            }
        }
        JSONObject s = new JSONObject().put("files", nFiles).put("dirs", nDirs).put("size", size).put("previews", previews).put("complete", true);
        summaries.put(dir.getPath(), new Object[] {dir.lastModified(), s});
        return s;
    }

    private static File firstPicture(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return null;
        List<File> list = new ArrayList<>(Arrays.asList(files));
        sort(list);
        int tried = 0;
        for (File f : list) {
            if (f.isDirectory() || f.getName().startsWith(".") || !Thumbs.hasThumb(kind(f))) continue;
            if (++tried > 4) break;
            return f;
        }
        return null;
    }
}

package io.github.navnlaus.phil;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.pdf.PdfRenderer;
import android.media.ExifInterface;
import android.media.MediaMetadataRetriever;
import android.media.ThumbnailUtils;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Size;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.Semaphore;

// Thumbnails, kept on the phone (its cache: Android may clear it when space runs
// low; past MAX_BYTES the oldest go): the phone's own files', made here the
// first time they're asked for (pictures, videos, PDFs' first pages, music's
// cover art), by the file's path, size and time; and the PC's, fetched from
// phil there the first time, by their name there (the same name: the same
// picture) or by the file's path, size and time.
final class Thumbs {
    static final int SIZE = 480; // the longer side, in pixels
    private static final long MAX_BYTES = 400L << 20;
    private final File mine, pcs;
    private final Semaphore making = new Semaphore(3); // at once

    interface Fetch {
        // Writes the PC's thumbnail to `out`; false if it has none.
        boolean into(OutputStream out) throws IOException;
    }

    Thumbs(Context context) {
        mine = new File(context.getCacheDir(), "thumbs");
        pcs = new File(context.getCacheDir(), "pc-thumbs");
        mine.mkdirs();
        pcs.mkdirs();
        new Thread(this::prune).start();
    }

    static boolean hasThumb(String kind) {
        return kind.equals("image") || kind.equals("video") || kind.equals("pdf") || kind.equals("audio");
    }

    // A phone file's thumbnail, made the first time; null if it can't have one.
    File local(File f) {
        String key = hash(f.getPath() + "\0" + f.length() + "\0" + f.lastModified());
        File out = new File(mine, key + ".jpg"), failed = new File(mine, key + ".fail");
        if (out.exists()) return out;
        if (failed.exists() || !f.isFile()) return null;
        making.acquireUninterruptibly();
        try {
            if (out.exists()) return out;
            Bitmap b = make(f, Local.kind(f));
            if (b == null) {
                failed.createNewFile();
                return null;
            }
            save(b, out);
            return out;
        } catch (Exception | OutOfMemoryError e) {
            try {
                failed.createNewFile();
            } catch (IOException ignored) { /* asked again next time */ }
            return null;
        } finally {
            making.release();
        }
    }

    // One of the PC's, by `name` (its name there, or made from the file's path, size and time), fetched the first time.
    File pc(String name, Fetch fetch) throws IOException {
        File out = new File(pcs, name.replaceAll("[^\\w.-]", "_"));
        if (out.exists()) {
            out.setLastModified(System.currentTimeMillis()); // (used: kept longer)
            return out;
        }
        File part = new File(pcs, out.getName() + "." + Thread.currentThread().getId() + ".part");
        boolean got;
        try (OutputStream o = new FileOutputStream(part)) {
            got = fetch.into(o);
        }
        if (!got || part.length() == 0) {
            part.delete();
            return null;
        }
        if (!part.renameTo(out)) part.delete();
        return out.exists() ? out : null;
    }

    static String pcName(String path, long size, long mtime) {
        return "p-" + hash(path + "\0" + size + "\0" + mtime) + ".jpg";
    }

    private static Bitmap make(File f, String kind) throws IOException {
        Size size = new Size(SIZE, SIZE);
        switch (kind) {
            case "image":
                return Build.VERSION.SDK_INT >= 29 ? ThumbnailUtils.createImageThumbnail(f, size, null) : decodeImage(f);
            case "video":
                return Build.VERSION.SDK_INT >= 29 ? ThumbnailUtils.createVideoThumbnail(f, size, null)
                    : ThumbnailUtils.createVideoThumbnail(f.getPath(), MediaStore.Images.Thumbnails.MINI_KIND);
            case "audio":
                return Build.VERSION.SDK_INT >= 29 ? ThumbnailUtils.createAudioThumbnail(f, size, null) : coverArt(f);
            case "pdf":
                return firstPage(f);
            default:
                return null;
        }
    }

    // (Before Android 10.) Sampled down as it's read, turned as its EXIF says.
    private static Bitmap decodeImage(File f) throws IOException {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(f.getPath(), o);
        int sample = 1;
        while (Math.max(o.outWidth, o.outHeight) / (sample * 2) >= SIZE) sample *= 2;
        o.inJustDecodeBounds = false;
        o.inSampleSize = sample;
        Bitmap b = BitmapFactory.decodeFile(f.getPath(), o);
        if (b == null) return null;
        int turn = new ExifInterface(f.getPath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        int degrees = turn == ExifInterface.ORIENTATION_ROTATE_90 ? 90 : turn == ExifInterface.ORIENTATION_ROTATE_180 ? 180 : turn == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
        if (degrees == 0) return b;
        Matrix m = new Matrix();
        m.postRotate(degrees);
        return Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
    }

    private static Bitmap coverArt(File f) throws IOException {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(f.getPath());
            byte[] art = r.getEmbeddedPicture();
            return art == null ? null : BitmapFactory.decodeByteArray(art, 0, art.length);
        } finally {
            r.release();
        }
    }

    private static Bitmap firstPage(File f) throws IOException {
        try (ParcelFileDescriptor fd = ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY); PdfRenderer pdf = new PdfRenderer(fd)) {
            if (pdf.getPageCount() == 0) return null;
            try (PdfRenderer.Page page = pdf.openPage(0)) {
                float scale = (float) SIZE / Math.max(page.getWidth(), page.getHeight());
                Bitmap b = Bitmap.createBitmap(Math.max(1, Math.round(page.getWidth() * scale)), Math.max(1, Math.round(page.getHeight() * scale)), Bitmap.Config.ARGB_8888);
                b.eraseColor(Color.WHITE);
                page.render(b, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                return b;
            }
        }
    }

    private static void save(Bitmap b, File out) throws IOException {
        float scale = (float) SIZE / Math.max(b.getWidth(), b.getHeight());
        if (scale < 1) b = Bitmap.createScaledBitmap(b, Math.round(b.getWidth() * scale), Math.round(b.getHeight() * scale), true);
        File part = new File(out.getPath() + "." + Thread.currentThread().getId() + ".part");
        try (OutputStream o = new FileOutputStream(part)) {
            b.compress(Bitmap.CompressFormat.JPEG, 82, o);
        }
        if (!part.renameTo(out)) part.delete();
    }

    // Past MAX_BYTES (both kinds together), the least recently used go.
    private void prune() {
        List<File> all = new ArrayList<>();
        for (File dir : new File[] {mine, pcs}) {
            File[] files = dir.listFiles();
            if (files != null) all.addAll(Arrays.asList(files));
        }
        long total = 0;
        for (File f : all) total += f.length();
        if (total <= MAX_BYTES) return;
        all.sort((a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File f : all) {
            if (total <= MAX_BYTES * 3 / 4) break;
            total -= f.length();
            f.delete();
        }
    }

    static String hash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes("UTF-8"));
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 16; i++) out.append(String.format("%02x", d[i]));
            return out.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
    }
}

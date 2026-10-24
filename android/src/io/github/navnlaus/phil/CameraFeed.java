package io.github.navnlaus.phil;

import android.content.Context;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

// The phone's camera as H.264 (CameraService's, for the PC: RtspServer sends it):
// Camera2 into the hardware encoder's input surface, its frames out as NAL units.
// Landscape, as the sensor is; 16:9 at the size asked for (or the nearest below it).
final class CameraFeed {
    interface Listener {
        void config(byte[] sps, byte[] pps);
        void frame(List<byte[]> nals, long ptsUs, boolean key);
        void failed(String why);
    }

    private static final int FPS = 30, KEY_EVERY_S = 2;
    private final Context context;
    private final Listener listener;
    private HandlerThread thread;
    private Handler handler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private MediaCodec encoder;
    private Surface input;
    private volatile boolean running;
    private Thread drain;

    CameraFeed(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    /** The camera facing `front` or not, at about `height` lines (720, 1080). */
    synchronized void start(boolean front, int height) {
        if (running) return;
        running = true;
        thread = new HandlerThread("camera");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(() -> open(front, height));
    }

    synchronized void stop() {
        if (!running) return;
        running = false;
        try {
            if (session != null) session.close();
        } catch (Exception ignored) { /* closed */ }
        try {
            if (camera != null) camera.close();
        } catch (Exception ignored) { /* closed */ }
        session = null;
        camera = null;
        if (drain != null) drain.interrupt();
        try {
            if (drain != null) drain.join(1000);
        } catch (InterruptedException ignored) { /* going */ }
        drain = null;
        try {
            if (encoder != null) {
                encoder.stop();
                encoder.release();
            }
        } catch (Exception ignored) { /* gone */ }
        encoder = null;
        if (input != null) input.release();
        input = null;
        if (thread != null) thread.quitSafely();
        thread = null;
    }

    /** A key frame soon (a new viewer). */
    void keyFrame() {
        MediaCodec e = encoder;
        if (e == null) return;
        Bundle b = new Bundle();
        b.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
        try {
            e.setParameters(b);
        } catch (Exception ignored) { /* stopping */ }
    }

    private void open(boolean front, int height) {
        CameraManager cm = context.getSystemService(CameraManager.class);
        try {
            String id = null;
            for (String c : cm.getCameraIdList()) {
                Integer facing = cm.getCameraCharacteristics(c).get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == (front ? CameraCharacteristics.LENS_FACING_FRONT : CameraCharacteristics.LENS_FACING_BACK)) {
                    id = c;
                    break;
                }
            }
            if (id == null && cm.getCameraIdList().length > 0) id = cm.getCameraIdList()[0];
            if (id == null) throw new IllegalStateException("This phone has no camera");
            CameraCharacteristics info = cm.getCameraCharacteristics(id);
            Size size = sizeFor(info, height);
            startEncoder(size);
            Range<Integer> fps = fpsRange(info);
            cm.openCamera(id, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice c) {
                    if (!running) {
                        c.close();
                        return;
                    }
                    camera = c;
                    capture(fps);
                }
                @Override public void onDisconnected(CameraDevice c) {
                    c.close();
                    fail("Another app took the camera");
                }
                @Override public void onError(CameraDevice c, int error) {
                    c.close();
                    fail(error == ERROR_CAMERA_IN_USE || error == ERROR_MAX_CAMERAS_IN_USE ? "The camera's in use by another app" : "The camera failed (" + error + ")");
                }
            }, handler);
        } catch (SecurityException e) {
            fail("phil isn't allowed to use the camera");
        } catch (Exception e) {
            fail(e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }

    private void fail(String why) {
        if (!running) return;
        listener.failed(why);
    }

    // 16:9 at `height` lines, else the biggest 16:9 below it, else what's closest.
    private static Size sizeFor(CameraCharacteristics info, int height) {
        StreamConfigurationMap map = info.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] sizes = map == null ? null : map.getOutputSizes(SurfaceTexture.class);
        if (sizes == null || sizes.length == 0) return new Size(height * 16 / 9, height);
        List<Size> wide = new ArrayList<>();
        for (Size s : sizes) if (s.getWidth() * 9 == s.getHeight() * 16 && s.getHeight() <= height) wide.add(s);
        if (!wide.isEmpty()) return Collections.max(wide, (a, b) -> a.getHeight() - b.getHeight());
        Size best = sizes[0];
        for (Size s : sizes) if (Math.abs(s.getHeight() - height) < Math.abs(best.getHeight() - height)) best = s;
        return best;
    }

    private static Range<Integer> fpsRange(CameraCharacteristics info) {
        Range<Integer>[] ranges = info.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        Range<Integer> best = null;
        if (ranges != null) for (Range<Integer> r : ranges) {
            if (r.getUpper() == FPS && (best == null || r.getLower() > best.getLower())) best = r; // (30, steady if it can)
        }
        return best;
    }

    private void startEncoder(Size size) throws Exception {
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, size.getWidth(), size.getHeight());
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, size.getHeight() >= 1080 ? 5_000_000 : 2_500_000);
        f.setInteger(MediaFormat.KEY_FRAME_RATE, FPS);
        f.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, KEY_EVERY_S);
        encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        encoder.configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        input = encoder.createInputSurface();
        encoder.start();
        MediaCodec e = encoder;
        drain = new Thread(() -> drain(e), "encoder");
        drain.start();
    }

    private void capture(Range<Integer> fps) {
        try {
            camera.createCaptureSession(Collections.singletonList(input), new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession s) {
                    if (!running) return;
                    session = s;
                    try {
                        CaptureRequest.Builder r = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                        r.addTarget(input);
                        if (fps != null) r.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fps);
                        s.setRepeatingRequest(r.build(), null, handler);
                    } catch (CameraAccessException | IllegalStateException e) {
                        fail("The camera stopped: " + e.getMessage());
                    }
                }
                @Override public void onConfigureFailed(CameraCaptureSession s) {
                    fail("The camera couldn't be set up");
                }
            }, handler);
        } catch (CameraAccessException | IllegalStateException e) {
            fail("The camera couldn't be set up: " + e.getMessage());
        }
    }

    // The encoder's output: its SPS and PPS first (codec config), then frames, each
    // split into its NAL units (Annex B: start codes).
    private void drain(MediaCodec e) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (running && !Thread.currentThread().isInterrupted()) {
            int i;
            try {
                i = e.dequeueOutputBuffer(info, 20_000);
            } catch (IllegalStateException ex) {
                return;
            }
            if (i < 0) continue;
            try {
                ByteBuffer buf = e.getOutputBuffer(i);
                byte[] data = new byte[info.size];
                if (buf != null) {
                    buf.position(info.offset);
                    buf.get(data, 0, info.size);
                }
                List<byte[]> nals = split(data);
                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                    byte[] sps = null, pps = null;
                    for (byte[] n : nals) {
                        if ((n[0] & 0x1f) == 7) sps = n;
                        else if ((n[0] & 0x1f) == 8) pps = n;
                    }
                    if (sps != null && pps != null) listener.config(sps, pps);
                } else if (!nals.isEmpty()) {
                    listener.frame(nals, info.presentationTimeUs, (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0);
                }
                e.releaseOutputBuffer(i, false);
            } catch (IllegalStateException ex) {
                return;
            }
        }
    }

    /** Annex B (start codes before each) into its NAL units. */
    static List<byte[]> split(byte[] b) {
        List<byte[]> out = new ArrayList<>();
        int start = -1;
        for (int i = 0; i + 2 < b.length; i++) {
            if (b[i] == 0 && b[i + 1] == 0 && (b[i + 2] == 1 || (i + 3 < b.length && b[i + 2] == 0 && b[i + 3] == 1))) {
                int codeLen = b[i + 2] == 1 ? 3 : 4;
                if (start >= 0) out.add(slice(b, start, i));
                start = i + codeLen;
                i += codeLen - 1;
            }
        }
        if (start >= 0 && start < b.length) out.add(slice(b, start, b.length));
        else if (start < 0 && b.length > 0) out.add(b); // (no start codes: one unit)
        return out;
    }

    private static byte[] slice(byte[] b, int from, int to) {
        // (trailing zeros belong to the next start code)
        while (to > from && b[to - 1] == 0) to--;
        byte[] s = new byte[to - from];
        System.arraycopy(b, from, s, 0, s.length);
        return s;
    }
}

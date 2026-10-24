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
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.Matrix;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

// The phone's camera as H.264 (CameraService's, for the PC: RtspServer sends it),
// upright the way the phone's held: the camera's frames into a GL texture, drawn
// turned (0, 90, 180 or 270°: the sensor's mounting and the phone's turn) into the
// hardware encoder's input surface, its frames out as NAL units. 16:9 at the size
// asked for (or the nearest below it); held upright, 9:16.
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
    private Surface input; // the encoder's
    private volatile boolean running;
    private Thread drain;
    // GL: the camera's texture, drawn turned onto the encoder's surface.
    private EGLDisplay egl = EGL14.EGL_NO_DISPLAY;
    private EGLContext eglContext = EGL14.EGL_NO_CONTEXT;
    private EGLSurface eglSurface = EGL14.EGL_NO_SURFACE;
    private SurfaceTexture texture;
    private Surface cameraOut;
    private int program, textureId, outWidth, outHeight, turn;
    private final float[] stMatrix = new float[16], texMatrix = new float[16], turnMatrix = new float[16];

    CameraFeed(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    /** The phone's turn now (0, 90, 180, 270: clockwise from upright), and the camera's needed then. */
    static int turnFor(CameraCharacteristics info, boolean front, int phone) {
        Integer sensor = info.get(CameraCharacteristics.SENSOR_ORIENTATION);
        int s = sensor == null ? 90 : sensor;
        return front ? (s - phone + 360) % 360 : (s + phone) % 360;
    }

    /** The camera facing `front` or not, at about `height` lines (720, 1080), with the phone turned `phone`°. */
    synchronized void start(boolean front, int height, int phone) {
        if (running) return;
        running = true;
        thread = new HandlerThread("camera");
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(() -> open(front, height, phone));
    }

    synchronized void stop() {
        if (!running) return;
        running = false;
        CountDownLatch done = new CountDownLatch(1);
        handler.post(() -> {
            try {
                if (session != null) session.close();
            } catch (Exception ignored) { /* closed */ }
            try {
                if (camera != null) camera.close();
            } catch (Exception ignored) { /* closed */ }
            session = null;
            camera = null;
            releaseGl();
            done.countDown();
        });
        try {
            done.await(3, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) { /* going */ }
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
        thread.quitSafely();
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

    private void open(boolean front, int height, int phone) {
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
            turn = turnFor(info, front, phone);
            boolean upright = turn % 180 != 0;
            outWidth = upright ? size.getHeight() : size.getWidth();
            outHeight = upright ? size.getWidth() : size.getHeight();
            startEncoder();
            startGl(size);
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

    private void startEncoder() throws Exception {
        MediaFormat f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, outWidth, outHeight);
        f.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        f.setInteger(MediaFormat.KEY_BIT_RATE, Math.min(outWidth, outHeight) >= 1080 ? 5_000_000 : 2_500_000);
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

    // ---------------------------------------------------------------- GL: the camera's frames, turned

    private static final String VERTEX = "attribute vec4 aPos; attribute vec4 aTex; uniform mat4 uTex; varying vec2 vTex;\n"
        + "void main() { gl_Position = aPos; vTex = (uTex * aTex).xy; }\n";
    private static final String FRAGMENT = "#extension GL_OES_EGL_image_external : require\n"
        + "precision mediump float; varying vec2 vTex; uniform samplerExternalOES sTex;\n"
        + "void main() { gl_FragColor = texture2D(sTex, vTex); }\n";
    private static final FloatBuffer QUAD = floats(-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1);

    private static FloatBuffer floats(float... v) {
        FloatBuffer b = ByteBuffer.allocateDirect(v.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        b.put(v).position(0);
        return b;
    }

    private void startGl(Size camera) {
        egl = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        int[] version = new int[2];
        if (!EGL14.eglInitialize(egl, version, 0, version, 1)) throw new IllegalStateException("No EGL");
        int[] attrs = {EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGLExt.EGL_RECORDABLE_ANDROID, 1, EGL14.EGL_NONE};
        EGLConfig[] configs = new EGLConfig[1];
        int[] n = new int[1];
        if (!EGL14.eglChooseConfig(egl, attrs, 0, configs, 0, 1, n, 0) || n[0] == 0) throw new IllegalStateException("No EGL config");
        eglContext = EGL14.eglCreateContext(egl, configs[0], EGL14.EGL_NO_CONTEXT, new int[] {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE}, 0);
        eglSurface = EGL14.eglCreateWindowSurface(egl, configs[0], input, new int[] {EGL14.EGL_NONE}, 0);
        EGL14.eglMakeCurrent(egl, eglSurface, eglSurface, eglContext);
        program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, shader(GLES20.GL_VERTEX_SHADER, VERTEX));
        GLES20.glAttachShader(program, shader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT));
        GLES20.glLinkProgram(program);
        int[] tex = new int[1];
        GLES20.glGenTextures(1, tex, 0);
        textureId = tex[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        // The turn, about the picture's middle (in texture space: what's drawn at a spot is what's `turn`° back from it).
        Matrix.setIdentityM(turnMatrix, 0);
        Matrix.translateM(turnMatrix, 0, 0.5f, 0.5f, 0);
        Matrix.rotateM(turnMatrix, 0, turn, 0, 0, 1);
        Matrix.translateM(turnMatrix, 0, -0.5f, -0.5f, 0);
        texture = new SurfaceTexture(textureId);
        texture.setDefaultBufferSize(camera.getWidth(), camera.getHeight());
        texture.setOnFrameAvailableListener(t -> draw(), handler);
        cameraOut = new Surface(texture);
    }

    private static int shader(int type, String code) {
        int s = GLES20.glCreateShader(type);
        GLES20.glShaderSource(s, code);
        GLES20.glCompileShader(s);
        return s;
    }

    // A camera frame: drawn, turned, into the encoder (at the camera's time).
    private void draw() {
        if (!running || texture == null) return;
        texture.updateTexImage();
        texture.getTransformMatrix(stMatrix);
        Matrix.multiplyMM(texMatrix, 0, stMatrix, 0, turnMatrix, 0);
        GLES20.glViewport(0, 0, outWidth, outHeight);
        GLES20.glUseProgram(program);
        int pos = GLES20.glGetAttribLocation(program, "aPos"), tex = GLES20.glGetAttribLocation(program, "aTex");
        QUAD.position(0);
        GLES20.glVertexAttribPointer(pos, 2, GLES20.GL_FLOAT, false, 16, QUAD);
        GLES20.glEnableVertexAttribArray(pos);
        QUAD.position(2);
        GLES20.glVertexAttribPointer(tex, 2, GLES20.GL_FLOAT, false, 16, QUAD);
        GLES20.glEnableVertexAttribArray(tex);
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(program, "uTex"), 1, false, texMatrix, 0);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        EGLExt.eglPresentationTimeANDROID(egl, eglSurface, texture.getTimestamp());
        EGL14.eglSwapBuffers(egl, eglSurface);
    }

    private void releaseGl() {
        if (texture != null) texture.release();
        texture = null;
        if (cameraOut != null) cameraOut.release();
        cameraOut = null;
        if (egl != EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(egl, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            if (eglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(egl, eglSurface);
            if (eglContext != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(egl, eglContext);
            EGL14.eglTerminate(egl);
        }
        egl = EGL14.EGL_NO_DISPLAY;
        eglContext = EGL14.EGL_NO_CONTEXT;
        eglSurface = EGL14.EGL_NO_SURFACE;
    }

    private void capture(Range<Integer> fps) {
        try {
            camera.createCaptureSession(Collections.singletonList(cameraOut), new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession s) {
                    if (!running) return;
                    session = s;
                    try {
                        CaptureRequest.Builder r = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                        r.addTarget(cameraOut);
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

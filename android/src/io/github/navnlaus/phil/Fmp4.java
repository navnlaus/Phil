package io.github.navnlaus.phil;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.List;

// H.264 frames as fragmented MP4, for a page's Media Source (the cameras' view:
// as camview's server makes it with ffmpeg, a fragment per frame, sent the
// moment it's there). The start (ftyp, moov: the codec's description, from the
// SPS and PPS), then each frame a moof and an mdat. Times are the RTP clock's
// (90 kHz). No Android in it (tried on the PC too).
final class Fmp4 {
    private static final int TIMESCALE = 90_000;
    private final OutputStream out;
    private int sequence = 1;
    private boolean started;

    Fmp4(OutputStream out) {
        this.out = out;
    }

    boolean started() {
        return started;
    }

    /** The start: what the video is (its SPS and PPS). */
    void start(byte[] sps, byte[] pps) throws IOException {
        Sps s = Sps.parse(sps);
        Box avcc = new Box("avcC").u8(1).u8(sps[1] & 0xff).u8(sps[2] & 0xff).u8(sps[3] & 0xff).u8(0xff)
            .u8(0xe1).u16(sps.length).bytes(sps).u8(1).u16(pps.length).bytes(pps);
        if (s.high) avcc.u8(0xfc | s.chroma).u8(0xf8 | s.depthLuma).u8(0xf8 | s.depthChroma).u8(0);
        Box avc1 = new Box("avc1").zeros(6).u16(1).zeros(16).u16(s.width).u16(s.height)
            .u32(0x00480000).u32(0x00480000).u32(0).u16(1).zeros(32).u16(0x18).u16(0xffff).box(avcc);
        Box stbl = new Box("stbl")
            .box(new Box("stsd").u32(0).u32(1).box(avc1))
            .box(new Box("stts").u32(0).u32(0)).box(new Box("stsc").u32(0).u32(0))
            .box(new Box("stsz").u32(0).u32(0).u32(0)).box(new Box("stco").u32(0).u32(0));
        Box minf = new Box("minf").box(new Box("vmhd").u32(1).zeros(8))
            .box(new Box("dinf").box(new Box("dref").u32(0).u32(1).box(new Box("url ").u32(1))))
            .box(stbl);
        Box mdia = new Box("mdia")
            .box(new Box("mdhd").u32(0).u32(0).u32(0).u32(TIMESCALE).u32(0).u16(0x55c4).u16(0))
            .box(new Box("hdlr").u32(0).u32(0).ascii("vide").zeros(12).ascii("phil\0"))
            .box(minf);
        Box trak = new Box("trak")
            .box(new Box("tkhd").u32(3).u32(0).u32(0).u32(1).u32(0).u32(0).zeros(8).u16(0).u16(0).u16(0).u16(0)
                .matrix().u32(s.width << 16).u32(s.height << 16))
            .box(mdia);
        Box moov = new Box("moov")
            .box(new Box("mvhd").u32(0).u32(0).u32(0).u32(1000).u32(0).u32(0x00010000).u16(0x0100).zeros(10).matrix().zeros(24).u32(2))
            .box(trak)
            .box(new Box("mvex").box(new Box("trex").u32(0).u32(1).u32(1).u32(0).u32(0).u32(0)));
        Box ftyp = new Box("ftyp").ascii("isom").u32(0x200).ascii("isom").ascii("iso6").ascii("avc1").ascii("mp41");
        ftyp.writeTo(out);
        moov.writeTo(out);
        out.flush();
        started = true;
    }

    /**
     * A frame: its NAL units (no start codes), when it's decoded (`time`, 90 kHz,
     * from the start) and how long till the next (`duration`).
     */
    void frame(List<byte[]> nals, long time, long duration, boolean key) throws IOException {
        int size = 0;
        for (byte[] n : nals) size += 4 + n.length;
        // moof: mfhd, traf (tfhd: the base is the moof; tfdt: its time; trun: the one sample, past the mdat's header)
        Box moof = moof(time, duration, size, key, 0);
        int moofSize = moof.size();
        moof = moof(time, duration, size, key, moofSize + 8);
        ByteArrayOutputStream b = new ByteArrayOutputStream(moofSize + 8 + size);
        moof.writeTo(b);
        b.write(be32(size + 8));
        b.write(new byte[] {'m', 'd', 'a', 't'});
        for (byte[] n : nals) {
            b.write(be32(n.length));
            b.write(n);
        }
        b.writeTo(out);
        out.flush();
        sequence++;
    }

    private Box moof(long time, long duration, int size, boolean key, int dataOffset) {
        Box trun = new Box("trun").u32(0x000701).u32(1).u32(dataOffset).u32((int) duration).u32(size)
            .u32(key ? 0x02000000 : 0x01010000);
        return new Box("moof").box(new Box("mfhd").u32(0).u32(sequence))
            .box(new Box("traf").box(new Box("tfhd").u32(0x020000).u32(1))
                .box(new Box("tfdt").u32(0x01000000).u64(time)).box(trun));
    }

    private static byte[] be32(int v) {
        return new byte[] {(byte) (v >>> 24), (byte) (v >>> 16), (byte) (v >>> 8), (byte) v};
    }

    // An MP4 box, built up: its contents, then other boxes in it.
    private static final class Box {
        private final ByteArrayOutputStream body = new ByteArrayOutputStream();
        private final String type;

        Box(String type) {
            this.type = type;
        }

        Box u8(int v) {
            body.write(v);
            return this;
        }

        Box u16(int v) {
            return u8(v >>> 8).u8(v & 0xff);
        }

        Box u32(int v) {
            body.write(be32(v), 0, 4);
            return this;
        }

        Box u64(long v) {
            return u32((int) (v >>> 32)).u32((int) v);
        }

        Box zeros(int n) {
            for (int i = 0; i < n; i++) body.write(0);
            return this;
        }

        Box bytes(byte[] b) {
            body.write(b, 0, b.length);
            return this;
        }

        Box ascii(String s) {
            for (char c : s.toCharArray()) body.write(c);
            return this;
        }

        Box matrix() {
            return u32(0x00010000).u32(0).u32(0).u32(0).u32(0x00010000).u32(0).u32(0).u32(0).u32(0x40000000);
        }

        Box box(Box child) {
            byte[] b = child.toBytes();
            body.write(b, 0, b.length);
            return this;
        }

        int size() {
            return body.size() + 8;
        }

        byte[] toBytes() {
            byte[] b = body.toByteArray();
            byte[] all = new byte[b.length + 8];
            System.arraycopy(be32(all.length), 0, all, 0, 4);
            for (int i = 0; i < 4; i++) all[4 + i] = (byte) type.charAt(i);
            System.arraycopy(b, 0, all, 8, b.length);
            return all;
        }

        void writeTo(OutputStream o) throws IOException {
            o.write(toBytes());
        }
    }

    // What an SPS says the picture is: its size (cropped), and for the High
    // profiles the chroma format and bit depths (avcC has them too).
    static final class Sps {
        int width, height, chroma = 1, depthLuma, depthChroma;
        boolean high;

        static Sps parse(byte[] nal) {
            Bits b = new Bits(unescape(nal));
            Sps s = new Sps();
            b.skip(8); // (the NAL header)
            int profile = b.u(8);
            b.skip(16); // constraints, level
            b.ue(); // its id
            if (profile == 100 || profile == 110 || profile == 122 || profile == 244 || profile == 44 || profile == 83 || profile == 86
                || profile == 118 || profile == 128 || profile == 138 || profile == 139 || profile == 134 || profile == 135) {
                s.high = true;
                s.chroma = b.ue();
                if (s.chroma == 3) b.skip(1);
                s.depthLuma = b.ue();
                s.depthChroma = b.ue();
                b.skip(1);
                if (b.u(1) == 1) {
                    for (int i = 0; i < (s.chroma != 3 ? 8 : 12); i++) {
                        if (b.u(1) == 1) {
                            int last = 8, next = 8;
                            for (int j = 0; j < (i < 6 ? 16 : 64); j++) {
                                if (next != 0) next = (last + b.se() + 256) % 256;
                                last = next == 0 ? last : next;
                            }
                        }
                    }
                }
            }
            b.ue(); // log2_max_frame_num_minus4
            int pocType = b.ue();
            if (pocType == 0) b.ue();
            else if (pocType == 1) {
                b.skip(1);
                b.se();
                b.se();
                for (int i = b.ue(); i > 0; i--) b.se();
            }
            b.ue(); // max_num_ref_frames
            b.skip(1);
            int mbsWide = b.ue() + 1, mapsHigh = b.ue() + 1;
            int frameMbsOnly = b.u(1);
            if (frameMbsOnly == 0) b.skip(1);
            b.skip(1);
            int left = 0, right = 0, top = 0, bottom = 0;
            if (b.u(1) == 1) {
                left = b.ue();
                right = b.ue();
                top = b.ue();
                bottom = b.ue();
            }
            int unitX = s.chroma == 0 || s.chroma == 3 ? 1 : 2;
            int unitY = (s.chroma == 1 ? 2 : 1) * (2 - frameMbsOnly);
            s.width = mbsWide * 16 - unitX * (left + right);
            s.height = (2 - frameMbsOnly) * mapsHigh * 16 - unitY * (top + bottom);
            return s;
        }

        // The emulation-prevention bytes (00 00 03) taken out.
        private static byte[] unescape(byte[] in) {
            ByteArrayOutputStream o = new ByteArrayOutputStream(in.length);
            int zeros = 0;
            for (byte x : in) {
                if (zeros >= 2 && x == 3) {
                    zeros = 0;
                    continue;
                }
                o.write(x);
                zeros = x == 0 ? zeros + 1 : 0;
            }
            return o.toByteArray();
        }
    }

    private static final class Bits {
        private final byte[] b;
        private int at;

        Bits(byte[] b) {
            this.b = b;
        }

        int u(int n) {
            int v = 0;
            for (int i = 0; i < n; i++, at++) {
                int bit = at / 8 < b.length ? (b[at / 8] >> (7 - at % 8)) & 1 : 0;
                v = (v << 1) | bit;
            }
            return v;
        }

        void skip(int n) {
            at += n;
        }

        int ue() {
            int zeros = 0;
            while (u(1) == 0 && zeros < 32) zeros++;
            return (int) ((1L << zeros) - 1 + (zeros == 0 ? 0 : u(zeros)));
        }

        int se() {
            int k = ue();
            return (k & 1) == 1 ? (k + 1) / 2 : -(k / 2);
        }
    }
}

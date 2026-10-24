package io.github.navnlaus.phil;

import android.content.Context;
import android.media.MediaScannerConnection;
import android.os.Environment;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.MessageDigest;
import java.nio.file.CopyOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Collection;
import java.util.Collections;
import org.apache.sshd.common.config.keys.KeyUtils;
import org.apache.sshd.common.config.keys.PublicKeyEntry;
import org.apache.sshd.common.file.virtualfs.VirtualFileSystemFactory;
import org.apache.sshd.common.util.OsUtils;
import org.apache.sshd.common.util.io.PathUtils;
import org.apache.sshd.server.SshServer;
import org.apache.sshd.server.session.ServerSession;
import org.apache.sshd.server.keyprovider.SimpleGeneratorHostKeyProvider;
import org.apache.sshd.sftp.server.FileHandle;
import org.apache.sshd.sftp.server.Handle;
import org.apache.sshd.sftp.server.SftpEventListener;
import org.apache.sshd.sftp.server.SftpSubsystemFactory;
import org.apache.sshd.sftp.server.UnsupportedAttributePolicy;

// The phone's files for the PC: an SFTP server (Apache MINA SSHD) on
// Store.SFTP_PORT, its root the phone's shared storage (what the Files app shows
// as the phone: /storage/emulated/0). One login, the PC's (Store: made here, given to
// the PC when they pair); SFTP only, no shell, no forwarding. phil mounts it with
// gvfs (gio mount sftp://...), with the host key it was given when pairing put in
// ssh's known_hosts first: ssh takes that key from it, and no other.
final class Sftp {
    private SshServer server;

    static {
        OsUtils.setAndroid(Boolean.TRUE);
    }

    private static SimpleGeneratorHostKeyProvider hostKeys(Context context) {
        SimpleGeneratorHostKeyProvider keys = new SimpleGeneratorHostKeyProvider(new File(context.getFilesDir(), "hostkey.ser").toPath());
        keys.setAlgorithm(KeyUtils.EC_ALGORITHM); // (no Ed25519 without another library)
        keys.setKeySize(256);
        return keys;
    }

    // The host key, made the first time: its fingerprint as OpenSSH shows it
    // (SHA256:...), and its public key as known_hosts has it ("ecdsa-sha2-nistp256 AAAA...").
    static String[] hostKey(Context context) throws IOException {
        try {
            KeyPair key = hostKeys(context).loadKeys(null).get(0);
            return new String[] {KeyUtils.getFingerPrint(key.getPublic()), PublicKeyEntry.toString(key.getPublic())};
        } catch (Exception e) {
            throw new IOException("No host key: " + e.getMessage(), e);
        }
    }

    static File root() {
        return Environment.getExternalStorageDirectory();
    }

    synchronized void start(Context context, String password) throws IOException {
        if (server != null && server.isStarted()) return;
        File home = context.getFilesDir();
        System.setProperty("user.home", home.getAbsolutePath());
        PathUtils.setUserHomeFolderResolver(home::toPath);
        byte[] secret = password.getBytes(StandardCharsets.UTF_8);
        SshServer s = SshServer.setUpDefaultServer();
        s.setPort(Store.SFTP_PORT);
        s.setKeyPairProvider(hostKeys(context));
        s.setPasswordAuthenticator((user, given, session) ->
            Store.SFTP_USER.equals(user) && MessageDigest.isEqual(secret, given.getBytes(StandardCharsets.UTF_8)));
        s.setPublickeyAuthenticator((user, key, session) -> false);
        SftpSubsystemFactory sftp = new SftpSubsystemFactory();
        sftp.setUnsupportedAttributePolicy(UnsupportedAttributePolicy.Ignore); // (shared storage keeps no owners or modes)
        // What the PC writes, moves or deletes: told to Android's media index (MediaStore),
        // which doesn't see it by itself (Gallery, the Files app's lists, other apps' pickers).
        Context app = context.getApplicationContext();
        sftp.addSftpEventListener(new SftpEventListener() {
            @Override public void closed(ServerSession session, String id, Handle handle, Throwable thrown) {
                if (handle instanceof FileHandle && ((FileHandle) handle).getOpenOptions().contains(StandardOpenOption.WRITE)) scan(app, handle.getFile());
            }
            @Override public void removed(ServerSession session, Path path, boolean isDirectory, Throwable thrown) {
                if (thrown == null) scan(app, path);
            }
            @Override public void moved(ServerSession session, Path from, Path to, Collection<CopyOption> options, Throwable thrown) {
                if (thrown == null) {
                    scan(app, from);
                    scan(app, to);
                }
            }
        });
        s.setSubsystemFactories(Collections.singletonList(sftp));
        s.setFileSystemFactory(new VirtualFileSystemFactory(root().toPath()));
        s.start();
        server = s;
    }

    // A path as the PC sees it (under the shared storage, its root), told to the media index.
    private static void scan(Context context, Path path) {
        String inside = path.toString().replaceFirst("^/+", "");
        MediaScannerConnection.scanFile(context, new String[] {new File(root(), inside).getPath()}, null, null);
    }

    synchronized void stop() {
        if (server == null) return;
        try {
            server.stop(true);
        } catch (IOException ignored) { /* stopping anyway */ }
        server = null;
    }

    synchronized boolean running() {
        return server != null && server.isStarted();
    }
}

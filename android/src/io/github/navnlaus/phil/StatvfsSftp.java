package io.github.navnlaus.phil;

import android.os.StatFs;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.apache.sshd.common.util.buffer.Buffer;
import org.apache.sshd.server.channel.ChannelSession;
import org.apache.sshd.server.command.Command;
import org.apache.sshd.server.session.ServerSession;
import org.apache.sshd.sftp.common.SftpConstants;
import org.apache.sshd.sftp.common.extensions.openssh.AbstractOpenSSHExtensionParser.OpenSSHExtension;
import org.apache.sshd.sftp.server.SftpSubsystem;
import org.apache.sshd.sftp.server.SftpSubsystemConfigurator;
import org.apache.sshd.sftp.server.SftpSubsystemFactory;

// SSHD's SFTP, with OpenSSH's statvfs@openssh.com (and fstatvfs): how big the
// phone's storage is and how much is free, which SSHD doesn't answer by itself.
// gvfs asks it for the mount's free space (df, phil's "this needs more room"
// before a copy); without it the mount says 0 bytes of 0.
final class StatvfsSftp extends SftpSubsystem {
    private static final String STATVFS = "statvfs@openssh.com", FSTATVFS = "fstatvfs@openssh.com";

    StatvfsSftp(ChannelSession channel, SftpSubsystemConfigurator configurator) {
        super(channel, configurator);
    }

    // The factory that makes these, with the event listeners added to it (as SSHD's own does).
    static SftpSubsystemFactory factory() {
        return new SftpSubsystemFactory() {
            @Override public Command createSubsystem(ChannelSession channel) throws IOException {
                StatvfsSftp sftp = new StatvfsSftp(channel, this);
                getRegisteredListeners().forEach(sftp::addSftpEventListener);
                return sftp;
            }
        };
    }

    @Override protected List<OpenSSHExtension> resolveOpenSSHExtensions(ServerSession session) {
        List<OpenSSHExtension> list = new ArrayList<>(super.resolveOpenSSHExtensions(session));
        list.add(new OpenSSHExtension(STATVFS, "2"));
        list.add(new OpenSSHExtension(FSTATVFS, "2"));
        return list;
    }

    @Override protected void executeExtendedCommand(Buffer buffer, int id, String extension) throws IOException {
        if (!STATVFS.equals(extension) && !FSTATVFS.equals(extension)) {
            super.executeExtendedCommand(buffer, id, extension);
            return;
        }
        buffer.getString(); // the path (or handle): everything served is on the one storage
        StatFs fs = new StatFs(Sftp.root().getPath());
        long block = fs.getBlockSizeLong();
        Buffer reply = prepareReply(buffer);
        reply.putByte((byte) SftpConstants.SSH_FXP_EXTENDED_REPLY);
        reply.putInt(id);
        reply.putLong(block); // f_bsize
        reply.putLong(block); // f_frsize
        reply.putLong(fs.getBlockCountLong()); // f_blocks
        reply.putLong(fs.getFreeBlocksLong()); // f_bfree
        reply.putLong(fs.getAvailableBlocksLong()); // f_bavail
        reply.putLong(0); // f_files, f_ffree, f_favail: not known
        reply.putLong(0);
        reply.putLong(0);
        reply.putLong(0); // f_fsid
        reply.putLong(0); // f_flag
        reply.putLong(255); // f_namemax
        send(reply);
    }
}

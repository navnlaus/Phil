package io.github.navnlaus.phil;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;
import java.util.ArrayList;

// Share → "Send to PC": what's shared goes to the PC (into its Downloads), by
// LinkService, in a notification. No window of its own.
public class ShareActivity extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Store store = new Store(this);
        Intent in = getIntent();
        if (!store.paired()) {
            Toast.makeText(this, "Pair phil with your PC first", Toast.LENGTH_LONG).show();
            startActivity(new Intent(this, MainActivity.class));
            finish();
            return;
        }
        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(in.getAction())) {
            ArrayList<Uri> list = in.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else {
            Uri one = in.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) uris.add(one);
        }
        String text = in.getStringExtra(Intent.EXTRA_TEXT);
        if (uris.isEmpty() && (text == null || text.isEmpty())) {
            finish();
            return;
        }
        // The files' read permission goes with them to the service (its intent's ClipData).
        Intent send = new Intent(this, LinkService.class).setAction(LinkService.SHARE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (!uris.isEmpty()) {
            ClipData clip = ClipData.newRawUri("files", uris.get(0));
            for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
            send.setClipData(clip);
        } else {
            send.putExtra(Intent.EXTRA_TEXT, text);
        }
        LinkService.start(this, send);
        Toast.makeText(this, "Sending to " + store.pcName() + "…", Toast.LENGTH_SHORT).show();
        finish();
    }
}

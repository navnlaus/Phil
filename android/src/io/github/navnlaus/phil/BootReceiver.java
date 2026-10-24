package io.github.navnlaus.phil;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// The phone started (or the app was updated): sharing again, if it was on.
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Store store = new Store(context);
        if (store.paired() && store.sharing()) LinkService.start(context);
    }
}

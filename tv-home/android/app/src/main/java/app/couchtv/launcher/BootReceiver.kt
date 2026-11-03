package app.couchtv.launcher

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the screen guard after the TV boots and after this app is updated. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ScreenGuard.start(context)
    }
}

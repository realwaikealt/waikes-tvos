package app.couchtv.launcher

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings

/**
 * The Netflix / Prime Video / YouTube / Apple TV buttons on the TCL remote.
 *
 * Why they were dead: TCL's window manager answers those keys by sending an explicit broadcast
 * (com.google.global_button.ACTION_LAUNCH_APP) to Google's launcher (launcherx, receiver
 * GlobalButtonLaunch_Receiver), which opens the app. We keep launcherx switched off, so the broadcast
 * has no receiver and nothing opens. [RemoteKeyService] sees the four keys first and opens the app
 * itself, the same way launcherx would have.
 */
object RemoteAppKeys {
    // Android keycodes TCL gives the four buttons (what com.tcl.ttvs logs as keyCode, see PROJECT.md)
    const val K_NETFLIX = 4062
    const val K_PRIME = 4099
    const val K_YOUTUBE = 4065
    const val K_APPLETV = 4160

    const val NETFLIX = "com.netflix.ninja"
    const val PRIME = "com.amazon.amazonvideo.livingroom"
    const val YOUTUBE = "com.google.android.youtube.tv"
    const val APPLETV = "com.apple.atve.androidtv.appletv"

    fun packageFor(keyCode: Int): String? = when (keyCode) {
        K_NETFLIX -> NETFLIX
        K_PRIME -> PRIME
        K_YOUTUBE -> YOUTUBE
        K_APPLETV -> APPLETV
        else -> null
    }

    /** The intent TCL's own code uses for each app (so the app opens where the remote button should take you). */
    private fun intentFor(c: Context, pkg: String): Intent? {
        val pm = c.packageManager
        val base = when (pkg) {
            NETFLIX -> Intent("com.netflix.action.NETFLIX_KEY_START").setPackage(pkg).putExtra("power_on", false)
            PRIME -> Intent("com.amazon.amazonvideo.livingroom.AMAZON_BUTTON").setPackage(pkg)
            else -> null
        }
        // Prime's button action has no DEFAULT category, so startActivity cannot resolve it by action: target the activity by name.
        base?.let { b -> pm.resolveActivity(b, 0)?.activityInfo?.let { b.setClassName(it.packageName, it.name) } }
        val intent = base?.takeIf { it.component != null }
            ?: pm.getLeanbackLaunchIntentForPackage(pkg)
            ?: pm.getLaunchIntentForPackage(pkg)
            ?: return null
        if (pkg == YOUTUBE) intent.putExtra("yt_remote_button", true)
        return intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    }

    fun launch(c: Context, pkg: String) {
        try {
            val intent = intentFor(c, pkg)
            if (intent == null) { ScreenGuard.record(c, "remote app key", "no launch intent for $pkg"); return }
            c.startActivity(intent)
            ScreenGuard.record(c, "remote app key", "opened $pkg")
        } catch (e: Exception) {
            ScreenGuard.record(c, "remote app key FAILED", "$pkg $e")
        }
    }

    /**
     * Turns the key service on. Needs WRITE_SECURE_SETTINGS, granted once over ADB
     * (pm grant app.couchtv.launcher android.permission.WRITE_SECURE_SETTINGS); without it this does nothing,
     * and the same setting can be written from ADB (see PROJECT.md). Safe to call often.
     */
    fun ensureEnabled(c: Context) {
        try {
            val me = ComponentName(c, RemoteKeyService::class.java).flattenToString()
            val cr = c.contentResolver
            val cur = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
            val listed = cur.split(':').contains(me)
            val on = Settings.Secure.getInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1
            if (listed && on) return
            if (listed) {
                // Listed but Android's master switch is off (this is what left the buttons dead): just switch it on.
                Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
                ScreenGuard.record(c, "remote app keys", "accessibility master switch was off, switched on")
                return
            }
            val next = if (cur.isBlank()) me else "$cur:$me"
            Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, next)
            Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
            ScreenGuard.record(c, "remote app keys", "key service switched on")
        } catch (e: Exception) {
            ScreenGuard.record(c, "remote app keys", "could not switch on the key service: $e")
        }
    }
}

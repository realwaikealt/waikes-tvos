package app.couchtv.launcher

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import org.json.JSONObject

/**
 * Starts the screensaver after a quiet spell even while another app is open (the page only sees idle time while Home is showing).
 * [RemoteKeyService] calls [touch] on every remote key; ScreenGuard (always alive) calls [start] once. Every 30 s: if the screen
 * is on, the minutes in Settings > Screensaver have passed with no key, and nothing is playing sound (so it never covers a
 * movie), Home is brought forward and shows the saver. Once per quiet spell; any key re-arms it.
 */
object IdleSaver {
    private val main = Handler(Looper.getMainLooper())
    private var started = false
    @Volatile private var last = SystemClock.elapsedRealtime()
    @Volatile private var fired = false

    fun touch() { last = SystemClock.elapsedRealtime(); fired = false }

    private fun minutes(c: Context): Int = try {
        val raw = c.getSharedPreferences("page", Context.MODE_PRIVATE).getString("tvhome.settings", null)
        val s = if (raw == null) null else JSONObject(raw)
        if (s != null && s.has("saver")) s.optInt("saver", 10) else 10
    } catch (e: Exception) { 10 }

    private fun featureOn(c: Context): Boolean =
        c.getSharedPreferences("page", Context.MODE_PRIVATE).getString("tvhome.saver_on", "1") != "0"

    fun start(c: Context) {
        if (started) return
        started = true
        val app = c.applicationContext
        val tick = object : Runnable {
            override fun run() {
                try { check(app) } catch (e: Exception) { /* try again next time */ }
                main.postDelayed(this, 30_000)
            }
        }
        main.postDelayed(tick, 30_000)
    }

    private fun check(c: Context) {
        if (fired) return
        val m = minutes(c)
        if (m <= 0 || !featureOn(c)) return
        val pm = c.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) return
        if ((c.getSystemService(Context.AUDIO_SERVICE) as AudioManager).isMusicActive) { last = SystemClock.elapsedRealtime(); return }
        if (SystemClock.elapsedRealtime() - last < m * 60_000L) return
        fired = true
        ScreenGuard.record(c, "screensaver", "idle ${m} min over ${ScreenGuard.topPackage(c)}")
        c.startActivity(Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("screensaver", true))
    }
}

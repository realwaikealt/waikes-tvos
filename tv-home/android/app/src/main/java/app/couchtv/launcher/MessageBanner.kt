package app.couchtv.launcher

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * A small notice over whatever app is open when a new TV message arrives (the same messages as the Home popup).
 * It does not ask for OK and never takes the remote's keys: it shows for about 9 seconds and goes away. The message stays
 * unread, so the full popup still appears when you are back on Home. Needs "draw over other apps" (granted over ADB);
 * without it, nothing happens. Switched off by Settings > Features > TV messages.
 * Run by ScreenGuard, which is already alive in the background: it calls [start] once.
 */
object MessageBanner {
    private const val EVERY_MS = 12_000L
    private const val SHOW_MS = 9_000L
    private val main = Handler(Looper.getMainLooper())
    private var started = false
    private var view: LinearLayout? = null
    private var lastSeen: String? = null   // newest message id already announced (or present when the service started)
    private var primed = false

    fun start(c: Context) {
        if (started) return
        started = true
        val app = c.applicationContext
        Thread({
            while (true) {
                try { poll(app) } catch (_: Exception) {}
                try { Thread.sleep(EVERY_MS) } catch (_: InterruptedException) { return@Thread }
            }
        }, "tvos-banner").apply { isDaemon = true }.start()
    }

    private fun bridge(c: Context): String? {
        val saved = c.getSharedPreferences("home", Context.MODE_PRIVATE).getString("bridge", null)
        return (saved ?: BuildConfig.BRIDGES.firstOrNull())?.trimEnd('/')
    }

    private fun get(url: String): JSONObject? = try {
        val x = URL(url).openConnection() as HttpURLConnection
        x.connectTimeout = 3000; x.readTimeout = 3000
        try { JSONObject(x.inputStream.bufferedReader().readText()) } finally { x.disconnect() }
    } catch (_: Exception) { null }

    private fun poll(c: Context) {
        val base = bridge(c) ?: return
        val inbox = get("$base/api/inbox") ?: return
        val msgs = inbox.optJSONArray("messages") ?: return
        val newest = if (msgs.length() > 0) msgs.getJSONObject(0) else null
        if (!primed) { primed = true; lastSeen = newest?.optString("id"); return }   // do not announce old mail at start
        if (newest == null || newest.optBoolean("read", false)) return
        val id = newest.optString("id")
        if (id == lastSeen) return
        val pm = c.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) return                                   // the screen is off: nobody is watching
        if (!Settings.canDrawOverlays(c)) return
        val f = get("$base/api/features")?.optJSONArray("features")
        if (f != null) for (i in 0 until f.length()) { val o = f.getJSONObject(i); if (o.optString("id") == "messages" && !o.optBoolean("on", true)) { lastSeen = id; return } }
        // On Home the page shows the full popup itself.
        if (ScreenGuard.topPackage(c) == c.packageName) { lastSeen = id; return }
        lastSeen = id
        val title = newest.optString("title", "Update")
        val summary = newest.optString("summary", "")
        main.post { show(c, title, summary) }
    }

    private fun show(c: Context, title: String, summary: String) {
        hide(c)
        val wm = c.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val d = c.resources.displayMetrics.density
        val box = LinearLayout(c).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((28 * d).toInt(), (18 * d).toInt(), (28 * d).toInt(), (18 * d).toInt())
            background = GradientDrawable().apply { setColor(Color.parseColor("#F0221820")); cornerRadius = 22 * d; setStroke((1 * d).toInt(), Color.parseColor("#33FFFFFF")) }
        }
        box.addView(TextView(c).apply { text = "Asher’s tvOS"; setTextColor(Color.parseColor("#99FFFFFF")); textSize = 12f; letterSpacing = 0.08f })
        box.addView(TextView(c).apply { text = title; setTextColor(Color.WHITE); textSize = 20f; typeface = Typeface.DEFAULT_BOLD })
        if (summary.isNotBlank()) box.addView(TextView(c).apply {
            text = if (summary.length > 160) summary.take(157) + "…" else summary
            setTextColor(Color.parseColor("#DDFFFFFF")); textSize = 15f; maxLines = 3
        })
        val lp = WindowManager.LayoutParams(
            (620 * d).toInt(), WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL; y = (36 * d).toInt() }
        try { wm.addView(box, lp); view = box } catch (_: Exception) { return }
        main.postDelayed({ hide(c) }, SHOW_MS)
    }

    private fun hide(c: Context) {
        val v = view ?: return
        view = null
        try { (c.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v) } catch (_: Exception) {}
    }
}

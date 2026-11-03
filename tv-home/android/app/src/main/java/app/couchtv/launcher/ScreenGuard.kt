package app.couchtv.launcher

import android.app.AppOpsManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Keeps the TV from waking itself into the last app.
 *
 * When the TV is turned off, whatever app was open stays the top task. If the system later kills
 * that app (low memory), Android relaunches it, and an app that asks for the screen to turn on
 * (Prime Video does) wakes the TV. So when the screen goes off we bring our own Home to the front:
 * a relaunch of Home never turns the screen on.
 *
 * Also keeps a small log of screen on/off events and the app in front, for the Debug page.
 */
class ScreenGuard : Service() {

    private val main = Handler(Looper.getMainLooper())
    private var receiver: BroadcastReceiver? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        goForeground()
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                when (i.action) {
                    Intent.ACTION_SCREEN_OFF -> {
                        record(c, "screen off", topPackage(c))
                        // a moment later, so the system has finished pausing the app that was open
                        main.postDelayed({ goHome(c, "after screen off") }, 700)
                        main.postDelayed({ goHome(c, "after screen off (again)") }, 4000)
                    }
                    Intent.ACTION_SCREEN_ON -> {
                        record(c, "screen on", topPackage(c))
                        main.postDelayed({ record(c, "screen on +3s", topPackage(c)) }, 3000)
                    }
                }
            }
        }
        receiver = r
        registerReceiver(r, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        })
        record(this, "guard started", topPackage(this))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        receiver?.let { try { unregisterReceiver(it) } catch (_: Exception) {} }
        record(this, "guard stopped", "")
        super.onDestroy()
    }

    private fun goForeground() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Screen guard", NotificationManager.IMPORTANCE_MIN))
        val n = Notification.Builder(this, CHANNEL)
            .setContentTitle("Asher’s tvOS")
            .setContentText("Keeps the TV from waking itself")
            .setSmallIcon(R.drawable.icon)
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, n)
    }

    companion object {
        private const val TAG = "TvosScreen"
        private const val CHANNEL = "screenguard"
        private const val PREFS = "screenlog"
        private const val KEEP = 60

        fun start(c: Context) {
            try { c.startForegroundService(Intent(c, ScreenGuard::class.java)) }
            catch (e: Exception) { Log.w(TAG, "could not start the guard: $e") }
        }

        /** Home to the front, as the system does on the Home key. Allowed from the background because
         *  the app holds "draw over other apps" (granted once over ADB, see the README). */
        fun goHome(c: Context, why: String) {
            try {
                c.startActivity(Intent(c, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra("guard", why))
                record(c, "home to front", why)
            } catch (e: Exception) {
                record(c, "home to front FAILED", e.toString())
            }
        }

        /** The app last moved to the front, if "usage access" has been granted; else "?". */
        fun topPackage(c: Context): String = try {
            val ops = c.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            if (ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.packageName) != AppOpsManager.MODE_ALLOWED) "?"
            else {
                val us = c.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
                val now = System.currentTimeMillis()
                val ev = us.queryEvents(now - 6 * 60 * 60 * 1000, now)
                val e = UsageEvents.Event()
                var pkg = "?"
                while (ev.hasNextEvent()) {
                    ev.getNextEvent(e)
                    if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED) pkg = e.packageName
                }
                pkg
            }
        } catch (_: Exception) { "?" }

        @Synchronized
        fun record(c: Context, what: String, detail: String) {
            Log.i(TAG, "$what $detail")
            try {
                val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val a = JSONArray(p.getString("log", "[]"))
                a.put(JSONObject().put("t", System.currentTimeMillis()).put("e", what).put("d", detail))
                val out = JSONArray()
                for (i in maxOf(0, a.length() - KEEP) until a.length()) out.put(a.get(i))
                p.edit().putString("log", out.toString()).apply()
            } catch (_: Exception) {}
        }

        fun log(c: Context): String = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("log", "[]") ?: "[]"
    }
}

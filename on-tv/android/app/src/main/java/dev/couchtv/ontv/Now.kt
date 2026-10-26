package dev.couchtv.ontv

import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * What is on the TV now, in the same shape as the computer bridge's GET /api/now, and the push
 * to everyone listening (server-sent events and WebSockets).
 */
object Now {
    @Volatile var who: String? = null
    @Volatile var playedItem: JSONObject? = null          // the last thing /api/play started
    @Volatile var sleepEnds: Long? = null
    @Volatile private var front: String? = null
    @Volatile private var media: JSONObject? = null
    @Volatile private var lastSig = ""

    private val listeners = CopyOnWriteArraySet<(String) -> Unit>()
    private val loop = Executors.newSingleThreadScheduledExecutor()
    private var started = false

    fun listen(fn: (String) -> Unit) = listeners.add(fn)
    fun unlisten(fn: (String) -> Unit) = listeners.remove(fn)

    fun iso(t: Long = System.currentTimeMillis()): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(Date(t))

    fun payload(): JSONObject {
        val p = media
        return JSONObject()
            .put("ok", true)
            .put("tv_connected", true)                      // the server is on the TV: if it answers, the TV is there
            .put("power", if (Tv.isOn) "on" else "off")
            .put("app", Apps.describe(front)?.let { JSONObject(it) } ?: JSONObject.NULL)
            .put("volume", JSONObject(Tv.volume()))
            .put("playing", p ?: JSONObject.NULL)
            .put("sleep", JSONObject().put("ends", sleepEnds?.let { iso(it) } ?: JSONObject.NULL))
            .put("waking", false)
            .put("who", who ?: JSONObject.NULL)
            .put("picture", JSONObject.NULL)
            .put("mode", "on-tv")
            .put("adb", Adb.connected)
    }

    /** Sends the current state to every listener. */
    fun push() {
        val msg = payload().toString()
        listeners.forEach { runCatching { it(msg) } }
    }

    /** Every 4 s: front app, power, volume. Every 8 s while an app is in front: what it says is playing. */
    @Synchronized fun start() {
        if (started) return
        started = true
        var tick = 0
        loop.scheduleWithFixedDelay({
            try {
                tick++
                if (!Adb.connected && (Adb.everAllowed || Adb.paired) && tick % 15 == 1) runCatching { Adb.ensure() }
                front = Tv.frontPackage()
                if (tick % 2 == 0) media = readMedia()
                val v = Tv.volume()
                val sig = listOf(front, Tv.isOn, v["level"], v["muted"], media?.optString("title"), media?.optString("state"),
                    sleepEnds, who, Adb.connected).joinToString("|")
                if (sig != lastSig) { lastSig = sig; push() }
            } catch (e: Exception) { android.util.Log.w("couchtv", "now loop: ${e.message}") }
        }, 1, 4, TimeUnit.SECONDS)
    }

    private fun readMedia(): JSONObject? {
        val pkg = front ?: return null
        if (pkg in Apps.HOME_PACKAGES) return null
        val (uptime, all) = Tv.sessions()
        val s = all.filter { it.pkg == pkg && it.state != null }.sortedWith(compareBy({ !it.active }, { it.state == "NONE" })).firstOrNull()
            ?: return null
        val state = Tv.STATES[s.state] ?: "stopped"
        var pos = s.position
        if (pos != null && pos >= 0 && uptime != null && s.updated != null && state == "playing") pos += ((uptime - s.updated!!) * (if (s.speed == 0.0) 1.0 else s.speed)).toLong()
        if (pos != null && pos < 0) pos = null
        val item = playedItem?.takeIf { it.optString("package") == pkg }
        var title = s.title
        var source = "tv"
        if (title == null && item != null) { title = item.optString("title"); source = "bridge" }
        val (poster, backdrop) = if (item != null && Finder.norm(item.optString("title")) == Finder.norm(title)) item.opt("poster") as? String to item.opt("backdrop") as? String
            else Finder.artwork(title)
        val sameAsPlayed = item != null && Finder.norm(item.optString("title")) == Finder.norm(title)
        return JSONObject().put("title", title ?: JSONObject.NULL)
            .put("episode_title", s.subtitle ?: (if (sameAsPlayed) item!!.opt("episode_title") else null) ?: JSONObject.NULL)
            .put("season", if (sameAsPlayed) item!!.opt("season") else JSONObject.NULL)
            .put("episode", if (sameAsPlayed) item!!.opt("episode") else JSONObject.NULL)
            .put("service", Apps.BY_PACKAGE[pkg]?.id ?: JSONObject.NULL)
            .put("poster", poster ?: JSONObject.NULL).put("backdrop", backdrop ?: JSONObject.NULL)
            .put("state", state).put("position_ms", pos ?: JSONObject.NULL).put("updated", iso())
            .put("duration_ms", JSONObject.NULL).put("duration_source", JSONObject.NULL)
            .put("source", source).put("started", item?.opt("started") ?: JSONObject.NULL)
    }

    // ---------------------------------------------------------------- keep watching

    fun continueItems(whoFilter: String?): JSONArray {
        val h = Store.history()
        val out = JSONArray()
        val seen = HashSet<String>()
        for (i in 0 until h.length()) {
            val it = h.getJSONObject(i)
            val w = it.optString("who").takeIf { s -> s.isNotEmpty() && s != "null" }
            if (whoFilter != null && whoFilter != "both" && w != null && w != whoFilter) continue
            val key = Finder.norm(it.optString("title"))
            if (key.isEmpty() || !seen.add(key)) continue
            val pkg = it.optString("package")
            out.put(JSONObject().put("id", "h-$i").put("title", it.optString("title"))
                .put("episode_title", it.opt("episode_title") ?: JSONObject.NULL).put("season", it.opt("season") ?: JSONObject.NULL)
                .put("episode", it.opt("episode") ?: JSONObject.NULL).put("app", Apps.describe(pkg)?.let { d -> JSONObject(d) } ?: JSONObject.NULL)
                .put("service", it.opt("service") ?: JSONObject.NULL).put("poster", it.opt("poster") ?: JSONObject.NULL)
                .put("backdrop", it.opt("backdrop") ?: JSONObject.NULL).put("progress", JSONObject.NULL).put("kind", "continue")
                .put("last_played", it.opt("when") ?: JSONObject.NULL).put("source", "bridge"))
            if (out.length() >= 20) break
        }
        return out
    }
}

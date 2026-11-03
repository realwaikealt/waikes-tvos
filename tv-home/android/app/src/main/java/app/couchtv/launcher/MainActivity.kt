package app.couchtv.launcher

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The TV home screen. Shows the page the bridge serves at /tv/ full screen. If the bridge cannot be
 * reached, shows the saved copy of that page (scenes, clock, weather, apps), or the copy built
 * into the app, and keeps trying the bridge. With no bridge at all (option A) the built-in copy is
 * the home. A plain grid of the TV's apps is the last resort, so the TV is never stuck.
 */
class MainActivity : Activity() {

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val banners = ConcurrentHashMap<String, ByteArray>()
    private val icons = ConcurrentHashMap<String, ByteArray>()
    private val webApps = ConcurrentHashMap<String, Triple<String, Int, String>>()   // id -> name, colour, letter

    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private var fallback: View? = null
    private var splash: View? = null   // the logo over the dark ground until the page has painted its own loader
    private var pageReady = false
    private var loadFailed = false
    private var probing = false
    private var offline = false   // showing the saved copy because the computer is off
    private var resumed = false
    private var airpods: AirPodsWatcher? = null   // AirPods pop-up and Bluetooth audio (AirPodsWatcher.kt)
    private val retry = Runnable { if (!pageReady || offline) connect() }

    private val prefs by lazy { getSharedPreferences("home", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Lets a computer inspect the page over ADB (chrome://inspect). Only reachable with ADB access.
        WebView.setWebContentsDebuggingEnabled(true)
        root = FrameLayout(this).apply { setBackgroundColor(GROUND) }
        setContentView(root)
        airpods = AirPodsWatcher(this, root)
        // Same picture as the window background, so the hand-over from cold start to this view is invisible.
        splash = buildSplash()
        splashT0 = android.os.SystemClock.uptimeMillis()
        root.addView(splash, MATCH)
        (splashMark?.drawable as? android.graphics.drawable.Animatable)?.start()
        registerReceiver(wakeReceiver, android.content.IntentFilter(Intent.ACTION_SCREEN_ON))
        main.postDelayed({ hideSplash() }, SLOW_MS + 500)   // never stuck on the logo
        hideSystemBars()
        intent?.let { readExtras(it) }
        io.execute { warmApps() }
        // At power-on the page is often asked for before Wi-Fi is up: try again the moment it is.
        getSystemService(android.net.ConnectivityManager::class.java)?.registerDefaultNetworkCallback(
            object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) {
                    main.post { if (loadFailed || offline) connect() }
                }
            })
        // Load the last bridge that worked straight away; only probe the others if it fails.
        val saved = prefs.getString("bridge", null)
        if (saved != null) showWeb(saved) else connect()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.hasExtra("bridge") || intent.hasExtra("config_b64")) {
            readExtras(intent)
            pageReady = false
            offline = false
            connect()
            return
        }
        if (intent.hasExtra("guard")) return   // the screen guard bringing Home forward while the TV is off
        // test hook (adb): am start -n app.couchtv.launcher/.MainActivity --ei airpods_demo 3616   (model id, decimal)
        if (intent.hasExtra("airpods_demo")) { airpods?.demo(intent.getIntExtra("airpods_demo", 0x0E20)); return }
        // HOME pressed while we are already in front: back to the first tile.
        js("window.tv && tv.home()")
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        airpods?.onResume()
        maybeWake()
        ScreenGuard.start(this)
        hideSystemBars()
        if (pageReady && offline && alone()) {
            js("window.tv && tv.resume()")   // option A: the built-in copy is the home, keep it fresh
        } else if (pageReady && !offline) {
            js("window.tv && tv.resume()")
            // the computer may have gone off while the page was open: then the saved copy takes over
            val base = prefs.getString("bridge", null)
            if (base != null && hasOffline()) io.execute {
                if (!reachable(base)) main.post { if (resumed && !offline) { showOffline(); later(OFFLINE_RETRY_MS) } }
            }
        } else if (offline || fallback != null) connect()
        io.execute { warmApps() }
    }

    override fun onPause() {
        super.onPause()
        resumed = false
        airpods?.onPause()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (airpods?.handleKey(event) == true) return true   // the AirPods sheet is up
        // Every kind of remote: game controller A, Select and the number pad's Enter count as OK,
        // controller B and Escape as BACK. The page then only has to know OK and BACK.
        val same = when (event.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_SELECT, KeyEvent.KEYCODE_NUMPAD_ENTER -> KeyEvent.KEYCODE_DPAD_CENTER
            KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_ESCAPE -> KeyEvent.KEYCODE_BACK
            else -> null
        }
        if (same != null) {
            return dispatchKeyEvent(KeyEvent(event.downTime, event.eventTime, event.action, same, event.repeatCount,
                event.metaState, event.deviceId, event.scanCode, event.flags, event.source))
        }
        // The home screen never exits on BACK; the page decides what BACK means.
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP && pageReady) js("window.tv && tv.back()")
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    /**
     * What apply.sh tells the app: "bridge" (the bridge's address, or "none" for option A, no
     * computer), "config_b64" (the home's settings from config.json, base64 JSON, for the built-in
     * copy) and "tv" (which TV this is, for a house with more than one; none = the default TV).
     */
    private fun readExtras(i: Intent) {
        val e = prefs.edit()
        i.getStringExtra("bridge")?.trim()?.let {
            if (it.isEmpty() || it == "none") e.remove("bridge") else e.putString("bridge", it.trimEnd('/'))
        }
        i.getStringExtra("config_b64")?.let {
            try {
                val json = String(android.util.Base64.decode(it, android.util.Base64.DEFAULT), Charsets.UTF_8)
                JSONObject(json)   // only keep it if it is real JSON
                e.putString("config", json)
            } catch (x: Exception) {
                // a broken value keeps the settings the app already had
            }
        }
        i.getStringExtra("tv")?.let { e.putString("tv", it) }
        e.apply()
    }

    // ---------------------------------------------------------------- finding the bridge

    /** No bridge anywhere (option A): the built-in copy is the home, and nothing to look for. */
    private fun alone() = prefs.getString("bridge", null) == null && BuildConfig.BRIDGES.isEmpty()

    private fun connect() {
        if (probing) return
        if (alone()) {
            if (!offline || web == null) showOffline()
            return
        }
        probing = true
        val saved = prefs.getString("bridge", null)
        val candidates = (listOfNotNull(saved) + BuildConfig.BRIDGES).distinct()
        io.execute {
            val found = candidates.firstOrNull { reachable(it) }
            main.post {
                probing = false
                if (found != null) {
                    prefs.edit().putString("bridge", found).apply()
                    // back from the saved copy only while the home is on screen, never during a show
                    if (offline && !resumed) return@post
                    showWeb(found)
                } else if (hasOffline()) {
                    if (!offline) showOffline()
                    later(OFFLINE_RETRY_MS)
                } else {
                    showFallback()
                    later(RETRY_MS)
                }
            }
        }
    }

    private fun later(ms: Long) {
        main.removeCallbacks(retry)
        main.postDelayed(retry, ms)
    }

    private fun reachable(base: String): Boolean = try {
        val c = URL("$base/api/health").openConnection() as HttpURLConnection
        c.connectTimeout = 1200
        c.readTimeout = 1500
        val ok = c.responseCode in 200..299
        c.disconnect()
        ok
    } catch (e: Exception) {
        false
    }

    // ---------------------------------------------------------------- the page

    private fun showWeb(base: String) {
        val w = web ?: makeWebView().also { web = it; root.addView(it, 0, MATCH) }
        loadFailed = false
        offline = false
        pageReady = false
        val tv = prefs.getString("tv", null)
        w.loadUrl(if (tv.isNullOrEmpty()) "$base/tv/" else "$base/tv/?tv=$tv")
        // Never a blank screen: if the page is slow, show the app grid until it arrives.
        main.postDelayed({ if (!pageReady) showFallback() }, SLOW_MS)
    }

    private fun makeWebView(): WebView = WebView(this).apply {
        setBackgroundColor(GROUND)
        isFocusable = true
        isFocusableInTouchMode = true
        overScrollMode = View.OVER_SCROLL_NEVER
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.textZoom = 100
        addJavascriptInterface(Native(), "TVOS")
        webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                if (!loadFailed && url.startsWith("http")) {
                    pageReady = true
                    main.postDelayed({ hideSplash() }, 350)   // let the page paint its own loader first
                    removeFallback()
                    view.visibility = View.VISIBLE
                    view.requestFocus()
                    // the live page is up: bring the saved copy up to date if the page changed
                    if (!offline) prefs.getString("bridge", null)?.let { b -> io.execute { syncOffline(b) } }
                }
            }

            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) pageFailed()
            }

            override fun onReceivedHttpError(view: WebView, req: WebResourceRequest, res: WebResourceResponse) {
                if (req.isForMainFrame && res.statusCode >= 500) pageFailed()
            }

            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest) = true

            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                if (u.host == OFFLINE_HOST) return offlineFile(u.path ?: "")
                if (u.host != "tvos.invalid") return null
                val pkg = u.lastPathSegment ?: return null
                val isIcon = u.pathSegments.firstOrNull() == "icon"
                val img = (if (isIcon) iconImage(pkg) else bannerImage(pkg)) ?: return null
                return WebResourceResponse(if (isIcon) "image/png" else "image/jpeg", null, ByteArrayInputStream(img)).apply {
                    responseHeaders = mapOf("Cache-Control" to "max-age=86400")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The page crashed or was killed for memory. Drop it and start again.
                root.removeView(view)
                view.destroy()
                web = null
                pageReady = false
                connect()
                return true
            }
        }
    }

    private fun pageFailed() {
        if (loadFailed) return
        loadFailed = true
        pageReady = false
        web?.visibility = View.INVISIBLE
        web?.stopLoading()
        if (!offline && hasOffline()) main.post { showOffline() } else showFallback()
        later(3000)
    }

    // ---------------------------------------------------------------- the saved copy 

    private val offlineDir get() = java.io.File(filesDir, "offline/web")

    private fun hasSynced() = java.io.File(offlineDir, "index.html").isFile

    /** The copy of the home built into the app (assets/www/tv, from tv-home/web at build time). */
    private val hasBundled by lazy {
        try { assets.list(BUNDLED)?.contains("index.html") == true } catch (e: Exception) { false }
    }

    private fun hasOffline() = hasSynced() || hasBundled

    /** The bridge's latest copy when there is a bridge, else the one built into the app. */
    private fun useSynced() = !alone() && hasSynced()

    /**
     * The home page with no computer: the copy last taken from the bridge (option B with the
     * computer off), or the copy built into the app (option A, or B before the bridge first answered).
     */
    private fun showOffline() {
        if (!hasOffline()) { showFallback(); return }
        val w = web ?: makeWebView().also { web = it; root.addView(it, 0, MATCH) }
        loadFailed = false
        offline = true
        val tv = prefs.getString("tv", null)
        w.loadUrl("http://$OFFLINE_HOST/tv/index.html?offline=1" + (if (alone()) "&alone=1" else "") +
            if (tv.isNullOrEmpty()) "" else "&tv=$tv")
    }

    /** Copies the bridge's home page files when they changed (the bridge's fingerprint says so). */
    private fun syncOffline(base: String) {
        try {
            val m = JSONObject(fetchText("$base/tv/manifest.json"))
            val version = m.getString("version")
            if (version == prefs.getString("offline_version", null) && hasSynced()) return
            val tmp = java.io.File(filesDir, "offline/new").apply { deleteRecursively(); mkdirs() }
            val files = m.getJSONArray("files")
            for (i in 0 until files.length()) {
                val rel = files.getJSONObject(i).getString("path")
                if (rel.contains("..")) continue
                val out = java.io.File(tmp, rel).apply { parentFile?.mkdirs() }
                val c = URL("$base/tv/$rel").openConnection() as HttpURLConnection
                c.connectTimeout = 3000
                c.readTimeout = 15000
                try {
                    if (c.responseCode !in 200..299) return   // half a copy is no copy: keep the old one
                    c.inputStream.use { inp -> out.outputStream().use { inp.copyTo(it) } }
                } finally {
                    c.disconnect()
                }
            }
            offlineDir.deleteRecursively()
            if (tmp.renameTo(offlineDir)) prefs.edit().putString("offline_version", version).apply()
        } catch (e: Exception) {
            // try again the next time the live page loads
        }
    }

    private fun fetchText(url: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 3000
        c.readTimeout = 8000
        try {
            return c.inputStream.bufferedReader().readText()
        } finally {
            c.disconnect()
        }
    }

    private fun offlineFile(path: String): WebResourceResponse {
        val rel = path.removePrefix("/tv/").ifEmpty { "index.html" }
        val notFound = { WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), ByteArrayInputStream(ByteArray(0))) }
        if (rel.contains("..")) return notFound()
        val synced = useSynced()
        // The settings: the bridge's (in its copy) when there is a bridge, else what apply.sh
        // passed from config.json, else the defaults built into the app.
        val given = prefs.getString("config", null)
        if (rel == "config.js" && given != null && (!synced || !java.io.File(offlineDir, rel).isFile)) {
            val js = "window.COUCH_CONFIG = $given;\n".toByteArray()
            return WebResourceResponse("application/javascript", "utf-8", ByteArrayInputStream(js))
        }
        val type = mimeFor(rel.substringAfterLast('.', ""))
        val text = type.startsWith("text/") || type.endsWith("javascript") || type.endsWith("json")
        if (!synced) {
            return try {
                WebResourceResponse(type, if (text) "utf-8" else null, assets.open("$BUNDLED/$rel"))
            } catch (e: Exception) {
                notFound()
            }
        }
        val f = java.io.File(offlineDir, rel)
        if (!f.isFile) return notFound()
        return WebResourceResponse(type, if (text) "utf-8" else null, f.inputStream())
    }

    private fun mimeFor(ext: String): String {
        val type = when (ext.lowercase()) {
            "html" -> "text/html"
            "js" -> "application/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "webp" -> "image/webp"
            "svg" -> "image/svg+xml"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }
        return type
    }

    private fun js(code: String) {
        web?.takeIf { pageReady }?.evaluateJavascript(code, null)
    }

    // ---------------------------------------------------------------- what the page can ask for

    inner class Native {
        @JavascriptInterface
        fun apps(): String {
            val out = JSONArray()
            for ((ri, label) in appList()) {
                val ai = ri.activityInfo
                out.put(JSONObject().apply {
                    put("package", ai.packageName)
                    put("label", label)
                    put("hasBanner", ai.banner != 0 || ai.applicationInfo.banner != 0)
                })
            }
            return out.toString()
        }

        @JavascriptInterface
        fun launch(pkg: String): Boolean = launchPackage(pkg)

        @JavascriptInterface
        fun openSettings(): Boolean = start(Intent(Settings.ACTION_SETTINGS))

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        // The screen guard's log of screen on/off events (a JSON array), for the Debug page.
        @JavascriptInterface
        fun screenLog(): String = ScreenGuard.log(this@MainActivity)

        // Web apps: a website full screen with a remote pointer and no popups (WebAppActivity).
        // json: {"url":..., "hosts":"a.com,b.com", "desktop":true}
        @JavascriptInterface
        fun openWeb(json: String): Boolean = try {
            val o = JSONObject(json)
            val url = o.getString("url")
            if (!Blocklist.isWebScheme(url)) false else start(Intent(this@MainActivity, WebAppActivity::class.java)
                .putExtra("url", url)
                .putExtra("hosts", o.optString("hosts", ""))
                .putExtra("desktop", o.optBoolean("desktop", true)))
        } catch (e: Exception) {
            false
        }

        // The colours and names of the web app tiles, so their banners and icons can be drawn.
        // json: [{"id":"vidbox","name":"Vidbox","colour":"#7a3cff","letter":"V"}]
        @JavascriptInterface
        fun setWebApps(json: String) {
            try {
                val a = JSONArray(json)
                webApps.clear()
                for (i in 0 until a.length()) {
                    val o = a.getJSONObject(i)
                    webApps[o.getString("id")] = Triple(o.optString("name", o.getString("id")),
                        try { Color.parseColor(o.optString("colour", "#2a2a30")) } catch (e: Exception) { Color.parseColor("#2a2a30") },
                        o.optString("letter", "").ifEmpty { o.optString("name", "?").take(1) }.uppercase())
                }
            } catch (e: Exception) {
            }
        }

        // The TV's own input list (HDMI and the rest), for the Input quick button when there is no
        // bridge to press the TV_INPUT key. Only where the TV has a screen for it.
        @JavascriptInterface
        fun canOpenInputs(): Boolean = inputsIntent() != null

        @JavascriptInterface
        fun openInputs(): Boolean = inputsIntent()?.let { start(it) } ?: false

        // The saved copy has its own web storage, so the page keeps what it needs offline here.
        @JavascriptInterface
        fun keep(key: String, value: String) {
            getSharedPreferences("page", MODE_PRIVATE).edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun kept(key: String): String? = getSharedPreferences("page", MODE_PRIVATE).getString(key, null)

        // AirPods and Bluetooth audio (AirPodsWatcher): the page's Settings > AirPods & Bluetooth audio
        @JavascriptInterface
        fun btStatus(): String = airpods?.statusJson() ?: "{}"

        @JavascriptInterface
        fun btSet(key: String, value: String) {
            val a = airpods ?: return
            main.post {
                when (key) {
                    "on" -> a.enabled = value == "1"
                    "sens" -> a.sensitivity = value.toIntOrNull() ?: 1
                }
            }
        }

        @JavascriptInterface
        fun btPair() { airpods?.startPairing() }

        @JavascriptInterface
        fun btCancel() { airpods?.cancelFlowFromPage() }

        @JavascriptInterface
        fun btAllow() { airpods?.askPermission() }

        @JavascriptInterface
        fun btSettings(): Boolean = airpods?.openBluetoothSettings() ?: false

        // test hook: show the pop-up as if AirPods Pro had been heard
        @JavascriptInterface
        fun btDemo(model: Int): Boolean = airpods?.demo(model) ?: false
    }

    /**
     * An input list screen, if this TV has one. Makers name it differently, so each guess is checked
     * with resolveActivity: a wrong guess is skipped and, with none left, the Input button is hidden.
     */
    private fun inputsIntent(): Intent? = INPUT_ACTIONS.asSequence()
        .map { Intent(it) }
        .firstOrNull { packageManager.resolveActivity(it, 0) != null }

    @Volatile private var appCache: List<Pair<ResolveInfo, String>>? = null

    /** The TV's apps with their labels. Cached: reading labels for 30 apps is slow on this TV. */
    private fun tvApps(): List<ResolveInfo> = appList().map { it.first }

    private fun appList(): List<Pair<ResolveInfo, String>> = appCache ?: synchronized(this) {
        appCache ?: run {
            val q = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
            packageManager.queryIntentActivities(q, 0)
                .filter { it.activityInfo.packageName != packageName }
                .distinctBy { it.activityInfo.packageName }
                .map { it to it.loadLabel(packageManager).toString() }
                .sortedBy { it.second.lowercase() }
                .also { appCache = it }
        }
    }

    /** Builds the app list and every banner ahead of time, so the page never waits for them. */
    private fun warmApps() {
        appCache = null
        appList().forEach { bannerImage(it.first.activityInfo.packageName) }
    }

    /** The app's TV banner as a JPEG: memory, then disk, then drawn fresh. */
    /** A web app's tile: its colour, with its letter and name in white. */
    private fun webTile(pkg: String, w: Int, h: Int, png: Boolean): ByteArray? {
        val (name, colour, letter) = webApps[pkg.removePrefix("web:")] ?: Triple(pkg.removePrefix("web:"), Color.parseColor("#2a2a30"), pkg.removePrefix("web:").take(1).uppercase())
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(colour)
        val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textAlign = android.graphics.Paint.Align.CENTER
            typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
        }
        if (png) {
            p.textSize = h * 0.62f
            c.drawText(letter, w / 2f, h * 0.70f, p)
        } else {
            p.textSize = h * 0.42f
            c.drawText(letter, w / 2f, h * 0.55f, p)
            p.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
            p.textSize = h * 0.11f
            p.alpha = 200
            c.drawText(name, w / 2f, h * 0.82f, p)
        }
        return ByteArrayOutputStream().also {
            if (png) bmp.compress(Bitmap.CompressFormat.PNG, 100, it) else bmp.compress(Bitmap.CompressFormat.JPEG, 90, it)
            bmp.recycle()
        }.toByteArray()
    }

    private fun bannerImage(pkg: String): ByteArray? {
        if (pkg.startsWith("web:")) return webTile(pkg, 640, 360, false)
        banners[pkg]?.let { return it }
        val ri = tvApps().firstOrNull { it.activityInfo.packageName == pkg } ?: return null
        val version = try { packageManager.getPackageInfo(pkg, 0).lastUpdateTime } catch (e: Exception) { 0L }
        val file = java.io.File(java.io.File(filesDir, "banners").apply { mkdirs() }, "$pkg-$version-v3.jpg")
        val bytes = if (file.exists()) file.readBytes() else bannerBytes(ri)?.also { file.writeBytes(it) }
        if (bytes != null) banners[pkg] = bytes
        return bytes
    }

    private fun launchPackage(pkg: String): Boolean {
        val i = packageManager.getLeanbackLaunchIntentForPackage(pkg)
            ?: packageManager.getLaunchIntentForPackage(pkg)
            ?: return false
        return start(i)
    }

    private fun start(i: Intent): Boolean = try {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        main.post { startActivity(i) }
        true
    } catch (e: Exception) {
        false
    }

    private fun bannerBytes(ri: ResolveInfo): ByteArray? {
        val banner = ri.activityInfo.loadBanner(packageManager)
            ?: ri.activityInfo.applicationInfo.loadBanner(packageManager)
        val bmp = Bitmap.createBitmap(640, 360, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(FLAP)
        if (banner != null) {
            banner.setBounds(0, 0, 640, 360)
            banner.draw(c)
        } else {
            iconTile(ri.loadIcon(packageManager), c)
        }
        return ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it); bmp.recycle() }.toByteArray()
    }

    /**
     * Apps with no TV banner still get a full-bleed tile, so the grid reads as one design: the
     * icon's own background fills the tile and its logo sits in the middle.
     */
    private fun iconTile(icon: Drawable, c: Canvas) {
        // the icon as a plain square, without the launcher's round mask
        val n = 432
        val sq = Bitmap.createBitmap(n, n, Bitmap.Config.ARGB_8888)
        val sc = Canvas(sq)
        if (icon is android.graphics.drawable.AdaptiveIconDrawable) {
            icon.background?.apply { setBounds(0, 0, n, n); draw(sc) }
            icon.foreground?.apply { setBounds(0, 0, n, n); draw(sc) }
        } else {
            icon.setBounds(0, 0, n, n)
            icon.draw(sc)
        }
        // find the logo: everything that differs from the icon's edge colour
        val edge = sq.getPixel(2, n / 2)
        var l = n; var t = n; var r = 0; var b = 0
        for (y in 0 until n step 2) for (x in 0 until n step 2) {
            val px = sq.getPixel(x, y)
            val d = Math.abs(Color.red(px) - Color.red(edge)) + Math.abs(Color.green(px) - Color.green(edge)) +
                Math.abs(Color.blue(px) - Color.blue(edge))
            if (d > 60 && Color.alpha(px) > 128) { l = minOf(l, x); t = minOf(t, y); r = maxOf(r, x); b = maxOf(b, y) }
        }
        if (r <= l || b <= t) { l = n / 4; t = n / 4; r = n * 3 / 4; b = n * 3 / 4 }
        // every logo about the same size: 150 px tall at most, 440 px wide at most
        val s = minOf(150f / (b - t), 440f / (r - l)).coerceIn(0.5f, 3f)
        val size = (n * s).toInt()
        val left = (320 - (l + r) / 2f * s).toInt()
        val top = (180 - (t + b) / 2f * s).toInt()
        // fill any gap with the icon's own edge colour, stretched, so the tile has no join
        c.drawColor(edge)
        val p = android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG)
        val rect = { a: Int, bb: Int, cc: Int, dd: Int -> android.graphics.Rect(a, bb, cc, dd) }
        if (left > 0) c.drawBitmap(sq, rect(1, 0, 2, n), rect(0, top, left, top + size), p)
        if (left + size < 640) c.drawBitmap(sq, rect(n - 2, 0, n - 1, n), rect(left + size, top, 640, top + size), p)
        if (top > 0) c.drawBitmap(sq, rect(0, 1, n, 2), rect(left, 0, left + size, top), p)
        if (top + size < 360) c.drawBitmap(sq, rect(0, n - 2, n, n - 1), rect(left, top + size, left + size, 360), p)
        c.drawBitmap(sq, null, rect(left, top, left + size, top + size), p)
        sq.recycle()
    }

    /** The app's square icon as a PNG, for the small badge on Keep watching tiles. */
    private fun iconImage(pkg: String): ByteArray? {
        if (pkg.startsWith("web:")) return webTile(pkg, 128, 128, true)
        icons[pkg]?.let { return it }
        val ri = tvApps().firstOrNull { it.activityInfo.packageName == pkg }
        val d = ri?.loadIcon(packageManager)
            ?: try { packageManager.getApplicationIcon(pkg) } catch (e: Exception) { return null }
        val bmp = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, 128, 128)
        d.draw(Canvas(bmp))
        val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it); bmp.recycle() }.toByteArray()
        icons[pkg] = bytes
        return bytes
    }

    // ---------------------------------------------------------------- never stuck: the native grid

    // The startup splash: the dark ground, a soft glow and the mark springing in with its lines drawn on
    // (splash_mark_avd). The page's own startup screen (startup.js) shows the same mark and takes over.
    private var splashT0 = 0L
    private var splashMark: ImageView? = null
    private var woke = false
    private val wakeReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: android.content.Context?, i: Intent?) { woke = true; if (resumed) maybeWake() }
    }
    override fun onDestroy() {
        try { unregisterReceiver(wakeReceiver) } catch (e: Exception) {}
        super.onDestroy()
    }
    private fun buildSplash(): View {
        fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
        val f = FrameLayout(this).apply { setBackgroundColor(GROUND) }
        val glow = View(this).apply {
            background = GradientDrawable().apply {
                gradientType = GradientDrawable.RADIAL_GRADIENT
                gradientRadius = dp(176).toFloat()
                colors = intArrayOf(0x57D8467F, 0x294A2F8A, 0x00120D13)
                setGradientCenter(0.5f, 0.5f)
            }
            alpha = 0f; scaleX = 0.6f; scaleY = 0.6f
            animate().alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(100).setDuration(1100).setInterpolator(Ui.OUT).start()
        }
        f.addView(glow, FrameLayout.LayoutParams(dp(352), dp(352), Gravity.CENTER))
        val mark = ImageView(this).apply { setImageResource(R.drawable.splash_mark_avd) }
        splashMark = mark
        f.addView(mark, FrameLayout.LayoutParams(dp(96), dp(96), Gravity.CENTER))
        return f
    }

    // the TV woke from standby: the page plays its short startup animation
    private fun maybeWake() {
        if (!woke || !pageReady) return
        woke = false
        js("window.tv && tv.wake && tv.wake()")
    }

    private fun hideSplash() {
        val v = splash ?: return
        val left = 900L - (android.os.SystemClock.uptimeMillis() - splashT0)   // let the drawing-on finish
        if (left > 0) { main.postDelayed({ hideSplash() }, left); return }
        splash = null
        v.animate().alpha(0f).setDuration(Ui.SLOW).setInterpolator(Ui.OUT).withEndAction { root.removeView(v) }.start()
    }

    private fun showFallback() {
        if (fallback != null) return
        hideSplash()
        fun px(v: Int) = Ui.px(this, v)   // design px on a 1920 x 1080 canvas (see docs/DESIGN-TOKENS.md)

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(80), px(60), px(80), px(60))   // the page's safe area: 5rem x 3.75rem
        }
        column.addView(TextView(this).apply {
            text = "Home"
            setTextColor(Ui.TEXT)
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, Ui.sp(this@MainActivity, 48))
            typeface = Ui.font(this@MainActivity, 700)
            letterSpacing = -0.02f
        })
        column.addView(TextView(this).apply {
            text = "Can’t reach your computer, so shows and picks are hidden. Your apps still work."
            setTextColor(Ui.TEXT_2)
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, Ui.sp(this@MainActivity, 24))
            typeface = Ui.font(this@MainActivity, 500)
            setPadding(0, px(8), 0, px(36))
        })
        val grid = GridLayout(this).apply { columnCount = 6 }
        val tiles = tvApps().map { ri -> ri.activityInfo.packageName to ri } + listOf("settings" to null)
        for ((pkg, ri) in tiles) {
            val tile = FrameLayout(this).apply {
                isFocusable = true
                isClickable = true
                background = GradientDrawable().apply { setColor(Ui.TILE); cornerRadius = px(20).toFloat() }
                foreground = GradientDrawable().apply { cornerRadius = px(20).toFloat() }
                clipToOutline = true
                outlineProvider = android.view.ViewOutlineProvider.BACKGROUND
                setOnFocusChangeListener { v, has ->
                    Ui.focusScale(v, has, 1.08f)
                    (v.foreground as GradientDrawable).setStroke(if (has) px(4) else 0, android.graphics.Color.WHITE)
                    v.elevation = if (has) px(10).toFloat() else 0f
                }
                setOnClickListener { if (ri == null) start(Intent(Settings.ACTION_SETTINGS)) else launchPackage(pkg) }
            }
            if (ri != null) {
                tile.addView(ImageView(this).apply {
                    val ai = ri.activityInfo
                    val b = ai.loadBanner(packageManager) ?: ai.applicationInfo.loadBanner(packageManager)
                    if (b != null) {
                        setImageDrawable(b); scaleType = ImageView.ScaleType.CENTER_CROP
                    } else {
                        setImageDrawable(ri.loadIcon(packageManager)); scaleType = ImageView.ScaleType.CENTER_INSIDE
                        setPadding(px(40), px(24), px(40), px(40))
                    }
                }, MATCH)
                if (ri.activityInfo.loadBanner(packageManager) == null && ri.activityInfo.applicationInfo.loadBanner(packageManager) == null) {
                    tile.addView(label(ri.loadLabel(packageManager).toString(), px(16)))
                }
            } else {
                tile.addView(label("Settings", px(16)))
            }
            grid.addView(tile, GridLayout.LayoutParams().apply {
                width = px(264); height = px(148)   // 16:9, two thirds of the page's app tile
                setMargins(px(12), px(12), px(12), px(12))
            })
        }
        column.addView(grid)
        val scroll = ScrollView(this).apply { isFillViewport = true; addView(column) }
        fallback = scroll
        root.addView(scroll, MATCH)
        grid.getChildAt(0)?.requestFocus()
    }

    private fun label(text: String, pad: Int) = TextView(this).apply {
        this.text = text
        setTextColor(Ui.TEXT)
        setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, Ui.sp(this@MainActivity, 20))
        typeface = Ui.font(this@MainActivity, 600)
        gravity = Gravity.BOTTOM or Gravity.START
        setPadding(pad, pad, pad, pad)
        layoutParams = FrameLayout.LayoutParams(MATCH_W, MATCH_W)
    }

    private fun removeFallback() {
        fallback?.let { root.removeView(it) }
        fallback = null
    }

    private fun hideSystemBars() {
        window.decorView.windowInsetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    companion object {
        private val INPUT_ACTIONS = listOf(
            "android.settings.TV_INPUT_SETTINGS",           // some Android TV builds
            "com.android.tv.action.VIEW_INPUTS",            // the Live Channels input picker
            "com.google.android.tv.action.VIEW_INPUTS",
            "android.media.tv.action.SETUP_INPUTS"          // the system list of TV inputs
        )
        private const val RETRY_MS = 15_000L
        private const val OFFLINE_RETRY_MS = 60_000L   // looking for the bridge while the saved copy shows
        private const val OFFLINE_HOST = "home.tvos.invalid"
        private const val BUNDLED = "www/tv"   // the built-in copy, in the app's assets
        private const val SLOW_MS = 2_500L
        private const val MATCH_W = ViewGroup.LayoutParams.MATCH_PARENT
        private val MATCH = FrameLayout.LayoutParams(MATCH_W, MATCH_W)
        private val GROUND = Ui.GROUND
        private val FLAP = Ui.TILE   // the quiet tile colour behind app banners (--tile on the page)
    }
}

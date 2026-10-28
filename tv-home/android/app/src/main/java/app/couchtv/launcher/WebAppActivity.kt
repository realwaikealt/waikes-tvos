package app.couchtv.launcher

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.util.Base64
import org.json.JSONObject
import org.json.JSONTokener
import android.widget.TextView
import java.io.ByteArrayInputStream

/**
 * A web app: one website full screen with a TV remote pointer, and no popups. Anything on the page
 * that tries to open another window, leave the site, start a download or open another app is
 * refused, and the ad and adult lists (assets/blocklist.txt) stop the requests themselves.
 *
 * Remote: arrows move the pointer (hold to go faster), OK clicks, up and down at the screen edge
 * scroll the page, Back goes back a page and then closes, Menu hides or shows the pointer.
 */
class WebAppActivity : Activity() {

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var cursor: CursorView
    private lateinit var note: TextView
    private val ui = Handler(Looper.getMainLooper())
    private var startUrl = ""
    private var allowedHosts: List<String> = emptyList()
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var blockedCount = 0
    private var cursorOn = true
    private val prefs by lazy { getSharedPreferences("webapps", Context.MODE_PRIVATE) }
    private var hostKey = "site"
    private var pointerMode = false           // false = jump between buttons, true = free pointer
    private var widthIdx = 3
    private var desktop = true
    private var lite = true
    private var liteLabel: TextView? = null
    private var defaultUa = ""
    private lateinit var toolbar: LinearLayout
    private lateinit var kbd: LinearLayout
    private lateinit var kbdText: TextView
    private lateinit var kbdLabel: TextView
    private val typed = StringBuilder()
    private var kbdOpen = false
    private var toolbarOpen = false
    private var navJs = ""
    private var okLongFired = false
    private var okPending = false
    private var modeLabel: TextView? = null
    private var uaLabel: TextView? = null
    private var zoomLabel: TextView? = null
    private var lastKey = 0
    private var heldSince = 0L

    private val blocklist: Blocklist by lazy {
        Blocklist(try { assets.open("blocklist.txt").bufferedReader().readLines() } catch (e: Exception) { emptyList() })
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        startUrl = intent.getStringExtra("url").orEmpty()
        allowedHosts = (intent.getStringExtra("hosts") ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }
        hostKey = (Blocklist.hostOf(startUrl) ?: "site").replace(Regex("[^A-Za-z0-9.]"), "_")
        desktop = prefs.getBoolean("$hostKey.desktop", intent.getBooleanExtra("desktop", true))
        pointerMode = prefs.getString("$hostKey.mode", "focus") == "pointer"
        widthIdx = prefs.getInt("$hostKey.width", 3).coerceIn(0, WIDTHS.size - 1)
        lite = prefs.getBoolean("$hostKey.lite", true)
        navJs = try { assets.open("webnav.js").bufferedReader().readText() } catch (e: Exception) { "" }

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        web = WebView(this)
        setUpWebView(web, desktop)
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        cursor = CursorView(this)
        root.addView(cursor, FrameLayout.LayoutParams(-1, -1))
        cursorOn = pointerMode
        note = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            setPadding(36, 18, 36, 18)
            setBackgroundColor(0xCC000000.toInt())
            visibility = View.GONE
        }
        root.addView(note, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = 40 })
        buildToolbar()
        buildKeyboard()
        setContentView(root)
        hideBars()
        registerReceiver(remote, IntentFilter(ACTION))

        if (!Blocklist.isWebScheme(startUrl) || blocklist.isBlocked(startUrl)) {
            web.loadDataWithBaseURL(null, blockedPage(startUrl), "text/html", "utf-8", null)
        } else {
            web.loadUrl(startUrl)
        }
        flash(if (pointerMode) "Pointer: arrows move it, OK clicks. Hold OK to jump between buttons. Menu: tools" else "Arrows jump between buttons. OK selects. Hold OK for a free pointer. Menu: tools", 5000)
    }

    @Suppress("SetJavaScriptEnabled")
    private fun setUpWebView(w: WebView, desktop: Boolean) {
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(true)      // so onCreateWindow is called, and can say no
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            allowFileAccess = false
            allowContentAccess = false
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT
            defaultUa = userAgentString
            if (desktop) userAgentString = desktopUa(defaultUa)
        }
        w.isFocusable = false
        w.setDownloadListener { _, _, _, _, _ -> flash("Downloads are blocked here.", 2500) }
        w.webChromeClient = object : WebChromeClient() {
            // every popup, new tab and window.open: no
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean {
                count("A popup was blocked")
                return false
            }

            override fun onShowCustomView(view: View, cb: CustomViewCallback) {
                if (customView != null) { cb.onCustomViewHidden(); return }
                customView = view
                customCallback = cb
                root.addView(view, root.indexOfChild(cursor), FrameLayout.LayoutParams(-1, -1))
                web.visibility = View.INVISIBLE
            }

            override fun onHideCustomView() { leaveFullscreen() }

            override fun onJsAlert(v: WebView, url: String, message: String, r: JsResult): Boolean { r.cancel(); count("A pop-up message was blocked"); return true }
            override fun onJsConfirm(v: WebView, url: String, message: String, r: JsResult): Boolean { r.cancel(); return true }
            override fun onJsPrompt(v: WebView, url: String, message: String, d: String?, r: JsPromptResult): Boolean { r.cancel(); return true }
            override fun onConsoleMessage(m: ConsoleMessage): Boolean = true
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val url = req.url.toString()
                if (!req.isForMainFrame) return false
                return when {
                    !Blocklist.isWebScheme(url) -> { count("Opening another app was blocked"); true }
                    blocklist.isBlocked(url) -> { showBlocked(view, url); true }
                    !Blocklist.sameSite(startUrl, url, allowedHosts) && !Blocklist.sameSite(view.url ?: startUrl, url, allowedHosts) -> {
                        count("A redirect to another site was blocked"); true
                    }
                    else -> false
                }
            }

            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val url = req.url.toString()
                if (blocklist.isBlocked(url)) {
                    ui.post { blockedCount++ }
                    return if (req.isForMainFrame) {
                        WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(blockedPage(url).toByteArray()))
                    } else {
                        WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                    }
                }
                return null
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { view.evaluateJavascript(GUARD_JS, null); inject(view) }
            override fun onPageFinished(view: WebView, url: String) { view.evaluateJavascript(GUARD_JS, null); inject(view) }
        }
    }

    private fun showBlocked(view: WebView, url: String) {
        blockedCount++
        view.loadDataWithBaseURL(null, blockedPage(url), "text/html", "utf-8", null)
    }

    private fun blockedPage(url: String): String {
        val host = Blocklist.hostOf(url) ?: ""
        val safe = host.replace("<", "").replace(">", "").replace("&", "")
        return "<html><body style=\"margin:0;background:#120d13;color:#f3ece6;font-family:sans-serif;display:flex;" +
            "align-items:center;justify-content:center;height:100vh;text-align:center\"><div>" +
            "<div style=\"font-size:64px\">&#128683;</div><h1 style=\"font-weight:500\">Blocked</h1>" +
            "<p style=\"opacity:.7;font-size:22px\">Waike's tvOS blocked this page" + (if (safe.isEmpty()) "" else " ($safe)") + ".</p>" +
            "<p style=\"opacity:.5;font-size:18px\">Press Back to return.</p></div></body></html>"
    }

    // ------------------------------------------------------------------ the pointer and keys

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        val code = e.keyCode
        if (code == KeyEvent.KEYCODE_BACK) {
            if (e.action == KeyEvent.ACTION_UP) goBack()
            return true
        }
        // keyboard or toolbar open: the normal focus system walks their buttons
        if (kbdOpen || toolbarOpen) {
            if (toolbarOpen && (code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_SETTINGS || code == KeyEvent.KEYCODE_INFO)) {
                if (e.action == KeyEvent.ACTION_DOWN && e.repeatCount == 0) closeToolbar()
                return true
            }
            return super.dispatchKeyEvent(e)
        }
        val isOk = code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER || code == KeyEvent.KEYCODE_BUTTON_A
        if (isOk) {
            if (e.action == KeyEvent.ACTION_DOWN && e.repeatCount == 0) {
                okLongFired = false
                okPending = true
                ui.postDelayed(okLong, 650)
            } else if (e.action == KeyEvent.ACTION_UP) {
                ui.removeCallbacks(okLong)
                if (okPending && !okLongFired) activate()
                okPending = false
            }
            return true
        }
        if (e.action != KeyEvent.ACTION_DOWN) {
            return when (code) {
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
                KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS, KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_BUTTON_Y,
                KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_CHANNEL_DOWN -> true
                else -> super.dispatchKeyEvent(e)
            }
        }
        when (code) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                if (pointerMode) {
                    if (e.repeatCount == 0 || code != lastKey) heldSince = SystemClock.uptimeMillis()
                    lastKey = code
                    cursorOn = true
                    val held = SystemClock.uptimeMillis() - heldSince
                    // a tap moves a few pixels, holding speeds up smoothly
                    val step = if (e.repeatCount == 0) 12 else (24 + (held / 45).coerceAtMost(90)).toInt()
                    move(code, step)
                } else {
                    val dir = when (code) { KeyEvent.KEYCODE_DPAD_UP -> "up"; KeyEvent.KEYCODE_DPAD_DOWN -> "down"; KeyEvent.KEYCODE_DPAD_LEFT -> "left"; else -> "right" }
                    web.evaluateJavascript("window.__tvos?__tvos.nav('$dir'):'none'") { r ->
                        val v = r?.trim('"') ?: ""
                        if (v == "edge-up" && !pointerMode) openToolbar()
                        if (v == "none") scrollPage(if (dir == "up") -(root.height * 0.6f).toInt() else if (dir == "down") (root.height * 0.6f).toInt() else 0)
                    }
                }
                return true
            }
            KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_CHANNEL_UP -> { scrollPage(-(root.height * 0.75f).toInt()); return true }
            KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN -> { scrollPage((root.height * 0.75f).toInt()); return true }
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS, KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_BUTTON_Y -> { if (e.repeatCount == 0) openToolbar(); return true }
        }
        return super.dispatchKeyEvent(e)
    }

    private val okLong = Runnable {
        okLongFired = true
        okPending = false
        setPointerMode(!pointerMode)
    }

    private fun setPointerMode(on: Boolean) {
        pointerMode = on
        cursorOn = on
        prefs.edit().putString("$hostKey.mode", if (on) "pointer" else "focus").apply()
        web.evaluateJavascript("window.__tvos&&__tvos.mode('${if (on) "pointer" else "focus"}')", null)
        cursor.wake()
        modeLabel?.text = if (on) "Pointer" else "Buttons"
        flash(if (on) "Free pointer. Hold OK to go back to jumping between buttons." else "Jumping between buttons. Hold OK for a free pointer.", 2600)
    }

    private fun activate() {
        if (pointerMode) {
            click()
            ui.postDelayed({ checkInput() }, 350)
        } else {
            web.evaluateJavascript("window.__tvos?__tvos.click():''") { r ->
                val info = parse(r)
                when (info?.optString("kind")) {
                    "input" -> openKeyboard(info.optString("label"), info.optString("value"))
                    "none" -> flash("Nothing selected. Press an arrow first.", 1600)
                    "clicked" -> ui.postDelayed({ checkInput() }, 350)
                }
            }
        }
    }

    /** After a click, if a text box got the focus, offer the keyboard. */
    private fun checkInput() {
        web.evaluateJavascript("window.__tvos?__tvos.pending():''") { r ->
            val info = parse(r)
            if (info != null && info.optString("kind") == "input" && !kbdOpen) openKeyboard(info.optString("label"), info.optString("value"))
        }
    }

    /** evaluateJavascript hands back JSON text; ours is itself a JSON string holding JSON. */
    private fun parse(r: String?): JSONObject? {
        if (r == null || r == "null") return null
        return try {
            val inner = JSONTokener(r).nextValue()
            if (inner is String && inner.isNotEmpty()) JSONObject(inner) else if (inner is JSONObject) inner else null
        } catch (e: Exception) { null }
    }

    private fun move(code: Int, step: Int) {
        val w = root.width
        val h = root.height
        var x = cursor.cx
        var y = cursor.cy
        when (code) {
            KeyEvent.KEYCODE_DPAD_LEFT -> x -= step
            KeyEvent.KEYCODE_DPAD_RIGHT -> x += step
            KeyEvent.KEYCODE_DPAD_UP -> if (y <= EDGE) scrollPage(-(h * 0.45f).toInt()) else y -= step
            KeyEvent.KEYCODE_DPAD_DOWN -> if (y >= h - EDGE) scrollPage((h * 0.45f).toInt()) else y += step
        }
        cursor.cx = x.coerceIn(0f, (w - 1).toFloat())
        cursor.cy = y.coerceIn(0f, (h - 1).toFloat())
        cursor.wake()
    }

    private fun scrollPage(dy: Int) {
        if (customView == null && dy != 0) web.scrollBy(0, dy)
    }

    /** A real touch at the pointer, so the page sees an ordinary tap. */
    private fun click() {
        val target: View = customView ?: web
        val t = SystemClock.uptimeMillis()
        val x = cursor.cx
        val y = cursor.cy
        val down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0)
        val up = MotionEvent.obtain(t, t + 60, MotionEvent.ACTION_UP, x, y, 0)
        down.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
        up.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
        target.dispatchTouchEvent(down)
        ui.postDelayed({ target.dispatchTouchEvent(up); up.recycle() }, 60)
        down.recycle()
        cursor.pulse()
    }

    private fun goBack() {
        when {
            kbdOpen -> closeKeyboard()
            toolbarOpen -> closeToolbar()
            customView != null -> customCallback?.onCustomViewHidden() ?: leaveFullscreen()
            web.canGoBack() -> web.goBack()
            else -> finish()
        }
    }

    // ------------------------------------------------------------------ page helpers

    private fun inject(view: WebView) {
        if (navJs.isNotEmpty()) view.evaluateJavascript(navJs, null)
        view.evaluateJavascript("window.__tvos&&(__tvos.viewport(${WIDTHS[widthIdx]}),__tvos.lite($lite),__tvos.mode('${if (pointerMode) "pointer" else "focus"}'))", null)
    }

    private fun desktopUa(ua: String) = ua.replace("; wv", "").replace(Regex("Version/\\d+\\.\\d+ "), "").replace(" Mobile Safari", " Safari")

    private fun zoomPercent() = (960f / WIDTHS[widthIdx] * 100).toInt()

    private fun setWidth(i: Int) {
        widthIdx = i.coerceIn(0, WIDTHS.size - 1)
        prefs.edit().putInt("$hostKey.width", widthIdx).apply()
        web.evaluateJavascript("window.__tvos&&__tvos.viewport(${WIDTHS[widthIdx]})", null)
        zoomLabel?.text = "Zoom ${zoomPercent()}%"
        flash("Zoom ${zoomPercent()}%", 1200)
    }

    private fun toggleLite() {
        lite = !lite
        prefs.edit().putBoolean("$hostKey.lite", lite).apply()
        web.evaluateJavascript("window.__tvos&&__tvos.lite($lite)", null)
        liteLabel?.text = if (lite) "Smooth: on" else "Smooth: off"
        flash(if (lite) "Page animations off for smoother scrolling" else "Page animations on", 1800)
    }

    private fun toggleUa() {
        desktop = !desktop
        prefs.edit().putBoolean("$hostKey.desktop", desktop).apply()
        web.settings.userAgentString = if (desktop) desktopUa(defaultUa) else defaultUa
        uaLabel?.text = if (desktop) "Desktop site" else "Mobile site"
        flash(if (desktop) "Desktop site, reloading" else "Mobile site, reloading", 1500)
        web.reload()
    }

    // ------------------------------------------------------------------ toolbar

    private fun pill(text: String, size: Float = 17f, action: () -> Unit): TextView {
        val bg = { on: Boolean -> GradientDrawable().apply { cornerRadius = 90f; setColor(if (on) Color.WHITE else 0xFF2C2C2E.toInt()) } }
        return TextView(this).apply {
            this.text = text
            textSize = size
            gravity = Gravity.CENTER
            setPadding(34, 20, 34, 20)
            setTextColor(Color.WHITE)
            background = bg(false)
            isFocusable = true
            isClickable = true
            setOnClickListener { action() }
            setOnFocusChangeListener { _, f -> setTextColor(if (f) Color.BLACK else Color.WHITE); background = bg(f) }
        }
    }

    private fun lp(weight: Float = 0f, m: Int = 8) = LinearLayout.LayoutParams(if (weight > 0f) 0 else -2, -2, weight).apply { setMargins(m, m, m, m) }

    private fun buildToolbar() {
        toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(24, 18, 24, 18)
            background = GradientDrawable().apply { cornerRadius = 70f; setColor(0xF2120D13.toInt()) }
            visibility = View.GONE
        }
        toolbar.addView(pill("Back") { closeToolbar(); if (web.canGoBack()) web.goBack() }, lp())
        toolbar.addView(pill("Reload") { closeToolbar(); web.reload() }, lp())
        toolbar.addView(pill("−") { setWidth(widthIdx + 1) }, lp())
        zoomLabel = pill("Zoom ${zoomPercent()}%") { setWidth(3) }
        toolbar.addView(zoomLabel, lp())
        toolbar.addView(pill("+") { setWidth(widthIdx - 1) }, lp())
        modeLabel = pill(if (pointerMode) "Pointer" else "Buttons") { setPointerMode(!pointerMode) }
        toolbar.addView(modeLabel, lp())
        uaLabel = pill(if (desktop) "Desktop site" else "Mobile site") { toggleUa() }
        toolbar.addView(uaLabel, lp())
        liteLabel = pill(if (lite) "Smooth: on" else "Smooth: off") { toggleLite() }
        toolbar.addView(liteLabel, lp())
        toolbar.addView(pill("Home") { finish() }, lp())
        root.addView(toolbar, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = 36 })
    }

    private fun openToolbar() {
        if (toolbarOpen) return
        toolbarOpen = true
        toolbar.visibility = View.VISIBLE
        toolbar.getChildAt(0).requestFocus()
    }

    private fun closeToolbar() {
        toolbarOpen = false
        toolbar.visibility = View.GONE
    }

    // ------------------------------------------------------------------ typing

    private fun buildKeyboard() {
        kbd = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(48, 28, 48, 28)
            background = GradientDrawable().apply { cornerRadii = floatArrayOf(60f, 60f, 60f, 60f, 0f, 0f, 0f, 0f); setColor(0xF5120D13.toInt()) }
            visibility = View.GONE
        }
        kbdLabel = TextView(this).apply { setTextColor(0xB3FFFFFF.toInt()); textSize = 15f }
        kbd.addView(kbdLabel)
        kbdText = TextView(this).apply {
            setTextColor(Color.WHITE); textSize = 28f; setPadding(30, 14, 30, 14)
            background = GradientDrawable().apply { cornerRadius = 24f; setColor(0xFF2C2C2E.toInt()) }
            minWidth = 900
        }
        kbd.addView(kbdText, LinearLayout.LayoutParams(-2, -2).apply { setMargins(0, 10, 0, 16) })
        val rows = listOf("1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm.-_")
        for (r in rows) {
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
            for (ch in r) row.addView(pill(ch.toString(), 22f) { typeChar(ch) }.apply { minWidth = 92; setPadding(8, 14, 8, 14) }, lp(0f, 5))
            kbd.addView(row)
        }
        val last = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        last.addView(pill("Space", 18f) { typeChar(' ') }.apply { minWidth = 220 }, lp(0f, 5))
        last.addView(pill("⌫", 18f) { backspace() }, lp(0f, 5))
        last.addView(pill("Clear", 18f) { typed.clear(); pushText(false) }, lp(0f, 5))
        last.addView(pill("Search ↵", 18f) { submit() }, lp(0f, 5))
        last.addView(pill("Cancel", 18f) { closeKeyboard() }, lp(0f, 5))
        kbd.addView(last)
        root.addView(kbd, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
    }

    private fun openKeyboard(label: String, value: String) {
        typed.clear(); typed.append(value)
        kbdLabel.text = "$label  ·  type on the phone remote too"
        kbdOpen = true
        closeToolbar()
        kbd.visibility = View.VISIBLE
        refreshKbd()
        // start on the first letter row
        (((kbd.getChildAt(3)) as? LinearLayout)?.getChildAt(0))?.requestFocus()
    }

    private fun closeKeyboard() {
        kbdOpen = false
        kbd.visibility = View.GONE
    }

    private fun refreshKbd() { kbdText.text = typed.toString() + "▏" }

    private fun typeChar(c: Char) { typed.append(c); pushText(false) }
    private fun backspace() { if (typed.isNotEmpty()) typed.deleteCharAt(typed.length - 1); pushText(false) }
    private fun submit() { pushText(true); closeKeyboard() }

    /** Put the text into the page's own field (every time, so suggestions follow along). */
    private fun pushText(submit: Boolean) {
        refreshKbd()
        web.evaluateJavascript("window.__tvos&&__tvos.setText(${JSONObject.quote(typed.toString())},$submit)", null)
    }

    /** From the phone: set the whole text, or press a named key. */
    private val remote = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val cmd = i.getStringExtra("cmd") ?: return
            val text = i.getStringExtra("b64")?.let { String(Base64.decode(it, Base64.DEFAULT), Charsets.UTF_8) }
            ui.post { handleRemote(cmd, text) }
        }
    }

    private fun handleRemote(cmd: String, text: String?) {
        when (cmd) {
            "text", "enter", "backspace", "clear" -> {
                val apply = {
                    when (cmd) {
                        "text" -> { typed.clear(); typed.append(text ?: ""); pushText(false) }
                        "backspace" -> backspace()
                        "clear" -> { typed.clear(); pushText(false) }
                        "enter" -> { if (text != null) { typed.clear(); typed.append(text) }; submit() }
                    }
                }
                if (kbdOpen) apply() else {
                    web.evaluateJavascript("window.__tvos?__tvos.pending():''") { r ->
                        val info = parse(r)
                        if (info != null && info.optString("kind") == "input") {
                            openKeyboard(info.optString("label"), info.optString("value")); apply()
                        } else flash("Pick a search box on the TV first (arrows, then OK).", 3000)
                    }
                }
            }
            "toolbar" -> if (toolbarOpen) closeToolbar() else openToolbar()
            "zoom+" -> setWidth(widthIdx - 1)
            "zoom-" -> setWidth(widthIdx + 1)
            "reload" -> web.reload()
            "back" -> goBack()
            "mode" -> setPointerMode(!pointerMode)
            "ua" -> toggleUa()
            "lite" -> toggleLite()
            "up", "down", "left", "right" -> web.evaluateJavascript("window.__tvos&&__tvos.nav('$cmd')", null)
            "ok" -> activate()
            "pageup" -> scrollPage(-(root.height * 0.75f).toInt())
            "pagedown" -> scrollPage((root.height * 0.75f).toInt())
        }
    }

    private fun leaveFullscreen() {
        customView?.let { root.removeView(it) }
        customView = null
        customCallback = null
        web.visibility = View.VISIBLE
    }

    private fun count(msg: String) {
        ui.post {
            blockedCount++
            flash("$msg ($blockedCount blocked)", 2200)
        }
    }

    private fun flash(text: String, ms: Long) {
        ui.post {
            note.text = text
            note.visibility = View.VISIBLE
            ui.removeCallbacks(hideNote)
            ui.postDelayed(hideNote, ms)
        }
    }

    private val hideNote = Runnable { note.visibility = View.GONE }

    private fun hideBars() {
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onResume() { super.onResume(); web.onResume() }
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        try { unregisterReceiver(remote) } catch (e: Exception) {}
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    /** The visible pointer. It fades after a few quiet seconds. */
    private inner class CursorView(c: Context) : View(c) {
        private var alphaNow = 1f
        private var pulseUntil = 0L
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }
        private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF111111.toInt(); style = Paint.Style.STROKE; strokeWidth = 3f }
        private val fade = Runnable { alphaNow = 0.35f; invalidate() }
        private val arrow = Path().apply {
            moveTo(0f, 0f); lineTo(0f, 34f); lineTo(9f, 26f); lineTo(15f, 40f); lineTo(21f, 37f); lineTo(15f, 24f); lineTo(27f, 24f); close()
        }

        var cx = 0f
        var cy = 0f

        init {
            isFocusable = false
            isClickable = false
            post { cx = width / 2f; cy = height / 2f; wake() }
        }

        fun wake() { alphaNow = 1f; invalidate(); removeCallbacks(fade); postDelayed(fade, 4000) }
        fun pulse() { pulseUntil = SystemClock.uptimeMillis() + 160; wake() }

        override fun onDraw(c: Canvas) {
            if (!cursorOn) return
            fill.alpha = (255 * alphaNow).toInt()
            edge.alpha = (255 * alphaNow).toInt()
            val pulsing = SystemClock.uptimeMillis() < pulseUntil
            val s = if (pulsing) 1.25f else 1f
            c.save()
            c.translate(cx, cy)
            c.scale(s, s)
            c.drawPath(arrow, fill)
            c.drawPath(arrow, edge)
            c.restore()
            if (pulsing) postInvalidateDelayed(40)
        }
    }

    companion object {
        private const val EDGE = 40f
        const val ACTION = "app.couchtv.launcher.WEBAPP"
        // page layout widths in CSS px: smaller = bigger text. 960 = 100%
        private val WIDTHS = intArrayOf(640, 800, 960, 1100, 1280, 1440, 1600)

        // Runs on every page: window.open does nothing, links never open a new tab, and full-screen
        // ad layers laid over the whole page (with no video in them) are removed.
        private const val GUARD_JS = "(function(){" +
            "if(window.__tvosGuard)return;window.__tvosGuard=1;" +
            "try{window.open=function(){return null;};}catch(e){}" +
            "try{Object.defineProperty(window,'open',{value:function(){return null;},writable:false});}catch(e){}" +
            "document.addEventListener('click',function(ev){var a=ev.target&&ev.target.closest?ev.target.closest('a'):null;" +
            "if(a&&a.target&&a.target!=='_self'){a.target='_self';}},true);" +
            "function clean(){try{var vw=innerWidth,vh=innerHeight;var els=document.body?document.body.children:[];" +
            "for(var i=0;i<els.length;i++){var el=els[i];var cs=getComputedStyle(el);" +
            "if((cs.position==='fixed'||cs.position==='absolute')&&parseInt(cs.zIndex||'0',10)>=1000){" +
            "var r=el.getBoundingClientRect();" +
            "if(r.width>vw*0.6&&r.height>vh*0.6&&!el.querySelector('video,iframe[src*=\"player\"],iframe[src*=\"embed\"],canvas')&&!el.matches('video')){el.remove();}}}}catch(e){}}" +
            "setInterval(clean,1500);" +
            "})();"
    }
}

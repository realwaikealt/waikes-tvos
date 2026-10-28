package app.couchtv.launcher

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
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
    private var lastKey = 0
    private var heldSince = 0L

    private val blocklist: Blocklist by lazy {
        Blocklist(try { assets.open("blocklist.txt").bufferedReader().readLines() } catch (e: Exception) { emptyList() })
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        startUrl = intent.getStringExtra("url").orEmpty()
        allowedHosts = (intent.getStringExtra("hosts") ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }
        val desktop = intent.getBooleanExtra("desktop", true)

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        web = WebView(this)
        setUpWebView(web, desktop)
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        cursor = CursorView(this)
        root.addView(cursor, FrameLayout.LayoutParams(-1, -1))
        note = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            setPadding(36, 18, 36, 18)
            setBackgroundColor(0xCC000000.toInt())
            visibility = View.GONE
        }
        root.addView(note, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = 40 })
        setContentView(root)
        hideBars()

        if (!Blocklist.isWebScheme(startUrl) || blocklist.isBlocked(startUrl)) {
            web.loadDataWithBaseURL(null, blockedPage(startUrl), "text/html", "utf-8", null)
        } else {
            web.loadUrl(startUrl)
        }
        flash("Arrows move the pointer. OK clicks. Back goes back.", 4000)
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
            if (desktop) userAgentString = userAgentString.replace("; wv", "").replace(Regex("Version/\\d+\\.\\d+ "), "")
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

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { view.evaluateJavascript(GUARD_JS, null) }
            override fun onPageFinished(view: WebView, url: String) { view.evaluateJavascript(GUARD_JS, null) }
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
        if (e.action != KeyEvent.ACTION_DOWN && e.action != KeyEvent.ACTION_UP) return super.dispatchKeyEvent(e)
        when (code) {
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                if (e.action == KeyEvent.ACTION_DOWN) {
                    if (e.repeatCount == 0 || code != lastKey) heldSince = SystemClock.uptimeMillis()
                    lastKey = code
                    cursorOn = true
                    val held = SystemClock.uptimeMillis() - heldSince
                    val step = (28 + (held / 60).coerceAtMost(60)).toInt()
                    move(code, step)
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_BUTTON_A -> {
                if (e.action == KeyEvent.ACTION_DOWN && e.repeatCount == 0) click()
                return true
            }
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_BUTTON_Y -> {
                if (e.action == KeyEvent.ACTION_UP) { cursorOn = !cursorOn; cursor.invalidate(); flash(if (cursorOn) "Pointer on" else "Pointer off", 1200) }
                return true
            }
        }
        return super.dispatchKeyEvent(e)
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
        if (customView == null) web.scrollBy(0, dy)
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
            customView != null -> customCallback?.onCustomViewHidden() ?: leaveFullscreen()
            web.canGoBack() -> web.goBack()
            else -> finish()
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

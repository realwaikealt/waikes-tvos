package app.couchtv.launcher

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothA2dp
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.location.LocationManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

/**
 * AirPods on the TV.
 *
 * Apple's own pop-up is an iPhone feature and cannot be triggered from Android, but the AirPods broadcast the
 * same Bluetooth LE "proximity pairing" packet whoever is listening (AirPodsParser). While the Home screen is
 * in front, in a low-power scan filtered to that one packet, this class notices AirPods with an open case
 * close to the TV and shows our own Apple-style sheet: Connect / Not now. Connect finds the AirPods with a
 * normal Bluetooth discovery, pairs them (createBond) and lets Android route sound to them (A2DP).
 *
 * Privacy and power: scanning runs only while Home is in front, the screen is on and the feature is on;
 * only Apple's 0x07 packets pass the filter; nothing is stored except counts and the last signal strength.
 * Bluetooth addresses are never kept.
 */
class AirPodsWatcher(private val act: Activity, private val host: FrameLayout) {
    private val main = Handler(Looper.getMainLooper())
    private val prefs = act.getSharedPreferences("airpods", Context.MODE_PRIVATE)
    private val adapter: BluetoothAdapter? = (act.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    // ---- settings (the TV page's Settings > AirPods & Bluetooth audio) ----
    var enabled: Boolean
        get() = prefs.getBoolean("on", true)
        set(v) { prefs.edit().putBoolean("on", v).apply(); if (!v) { stopScan(); dismiss(false) } else refreshScan() }
    /** 0 = very close (> -45 dBm), 1 = near the TV (> -55, default), 2 = same room (> -65). */
    var sensitivity: Int
        get() = prefs.getInt("sens", 1).coerceIn(0, 2)
        set(v) { prefs.edit().putInt("sens", v.coerceIn(0, 2)).apply() }
    private fun threshold() = when (sensitivity) { 0 -> -45; 2 -> -65; else -> -55 }

    // ---- state ----
    private var resumed = false
    private var scanning = false
    private var screenOn = true
    private var adsSeen = 0
    private var adsNear = 0
    private var lastRssi = 0
    private var lastModel = ""
    private var nearHits = 0
    private var nearSince = 0L
    private var quietUntil = 0L

    enum class Flow { IDLE, LOOKING, BONDING, CONNECTING, CONNECTED, FAILED }
    private var flow = Flow.IDLE
    private var flowText = ""
    private var flowName = ""
    private var flowToken = 0
    private var target: BluetoothDevice? = null
    private var a2dp: BluetoothA2dp? = null

    // ---- the sheet ----
    private var sheet: FrameLayout? = null
    private var card: LinearLayout? = null
    private var titleV: TextView? = null
    private var subV: TextView? = null
    private var infoV: TextView? = null
    private var btns: LinearLayout? = null
    private var focusI = 0
    private var labels = listOf("Connect", "Not now")
    private var shownAd: AirPodsParser.Ad? = null

    // ------------------------------------------------------------------ lifecycle (called by MainActivity)

    fun onResume() {
        resumed = true
        screenOn = (act.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
        try { act.registerReceiver(screenReceiver, IntentFilter().apply { addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON) }) } catch (e: Exception) {}
        refreshScan()
    }

    fun onPause() {
        resumed = false
        try { act.unregisterReceiver(screenReceiver) } catch (e: Exception) {}
        stopScan()
        if (sheet != null || flow != Flow.IDLE) { cancelFlow(); dismiss(false) }
    }

    fun onDestroy() { onPause() }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            screenOn = i.action == Intent.ACTION_SCREEN_ON
            if (screenOn) refreshScan() else { stopScan(); cancelFlow(); dismiss(false) }
        }
    }

    // ------------------------------------------------------------------ permissions and state

    fun hasPermission(): Boolean {
        fun ok(p: String) = act.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
        if (!ok(Manifest.permission.ACCESS_FINE_LOCATION)) return false
        if (Build.VERSION.SDK_INT >= 31) return ok("android.permission.BLUETOOTH_SCAN") && ok("android.permission.BLUETOOTH_CONNECT")
        return true
    }

    /** Ask for the permissions with the system dialog (works with the TV remote). */
    fun askPermission() {
        main.post {
            val want = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION)
            if (Build.VERSION.SDK_INT >= 31) { want += "android.permission.BLUETOOTH_SCAN"; want += "android.permission.BLUETOOTH_CONNECT" }
            act.requestPermissions(want.toTypedArray(), 77)
        }
    }

    private fun locationOn(): Boolean = try {
        (act.getSystemService(Context.LOCATION_SERVICE) as LocationManager).isLocationEnabled
    } catch (e: Exception) { true }

    private fun btOn() = adapter?.isEnabled == true

    @SuppressLint("MissingPermission")
    private fun refreshScan() {
        main.post {
            if (resumed && screenOn && enabled && flow == Flow.IDLE && sheet == null) startScan() else if (!(resumed && screenOn && enabled)) stopScan()
        }
    }

    // ------------------------------------------------------------------ the low-power scan

    private val scanCb = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, r: ScanResult) {
            val ad = AirPodsParser.parse(r.scanRecord?.getManufacturerSpecificData(AirPodsParser.APPLE)) ?: return
            main.post { onAd(ad, r.rssi) }
        }

        override fun onScanFailed(errorCode: Int) { scanning = false }
    }

    @SuppressLint("MissingPermission")
    private fun startScan() {
        if (scanning || !hasPermission() || !btOn()) return
        val sc = adapter?.bluetoothLeScanner ?: return
        try {
            val filter = ScanFilter.Builder()
                .setManufacturerData(AirPodsParser.APPLE, byteArrayOf(0x07), byteArrayOf(0xFF.toByte())).build()
            val st = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER).build()
            sc.startScan(listOf(filter), st, scanCb)
            scanning = true
        } catch (e: Exception) { scanning = false }
    }

    @SuppressLint("MissingPermission")
    private fun stopScan() {
        if (!scanning) return
        scanning = false
        try { adapter?.bluetoothLeScanner?.stopScan(scanCb) } catch (e: Exception) {}
    }

    private fun onAd(ad: AirPodsParser.Ad, rssi: Int) {
        adsSeen++
        lastRssi = rssi
        lastModel = ad.name
        if (rssi < threshold()) { nearHits = 0; return }
        adsNear++
        val now = System.currentTimeMillis()
        if (now - nearSince > 6000) { nearHits = 0 }
        if (nearHits == 0) nearSince = now
        nearHits++
        if (nearHits < 2 || now < quietUntil || sheet != null || flow != Flow.IDLE || !resumed || !screenOn) return
        if (connectedHeadset() != null) return   // already playing through some Bluetooth headset
        nearHits = 0
        show(ad)
    }

    // ------------------------------------------------------------------ what is connected, where sound goes

    @SuppressLint("MissingPermission")
    private fun bondedPods(): List<BluetoothDevice> = try {
        adapter?.bondedDevices?.filter { AirPodsParser.looksLikeApplePhones(it.name) } ?: emptyList()
    } catch (e: Exception) { emptyList() }

    /** Name of the Bluetooth device sound is going to, or null. */
    fun connectedHeadset(): String? {
        val am = act.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        for (d in am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (d.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) return d.productName?.toString()?.ifBlank { null } ?: "Bluetooth headphones"
        }
        return null
    }

    private fun outputLabel(): String {
        connectedHeadset()?.let { return "Bluetooth: $it" }
        val am = act.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val t = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }
        return when {
            t.contains(AudioDeviceInfo.TYPE_HDMI_ARC) || t.contains(AudioDeviceInfo.TYPE_HDMI) && !t.contains(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) -> "TV (HDMI sound bar or receiver)"
            else -> "TV speakers"
        }
    }

    fun statusJson(): String {
        val o = JSONObject()
        o.put("available", adapter != null)
        o.put("enabled", enabled)
        o.put("sens", sensitivity)
        o.put("threshold", threshold())
        o.put("permission", hasPermission())
        o.put("bluetooth", btOn())
        o.put("location", locationOn())
        o.put("scanning", scanning)
        o.put("output", outputLabel())
        o.put("connected", connectedHeadset() ?: JSONObject.NULL)
        o.put("bonded", JSONArray().also { a -> bondedPods().forEach { try { a.put(it.name) } catch (e: Exception) {} } })
        o.put("flow", JSONObject().put("state", flow.name.lowercase()).put("text", flowText).put("name", flowName))
        o.put("ads", JSONObject().put("seen", adsSeen).put("near", adsNear).put("rssi", lastRssi).put("model", lastModel))
        return o.toString()
    }

    /** The TV's own Bluetooth devices page. */
    fun openBluetoothSettings(): Boolean {
        val tries = listOf(
            Intent("android.settings.BLUETOOTH_SETTINGS"),
            Intent().setClassName("com.android.tv.settings", "com.android.tv.settings.accessories.AddAccessoryActivity"),
            Intent().setClassName("com.android.tv.settings", "com.android.tv.settings.accessories.BluetoothAccessoryActivity")
        )
        for (i in tries) {
            try { act.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return true } catch (e: Exception) {}
        }
        return try { act.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true } catch (e: Exception) { false }
    }

    // ------------------------------------------------------------------ pairing flow

    /** From the Settings page (no sheet) or the sheet's Connect button. */
    @SuppressLint("MissingPermission")
    fun startPairing(wantName: String? = null) {
        main.post { beginPairing(wantName) }
    }

    @SuppressLint("MissingPermission")
    private fun beginPairing(wantName: String?) {
        cancelFlow()
        val tok = ++flowToken
        flowName = wantName ?: ""
        val ad = adapter
        if (ad == null) { fail(tok, "This TV has no Bluetooth."); return }
        if (!hasPermission()) { fail(tok, "Allow “Nearby devices and location” for this app first (Settings > AirPods & Bluetooth audio > Allow)."); return }
        if (!ad.isEnabled) {
            try { @Suppress("DEPRECATION") ad.enable() } catch (e: Exception) {}
            setFlow(Flow.LOOKING, "Turning Bluetooth on…")
            main.postDelayed({ if (tok == flowToken) { if (ad.isEnabled) beginPairing(wantName) else fail(tok, "Bluetooth is off. Turn it on in the TV’s Bluetooth settings.") } }, 3500)
            return
        }
        stopScan()
        registerFlowReceiver()
        getA2dp()
        // already paired from before? then just connect
        val known = bondedPods().firstOrNull()
        if (known != null) {
            target = known
            flowName = try { known.name } catch (e: Exception) { flowName }
            if (isA2dpConnected(known)) { done(tok); return }
            setFlow(Flow.CONNECTING, "Connecting to ${flowName}…")
            tryConnect(known)
            main.postDelayed({ if (tok == flowToken && flow == Flow.CONNECTING) {
                // not connecting by itself: the AirPods may be connected to the phone; ask them to be found again
                beginDiscovery(tok)
            } }, 9000)
            return
        }
        beginDiscovery(tok)
    }

    @SuppressLint("MissingPermission")
    private fun beginDiscovery(tok: Int) {
        val ad = adapter ?: return
        if (tok != flowToken) return
        setFlow(Flow.LOOKING, "Looking for your AirPods…\nOpen the case lid next to the TV, then hold the button on the back until the light flashes white.")
        try { if (ad.isDiscovering) ad.cancelDiscovery(); ad.startDiscovery() } catch (e: Exception) { fail(tok, "Bluetooth would not start looking."); return }
        main.postDelayed({
            if (tok == flowToken && flow == Flow.LOOKING) fail(tok, "I couldn’t find them.\nOpen the case lid, hold the button on the back until the light flashes white, keep them close, and try again.")
        }, 35000)
    }

    private var flowRegistered = false
    private fun registerFlowReceiver() {
        if (flowRegistered) return
        flowRegistered = true
        val f = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_FOUND)
            addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
            addAction(BluetoothA2dp.ACTION_CONNECTION_STATE_CHANGED)
        }
        act.registerReceiver(flowReceiver, f)
    }

    private fun unregisterFlowReceiver() {
        if (!flowRegistered) return
        flowRegistered = false
        try { act.unregisterReceiver(flowReceiver) } catch (e: Exception) {}
    }

    private val flowReceiver = object : BroadcastReceiver() {
        @SuppressLint("MissingPermission")
        override fun onReceive(c: Context, i: Intent) {
            val tok = flowToken
            val dev: BluetoothDevice? = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
            when (i.action) {
                BluetoothDevice.ACTION_FOUND -> {
                    if (flow != Flow.LOOKING || dev == null) return
                    val name = try { dev.name } catch (e: Exception) { null }
                    if (!AirPodsParser.looksLikeApplePhones(name)) return
                    try { adapter?.cancelDiscovery() } catch (e: Exception) {}
                    target = dev
                    flowName = name ?: "AirPods"
                    setFlow(Flow.BONDING, "Pairing with $flowName…")
                    if (dev.bondState == BluetoothDevice.BOND_BONDED) { setFlow(Flow.CONNECTING, "Connecting to $flowName…"); tryConnect(dev) }
                    else if (!dev.createBond()) fail(tok, "Pairing didn’t start. Hold the button on the back of the case until the light flashes white, then try again.")
                    main.postDelayed({ if (tok == flowToken && (flow == Flow.BONDING)) fail(tok, "Pairing took too long. Close the case, open it again and hold the button on the back until the light flashes white.") }, 25000)
                }
                BluetoothDevice.ACTION_BOND_STATE_CHANGED -> {
                    if (dev == null || dev.address != target?.address) return
                    val st = i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR)
                    if (st == BluetoothDevice.BOND_BONDED && flow == Flow.BONDING) {
                        setFlow(Flow.CONNECTING, "Connecting to $flowName…")
                        main.postDelayed({ tryConnect(dev) }, 1500)
                        main.postDelayed({ if (tok == flowToken && flow == Flow.CONNECTING) {
                            if (isA2dpConnected(dev)) done(tok) else fail(tok, "Paired, but sound didn’t switch over. Open Bluetooth audio and choose $flowName.")
                        } }, 15000)
                    } else if (st == BluetoothDevice.BOND_NONE && flow == Flow.BONDING) {
                        fail(tok, "Pairing was refused. Hold the button on the back of the case until the light flashes white and try again.")
                    }
                }
                BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> { /* the 35 s timer reports the failure */ }
                BluetoothA2dp.ACTION_CONNECTION_STATE_CHANGED -> {
                    val st = i.getIntExtra(BluetoothProfile.EXTRA_STATE, -1)
                    if (st == BluetoothProfile.STATE_CONNECTED && dev != null && dev.address == target?.address && flow != Flow.CONNECTED) done(tok)
                }
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun getA2dp() {
        if (a2dp != null) return
        try {
            adapter?.getProfileProxy(act, object : BluetoothProfile.ServiceListener {
                override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) { if (profile == BluetoothProfile.A2DP) a2dp = proxy as BluetoothA2dp }
                override fun onServiceDisconnected(profile: Int) { if (profile == BluetoothProfile.A2DP) a2dp = null }
            }, BluetoothProfile.A2DP)
        } catch (e: Exception) {}
    }

    @SuppressLint("MissingPermission")
    private fun isA2dpConnected(d: BluetoothDevice): Boolean = try {
        a2dp?.connectedDevices?.any { it.address == d.address } == true
    } catch (e: Exception) { false }

    /** Asks the A2DP service to connect. The method is hidden on newer Android; if it is refused, Android's own
     *  auto-connect after pairing (and the Bluetooth page) still work. */
    private fun tryConnect(d: BluetoothDevice) {
        try {
            val m = BluetoothA2dp::class.java.getDeclaredMethod("connect", BluetoothDevice::class.java)
            m.isAccessible = true
            m.invoke(a2dp ?: return, d)
        } catch (e: Throwable) {
            lastReflectFail = e.javaClass.simpleName
        }
    }
    private var lastReflectFail = ""

    @SuppressLint("MissingPermission")
    private fun stopDiscovery() { try { adapter?.cancelDiscovery() } catch (e: Exception) {} }

    private fun setFlow(f: Flow, text: String) {
        flow = f; flowText = text
        paintFlow()
    }

    private fun done(tok: Int) {
        if (tok != flowToken) return
        setFlow(Flow.CONNECTED, "Connected. Sound now plays through ${flowName.ifBlank { "your AirPods" }}.")
        unregisterFlowReceiver()
        quietUntil = System.currentTimeMillis() + 10 * 60_000
        if (sheet != null) main.postDelayed({ if (tok == flowToken) { dismiss(true); flow = Flow.IDLE; refreshScan() } }, 3500)
    }

    private fun fail(tok: Int, why: String) {
        if (tok != flowToken) return
        stopDiscovery()
        unregisterFlowReceiver()
        setFlow(Flow.FAILED, why)
    }

    @SuppressLint("MissingPermission")
    fun cancelFlow() {
        flowToken++
        try { adapter?.cancelDiscovery() } catch (e: Exception) {}
        unregisterFlowReceiver()
        if (flow != Flow.IDLE) { flow = Flow.IDLE; flowText = "" }
        target = null
    }

    fun cancelFlowFromPage() { main.post { cancelFlow(); dismiss(true); refreshScan() } }

    // ------------------------------------------------------------------ the Apple-style sheet

    private fun px(n: Number) = Ui.px(act, n)

    private class Buds(c: Context) : View(c) {
        private val p = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(cv: Canvas) {
            val w = width.toFloat(); val h = height.toFloat()
            p.style = Paint.Style.FILL; p.color = Ui.CHIP
            cv.drawCircle(w / 2, h / 2, w / 2, p)
            p.color = Color.WHITE
            for (s in intArrayOf(-1, 1)) {
                val cx = w / 2 + s * w * 0.16f
                cv.drawOval(RectF(cx - w * 0.095f, h * 0.24f, cx + w * 0.095f, h * 0.50f), p)
                val x0 = if (s < 0) cx - w * 0.095f else cx + w * 0.095f - w * 0.06f
                cv.drawRoundRect(RectF(x0, h * 0.40f, x0 + w * 0.06f, h * 0.76f), w * 0.03f, w * 0.03f, p)
            }
        }
    }

    private fun txt(t: String, size: Int, weight: Int, color: Int) = TextView(act).apply {
        text = t
        setTextColor(color)
        setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, Ui.sp(act, size))
        typeface = Ui.font(act, weight)
    }

    private fun show(ad: AirPodsParser.Ad) {
        if (sheet != null) return
        shownAd = ad
        labels = listOf("Connect", "Not now")
        focusI = 0
        val dim = FrameLayout(act).apply { setBackgroundColor(0x66000000) }   // a quiet dim, not a blur
        val c = LinearLayout(act).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = Ui.panel(act, 44, Ui.PANEL)
            setPadding(px(56), px(44), px(56), px(40))
            elevation = px(24).toFloat()
        }
        val glyph = Buds(act)
        c.addView(glyph, LinearLayout.LayoutParams(px(120), px(120)).apply { bottomMargin = px(20) })
        titleV = txt(ad.name, 40, 700, Ui.TEXT).also { it.gravity = Gravity.CENTER; it.letterSpacing = -0.02f }
        c.addView(titleV)
        subV = txt("Case open next to the TV", 24, 450, Ui.TEXT_2).also { it.gravity = Gravity.CENTER; it.setPadding(0, px(6), 0, 0) }
        c.addView(subV)
        infoV = txt(batteryLine(ad), 22, 500, Ui.TEXT_3).also { it.gravity = Gravity.CENTER; it.setPadding(0, px(10), 0, 0) }
        c.addView(infoV)
        btns = LinearLayout(act).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        c.addView(btns, LinearLayout.LayoutParams(-2, -2).apply { topMargin = px(32) })
        dim.addView(c, FrameLayout.LayoutParams(px(760), -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = px(72) })
        host.addView(dim, FrameLayout.LayoutParams(-1, -1))
        sheet = dim; card = c
        paintButtons()
        dim.alpha = 0f
        dim.animate().alpha(1f).setDuration(Ui.MED).setInterpolator(Ui.OUT).start()
        c.post { Ui.enter(c, 0.5f, 1f, 0.9f, px(56).toFloat()) }
        stopScan()
    }

    private fun batteryLine(ad: AirPodsParser.Ad): String {
        val parts = mutableListOf<String>()
        ad.left?.let { parts += "Left $it%" }
        ad.right?.let { parts += "Right $it%" }
        ad.case?.let { parts += "Case $it%" }
        return parts.joinToString("   ")
    }

    private fun paintButtons() {
        val b = btns ?: return
        b.removeAllViews()
        labels.forEachIndexed { i, l ->
            val on = i == focusI
            val t = txt(l, 28, 650, if (on) Ui.ON_WHITE else Ui.TEXT).also {
                it.gravity = Gravity.CENTER
                it.background = Ui.pillBg(act, on, 36)
                it.setPadding(px(54), 0, px(54), 0)
                it.minimumWidth = px(220)
                it.scaleX = if (on) 1.04f else 1f; it.scaleY = it.scaleX
            }
            b.addView(t, LinearLayout.LayoutParams(-2, px(72)).apply { if (i > 0) leftMargin = px(18) })
        }
    }

    private fun paintFlow() {
        val s = sheet ?: return
        val busy = flow == Flow.LOOKING || flow == Flow.BONDING || flow == Flow.CONNECTING
        titleV?.text = when (flow) {
            Flow.CONNECTED -> "Connected"
            Flow.FAILED -> "Couldn’t connect"
            else -> shownAd?.name ?: "AirPods"
        }
        subV?.text = flowText.substringBefore('\n').ifBlank { "Case open next to the TV" }
        infoV?.text = if (flowText.contains('\n')) flowText.substringAfter('\n') else if (busy) "" else shownAd?.let { batteryLine(it) } ?: ""
        infoV?.visibility = if (infoV?.text.isNullOrBlank()) View.GONE else View.VISIBLE
        labels = when (flow) { Flow.FAILED -> listOf("Try again", "Close"); Flow.CONNECTED -> listOf("Done"); else -> listOf("Cancel") }
        focusI = 0
        paintButtons()
        s.requestLayout()
    }

    private fun activate() {
        when (flow) {
            Flow.IDLE -> if (focusI == 0) { setFlowForSheet(); startPairing(shownAd?.name) } else { quietUntil = System.currentTimeMillis() + 3 * 60_000; dismiss(true); refreshScan() }
            Flow.FAILED -> if (focusI == 0) startPairing(shownAd?.name) else { cancelFlow(); dismiss(true); refreshScan() }
            Flow.CONNECTED -> { dismiss(true); flow = Flow.IDLE; refreshScan() }
            else -> { cancelFlow(); dismiss(true); quietUntil = System.currentTimeMillis() + 60_000; refreshScan() }
        }
    }

    private fun setFlowForSheet() { /* the sheet repaints from setFlow() as soon as pairing starts */ }

    private fun dismiss(animate: Boolean) {
        val s = sheet ?: return
        sheet = null
        val c = card; card = null; shownAd = null
        if (!animate) { host.removeView(s); return }
        c?.let { Ui.leave(it, 0.94f, px(40).toFloat()) }
        s.animate().alpha(0f).setDuration(Ui.FAST).setInterpolator(Ui.OUT).withEndAction { host.removeView(s) }.start()
    }

    /** Remote keys while the sheet is up. Returns true when it used the key. */
    fun handleKey(e: KeyEvent): Boolean {
        if (sheet == null) return false
        if (e.action == KeyEvent.ACTION_DOWN) {
            when (e.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> { if (focusI > 0) { focusI--; paintButtons() } }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { if (focusI < labels.size - 1) { focusI++; paintButtons() } }
                else -> {}
            }
        } else if (e.action == KeyEvent.ACTION_UP) {
            when (e.keyCode) {
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> activate()
                KeyEvent.KEYCODE_BACK -> { focusI = labels.size - 1; activate() }
                else -> {}
            }
        }
        return true   // the page behind does not move while the sheet is open
    }

    /** For tests: show the sheet as if a given advertisement had been heard. */
    fun demo(model: Int): Boolean {
        main.post { if (sheet == null && flow == Flow.IDLE) show(AirPodsParser.Ad(model, AirPodsParser.nameFor(model), true, 80, 90, 60, false, false, false, 1)) }
        return true
    }
}

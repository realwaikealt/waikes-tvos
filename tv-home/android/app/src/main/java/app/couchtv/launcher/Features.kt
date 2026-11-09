package app.couchtv.launcher

/** Build-time switches for parked features. Code stays in the project; these only decide whether it runs. */
object Features {
    /** AirPods pop-up and Bluetooth audio page (AirPodsWatcher). Parked 2026-11-08: did not work well enough. */
    const val AIRPODS = false
}

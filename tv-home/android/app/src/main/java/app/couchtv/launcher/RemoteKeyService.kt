package app.couchtv.launcher

import android.accessibilityservice.AccessibilityService
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * Sees remote keys before the system's own key handling does. For the four app buttons (Netflix,
 * Prime Video, YouTube, Apple TV) it opens the app and swallows the key; every other key is left alone.
 * Reads no screen content (canRetrieveWindowContent=false).
 */
class RemoteKeyService : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onKeyEvent(event: KeyEvent): Boolean {
        android.util.Log.d("TvosKeys", "key ${event.keyCode} action ${event.action} src ${event.source} dev ${event.deviceId}")
        IdleSaver.touch()
        val pkg = RemoteAppKeys.packageFor(event.keyCode) ?: return false
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            ScreenGuard.record(this, "remote app key", "key ${event.keyCode}")
            RemoteAppKeys.launch(this, pkg)
        }
        return true
    }
}

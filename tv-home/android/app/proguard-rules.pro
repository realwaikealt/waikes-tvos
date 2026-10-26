# The page calls these through window.TVOS.
-keepclassmembers class app.couchtv.launcher.MainActivity$Native {
    @android.webkit.JavascriptInterface <methods>;
}

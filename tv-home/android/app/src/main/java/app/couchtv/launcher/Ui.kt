package app.couchtv.launcher

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.view.animation.PathInterpolator

/**
 * The native side of the design tokens in docs/DESIGN-TOKENS.md, so the web-app overlays, the offline
 * screen and the splash feel like the TV home: same plum ground, same Night-glass panel, same white focus,
 * same Inter type, same spring. Sizes are written in "design px" (1920 x 1080 canvas, the TV page's rem = 16)
 * and scaled to the real screen, so 720p and 4K keep the proportions.
 */
object Ui {
    // colour
    val GROUND = Color.parseColor("#120D13")
    val PANEL = Color.parseColor("#221820")          // Night glass panel (Settings, About, PIN)
    val TILE = Color.parseColor("#1C1C21")           // a quiet tile on the ground
    val CHIP = 0x1AFFFFFF                            // rgba(255,255,255,.10): resting row / key
    val RING = 0x1AFFFFFF                            // the 1px inner rim on panels
    const val TEXT = 0xFFF5F5F7.toInt()
    const val TEXT_2 = 0xA3F5F5F7.toInt()            // 64% on the plum
    const val TEXT_3 = 0x6BF5F5F7                    // 42%
    const val ON_WHITE = 0xFF111111.toInt()          // text on the white focus fill
    const val WARN = 0xFFFF9F8A.toInt()

    // motion: the same curves as app.css (--spring, --out) and the same three lengths
    val SPRING = PathInterpolator(0.3f, 1.15f, 0.4f, 1f)
    val OUT = PathInterpolator(0.22f, 1f, 0.36f, 1f)
    const val FAST = 180L
    const val MED = 300L
    const val SLOW = 420L

    fun unit(c: Context) = c.resources.displayMetrics.widthPixels / 1920f
    fun px(c: Context, n: Number) = (n.toFloat() * unit(c)).toInt()
    fun pxf(c: Context, n: Number) = n.toFloat() * unit(c)
    /** Text size in px for a 1080p design size (the page's `font-size: 1.5625rem` is 25). */
    fun sp(c: Context, n: Number) = n.toFloat() * unit(c)

    private var inter: Typeface? = null
    private val weights = HashMap<Int, Typeface>()

    /** Inter (the TV page's face) at a weight; falls back to the system sans if the file is missing. */
    fun font(c: Context, weight: Int = 450): Typeface = weights.getOrPut(weight) {
        try {
            Typeface.Builder(c.assets, "fonts/inter.ttf").setFontVariationSettings("'wght' $weight").build()
                ?: Typeface.DEFAULT
        } catch (e: Exception) {
            Typeface.create("sans-serif", if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
        }
    }

    /** A panel like `.settings-panel`: plum fill, big radius, a hairline white rim. */
    fun panel(c: Context, radius: Number = 40, fill: Int = PANEL, top: Boolean = true, bottom: Boolean = true): GradientDrawable =
        GradientDrawable().apply {
            setColor(fill)
            val r = pxf(c, radius)
            cornerRadii = floatArrayOf(if (top) r else 0f, if (top) r else 0f, if (top) r else 0f, if (top) r else 0f,
                if (bottom) r else 0f, if (bottom) r else 0f, if (bottom) r else 0f, if (bottom) r else 0f)
            setStroke(maxOf(1, px(c, 1)), RING)
        }

    /** A pill like `.srow`: resting chip, or the white focus fill. */
    fun pillBg(c: Context, focused: Boolean, radius: Number = 28): GradientDrawable =
        GradientDrawable().apply { cornerRadius = pxf(c, radius); setColor(if (focused) Color.WHITE else CHIP) }

    /** Open: fade and scale in from where it came from, with the spring. */
    fun enter(v: View, originX: Float = 0.5f, originY: Float = 0f, from: Float = 0.94f, rise: Float = 0f) {
        v.animate().cancel()
        v.visibility = View.VISIBLE
        v.pivotX = v.width * originX; v.pivotY = v.height * originY
        if (v.width == 0) v.post { v.pivotX = v.width * originX; v.pivotY = v.height * originY }
        if (v.alpha >= 1f) { v.alpha = 0f; v.scaleX = from; v.scaleY = from; v.translationY = rise }
        v.animate().alpha(1f).scaleX(1f).scaleY(1f).translationY(0f).setDuration(SLOW).setInterpolator(SPRING).withEndAction(null).start()
    }

    /** Close: the same path back, shorter. Interruptible: starts from the current values. */
    fun leave(v: View, to: Float = 0.96f, fall: Float = 0f) {
        v.animate().cancel()
        v.animate().alpha(0f).scaleX(to).scaleY(to).translationY(fall).setDuration(FAST).setInterpolator(OUT)
            .withEndAction { v.visibility = View.GONE; v.alpha = 1f; v.scaleX = 1f; v.scaleY = 1f; v.translationY = 0f }.start()
    }

    /** Focus: the spring scale the TV page uses on rows (1.015) and tiles (1.04). */
    fun focusScale(v: View, on: Boolean, scale: Float = 1.04f) {
        v.animate().scaleX(if (on) scale else 1f).scaleY(if (on) scale else 1f).setDuration(MED).setInterpolator(SPRING).start()
    }
}

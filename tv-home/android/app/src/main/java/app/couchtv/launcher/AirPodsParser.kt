package app.couchtv.launcher

/**
 * Reads Apple's "proximity pairing" Bluetooth LE advertisement (company id 0x004C, message type 0x07).
 * AirPods and Beats send it while their case is open or they are out of the case; an iPhone shows its
 * pop-up from the same packet. Android's ScanRecord hands over the bytes AFTER the company id:
 *
 *   [0] 0x07 type   [1] length (0x19)   [2] prefix   [3..4] model (big endian, e.g. 0x0E20 = AirPods Pro)
 *   [5] status      [6] pod batteries (hi = one pod, lo = the other; 0..10 = 0..100 %, 0xF = unknown)
 *   [7] hi = charging flags, lo = case battery   [8] lid-open counter   [9] colour
 *
 * Which nibble is the left pod depends on a "flipped" bit in the status byte (bit 0x20): when it is set the
 * high nibble is the right pod. This is community reverse engineering, not an Apple document, so every value
 * is best-effort and a bad packet just returns null. Pure Kotlin, no Android classes, so it is unit tested.
 */
object AirPodsParser {
    const val APPLE = 0x004C

    data class Ad(
        val model: Int,
        val name: String,
        val isHeadset: Boolean,
        val left: Int?,    // percent, null = not reported
        val right: Int?,
        val case: Int?,
        val chargingLeft: Boolean,
        val chargingRight: Boolean,
        val chargingCase: Boolean,
        val lidCounter: Int
    )

    private val MODELS = mapOf(
        0x0220 to "AirPods",
        0x0F20 to "AirPods (2nd generation)",
        0x1320 to "AirPods (3rd generation)",
        0x1920 to "AirPods (4th generation)",
        0x1B20 to "AirPods (4th generation)",
        0x0E20 to "AirPods Pro",
        0x1420 to "AirPods Pro (2nd generation)",
        0x2420 to "AirPods Pro (2nd generation)",
        0x0A20 to "AirPods Max",
        0x1F20 to "AirPods Max",
        0x0320 to "Powerbeats3",
        0x0B20 to "Powerbeats Pro",
        0x0520 to "BeatsX",
        0x0620 to "Beats Solo3",
        0x0920 to "Beats Studio3",
        0x1020 to "Beats Flex",
        0x1120 to "Beats Studio Buds",
        0x1220 to "Beats Fit Pro",
        0x1620 to "Beats Studio Buds+",
        0x1720 to "Beats Solo Pro"
    )

    /** "AirPods Pro" style name for a model id; unknown Apple audio models still get a friendly name. */
    fun nameFor(model: Int): String = MODELS[model] ?: "AirPods"

    fun isKnown(model: Int) = MODELS.containsKey(model)

    private fun pct(n: Int): Int? = if (n in 0..10) n * 10 else null

    fun parse(d: ByteArray?): Ad? {
        if (d == null || d.size < 9) return null
        fun u(i: Int) = d[i].toInt() and 0xFF
        if (u(0) != 0x07) return null
        val len = u(1)
        if (len < 7 || len > 0x30) return null
        val model = (u(3) shl 8) or u(4)
        val flipped = (u(5) and 0x20) != 0
        val hi = pct(u(6) shr 4)
        val lo = pct(u(6) and 0x0F)
        val flags = u(7) shr 4
        val chL = (flags and (if (flipped) 0x02 else 0x01)) != 0
        val chR = (flags and (if (flipped) 0x01 else 0x02)) != 0
        return Ad(
            model = model,
            name = nameFor(model),
            isHeadset = true,
            left = if (flipped) hi else lo,
            right = if (flipped) lo else hi,
            case = pct(u(7) and 0x0F),
            chargingLeft = chL,
            chargingRight = chR,
            chargingCase = (flags and 0x04) != 0,
            lidCounter = u(8)
        )
    }

    /** Models whose name a bonded or discovered Bluetooth device would carry ("AirPods Pro" for any Pro). */
    fun looksLikeApplePhones(btName: String?): Boolean {
        val n = (btName ?: "").lowercase()
        return n.contains("airpods") || n.contains("beats") || n.contains("powerbeats")
    }
}

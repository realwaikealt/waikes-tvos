package app.couchtv.launcher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AirPodsParserTest {
    private fun hex(s: String) = s.split(" ").map { it.toInt(16).toByte() }.toByteArray()

    // Shapes taken from public write-ups of Apple's continuity "proximity pairing" message (0x07, length 0x19).
    @Test fun airPodsProOpenCase() {
        val ad = AirPodsParser.parse(hex("07 19 01 0E 20 2B 99 8F 01 00 45 12 12 12 12 12 12 12 12 12 12 12 12 12 12"))
        assertNotNull(ad)
        assertEquals(0x0E20, ad!!.model)
        assertEquals("AirPods Pro", ad.name)
        assertEquals(90, ad.left); assertEquals(90, ad.right)
        assertNull(ad.case)                         // 0xF = unknown
        assertFalse(ad.chargingLeft); assertFalse(ad.chargingRight)
        assertEquals(1, ad.lidCounter)
    }

    @Test fun batteryAndChargingNibbles() {
        // status 0x01 (not flipped): high nibble 7 = 70 %, low nibble 5 = 50 %; case 8 = 80 %, flags 5 = left + case charging
        val ad = AirPodsParser.parse(hex("07 19 01 13 20 01 75 58 02 00"))!!
        assertEquals("AirPods (3rd generation)", ad.name)
        assertEquals(50, ad.left); assertEquals(70, ad.right)
        assertEquals(80, ad.case)
        assertTrue(ad.chargingLeft); assertFalse(ad.chargingRight); assertTrue(ad.chargingCase)
    }

    @Test fun flippedSwapsThePods() {
        val ad = AirPodsParser.parse(hex("07 19 01 0F 20 21 75 A8 02 00"))!!   // flipped
        assertEquals(70, ad.left); assertEquals(50, ad.right)
        assertEquals(80, ad.case)
        assertTrue(ad.chargingLeft); assertFalse(ad.chargingRight)   // flags 0xA: bit 2 is "left" when flipped
    }

    @Test fun airPodsMaxAndBeats() {
        assertEquals("AirPods Max", AirPodsParser.parse(hex("07 19 01 0A 20 00 AA AA 00 00"))!!.name)
        assertEquals("Beats Solo3", AirPodsParser.parse(hex("07 19 01 06 20 00 AA AA 00 00"))!!.name)
    }

    @Test fun unknownModelStillGetsAFriendlyName() {
        val ad = AirPodsParser.parse(hex("07 19 01 99 20 00 AA AA 00 00"))!!
        assertEquals("AirPods", ad.name)
        assertFalse(AirPodsParser.isKnown(0x9920))
    }

    @Test fun otherAppleMessagesAndJunkAreIgnored() {
        assertNull(AirPodsParser.parse(hex("10 05 01 18 00 00")))        // nearby info
        assertNull(AirPodsParser.parse(hex("0F 05 90 00 00 00 00 00 00")))
        assertNull(AirPodsParser.parse(hex("07 19 01")))                 // too short
        assertNull(AirPodsParser.parse(null))
        assertNull(AirPodsParser.parse(hex("07 FF 01 0E 20 2B 99 8F 01 00")))   // absurd length
    }

    @Test fun deviceNames() {
        assertTrue(AirPodsParser.looksLikeApplePhones("Asher's AirPods Pro"))
        assertTrue(AirPodsParser.looksLikeApplePhones("Beats Studio Buds"))
        assertFalse(AirPodsParser.looksLikeApplePhones("TCL Remote"))
        assertFalse(AirPodsParser.looksLikeApplePhones(null))
    }
}

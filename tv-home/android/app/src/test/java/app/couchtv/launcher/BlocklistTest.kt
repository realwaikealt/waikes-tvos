package app.couchtv.launcher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class BlocklistTest {
    private val list = Blocklist(File("src/main/assets/blocklist.txt").readLines())

    @Test fun adNetworksAndSubdomainsAreBlocked() {
        assertTrue(list.isBlocked("https://doubleclick.net/x"))
        assertTrue(list.isBlocked("https://ad.doubleclick.net/x.js"))
        assertTrue(list.isBlocked("https://pagead2.googlesyndication.com/pagead/js"))
        assertTrue(list.isBlocked("https://www.propellerads.com/"))
        assertTrue(list.isBlocked("https://syndication.exoclick.com/ads"))
    }

    @Test fun adultSitesAndWordsAreBlocked() {
        assertTrue(list.isBlocked("https://www.pornhub.com/"))
        assertTrue(list.isBlocked("https://cdn.xvideos.com/a.jpg"))
        assertTrue(list.isBlocked("https://sexcams-live.example.org/"))      // word in the host
        assertTrue(list.isBlocked("https://example.org/watch/porn-clips"))   // /porn in the path
        assertTrue(list.isBlocked("https://best-hentai.example.net/"))
    }

    @Test fun normalSitesAreNotBlocked() {
        assertFalse(list.isBlocked("https://vidbox.wtf/home"))
        assertFalse(list.isBlocked("https://www.youtube.com/watch?v=1"))
        assertFalse(list.isBlocked("https://cdn.jsdelivr.net/npm/hls.js"))
        assertFalse(list.isBlocked("https://fonts.gstatic.com/s/inter.woff2"))
        assertFalse(list.isBlocked("https://www.wikipedia.org/"))
        assertFalse(list.isBlocked("https://example.com/"))
    }

    @Test fun allowRulesWinOverWords() {
        val b = Blocklist(listOf("h  cdn", "ok  good-cdn.com"))
        assertFalse(b.isBlocked("https://good-cdn.com/a.js"))
        assertFalse(b.isBlocked("https://x.good-cdn.com/a.js"))
        assertTrue(b.isBlocked("https://other-cdn.net/a.js"))
    }

    @Test fun domainRuleDoesNotMatchLookalikes() {
        val b = Blocklist(listOf("d  evil.com"))
        assertTrue(b.isBlocked("https://evil.com/"))
        assertTrue(b.isBlocked("https://a.evil.com/"))
        assertFalse(b.isBlocked("https://notevil.com/"))
        assertFalse(b.isBlocked("https://evil.com.example.org/"))
    }

    @Test fun commentsAndBlankLinesAreIgnored() {
        val b = Blocklist(listOf("", "# d evil.com", "   ", "d"))
        assertFalse(b.isBlocked("https://evil.com/"))
    }

    @Test fun registrableDomains() {
        assertEquals("example.com", Blocklist.registrable("www.example.com"))
        assertEquals("example.co.uk", Blocklist.registrable("a.b.example.co.uk"))
        assertEquals("vidbox.wtf", Blocklist.registrable("cdn.vidbox.wtf"))
        assertEquals("example.com", Blocklist.registrable("example.com"))
    }

    @Test fun redirectsStayOnTheSiteOrAllowedHosts() {
        val home = "https://vidbox.wtf/home"
        assertTrue(Blocklist.sameSite(home, "https://vidbox.wtf/movie/1", emptyList()))
        assertTrue(Blocklist.sameSite(home, "https://www.vidbox.wtf/x", emptyList()))
        assertFalse(Blocklist.sameSite(home, "https://other-site.com/landing", emptyList()))
        assertTrue(Blocklist.sameSite(home, "https://player.example.net/e/1", listOf("example.net")))
        assertFalse(Blocklist.sameSite(home, "https://examplexnet.com/", listOf("example.net")))
    }

    @Test fun onlyWebSchemesLoad() {
        assertTrue(Blocklist.isWebScheme("https://vidbox.wtf/"))
        assertTrue(Blocklist.isWebScheme("HTTP://vidbox.wtf/"))
        assertFalse(Blocklist.isWebScheme("intent://scan/#Intent;scheme=zxing;end"))
        assertFalse(Blocklist.isWebScheme("market://details?id=x"))
        assertFalse(Blocklist.isWebScheme("javascript:alert(1)"))
        assertFalse(Blocklist.isWebScheme("file:///sdcard/x"))
    }
}

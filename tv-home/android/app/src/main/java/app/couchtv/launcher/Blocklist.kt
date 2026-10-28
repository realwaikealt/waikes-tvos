package app.couchtv.launcher

import java.net.URI

/**
 * What the web apps refuse to load: ad and popunder networks, adult sites, and any page change that
 * leaves the site. The rules come from assets/blocklist.txt (see the top of that file). This class
 * has no Android in it, so it runs in plain unit tests.
 */
class Blocklist(lines: List<String>) {
    private val domains = HashSet<String>()
    private val hostWords = ArrayList<String>()
    private val urlText = ArrayList<String>()
    private val allowed = HashSet<String>()

    init {
        for (raw in lines) {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val parts = line.split(Regex("[ 	]+"), limit = 2)
            if (parts.size < 2) continue
            val v = parts[1].trim().lowercase()
            when (parts[0]) {
                "d" -> domains.add(v)
                "h" -> hostWords.add(v)
                "u" -> urlText.add(v)
                "ok" -> allowed.add(v)
            }
        }
    }

    /** True when [host] is [domain] or one of its subdomains. */
    private fun under(host: String, domain: String) = host == domain || host.endsWith(".$domain")

    fun isBlocked(url: String): Boolean {
        val lower = url.lowercase()
        val host = hostOf(lower) ?: return false
        if (allowed.any { under(host, it) }) return false
        if (domains.any { under(host, it) }) return true
        if (hostWords.any { host.contains(it) }) return true
        return urlText.any { lower.contains(it) }
    }

    companion object {
        fun hostOf(url: String): String? = try {
            URI(url.trim()).host?.lowercase()?.trimEnd('.')
        } catch (e: Exception) {
            null
        }

        // Second-level public suffixes that make the "registrable" part three labels (co.uk, com.au ...).
        private val SECOND = setOf("co", "com", "net", "org", "gov", "edu", "ac")

        /** example.com for www.example.com, example.co.uk for a.b.example.co.uk. */
        fun registrable(host: String): String {
            val p = host.lowercase().trimEnd('.').split('.')
            if (p.size <= 2) return p.joinToString(".")
            val take = if (p.size >= 3 && p[p.size - 2] in SECOND && p.last().length == 2) 3 else 2
            return p.takeLast(take).joinToString(".")
        }

        /** Whether a page change from [from] to [to] stays on the site (or a host the web app allows). */
        fun sameSite(from: String, to: String, allowedHosts: List<String>): Boolean {
            val a = hostOf(from) ?: return false
            val b = hostOf(to) ?: return false
            if (registrable(a) == registrable(b)) return true
            return allowedHosts.any { h ->
                val x = h.lowercase().trim().trimStart('.')
                x.isNotEmpty() && (b == x || b.endsWith(".$x") || registrable(b) == registrable(x))
            }
        }

        /** Only web pages: intent://, market://, file://, javascript: and the rest never load. */
        fun isWebScheme(url: String): Boolean {
            val u = url.trim().lowercase()
            return u.startsWith("http://") || u.startsWith("https://")
        }
    }
}

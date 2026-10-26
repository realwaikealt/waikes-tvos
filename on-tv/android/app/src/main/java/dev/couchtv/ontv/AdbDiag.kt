package dev.couchtv.ontv

import android.util.Base64
import android.util.Log
import java.io.DataInputStream
import java.io.OutputStream
import java.math.BigInteger
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.interfaces.RSAPublicKey
import javax.crypto.Cipher

/**
 * Step-by-step ADB handshake, written from scratch (not the library), logging every packet.
 * For a TV where "Allow debugging?" never appears: it shows whether adbd gets our public key and
 * what it answers. Uses the app's own key, so pressing Allow here also trusts the normal connection.
 *
 * Protocol: CNXN -> AUTH(TOKEN) -> AUTH(SIGNATURE) -> AUTH(TOKEN) again for an unknown key ->
 * AUTH(RSAPUBLICKEY, "<base64 android pubkey> <name>\0") -> adbd prompts -> CNXN once allowed.
 */
object AdbDiag {
    private const val TAG = "couchtv.adb"
    private const val A_CNXN = 0x4e584e43; private const val A_AUTH = 0x48545541; private const val A_STLS = 0x534c5453
    private val SHA1_PREFIX = byteArrayOf(0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14)

    @Volatile var lines: List<String> = emptyList(); private set
    @Volatile var running = false; private set

    private val out = mutableListOf<String>()
    private fun log(s: String) { Log.i(TAG, "diag: $s"); synchronized(out) { out += s; lines = out.toList() } }

    fun start(host: String, port: Int, waitSeconds: Int) {
        if (running) return
        running = true
        synchronized(out) { out.clear(); lines = emptyList() }
        Thread { try { run(host, port, waitSeconds) } catch (e: Throwable) { log("stopped: ${e.javaClass.simpleName}: ${e.message}") } finally { running = false } }.start()
    }

    private fun run(host: String, port: Int, waitSeconds: Int) {
        val (priv, pub) = Adb.keyPair()
        val keyText = pubkeyText(pub, "couch-tv")
        val keyBytes = Base64.decode(keyText.substringBefore(' '), Base64.DEFAULT)
        log("our key: ${keyBytes.size} bytes, fingerprint ${md5(keyBytes)} (the TV's dialog shows this)")
        Socket().use { s ->
            s.tcpNoDelay = true
            s.connect(InetSocketAddress(host, port), 3000)
            s.soTimeout = 15_000
            log("socket connected to $host:$port")
            val o = s.getOutputStream(); val i = DataInputStream(s.getInputStream())
            send(o, A_CNXN, 0x01000001, 256 * 1024, "host::features=shell_v2,cmd,stat_v2\u0000".toByteArray(), "CNXN v=0x01000001 maxdata=262144")
            var p = recv(i) ?: return
            if (p.cmd == A_CNXN) { log("adbd says connected without auth (key already trusted or adbd not secure)"); return }
            if (p.cmd == A_STLS) { log("adbd wants TLS here: this is a wireless-debugging port, not plain 5555"); return }
            if (p.cmd != A_AUTH || p.a0 != 1) { log("unexpected first reply"); return }
            val sig = sign(priv, p.data)
            send(o, A_AUTH, 2, 0, sig, "AUTH type=2 SIGNATURE (${sig.size} bytes)")
            p = recv(i) ?: return
            if (p.cmd == A_CNXN) { log("signature accepted: the key is already trusted"); return }
            if (p.cmd != A_AUTH) { log("unexpected reply to signature"); return }
            val payload = (keyText + "\u0000").toByteArray()
            send(o, A_AUTH, 3, 0, payload, "AUTH type=3 RSAPUBLICKEY (${payload.size} bytes, starts \"${keyText.take(16)}...\", ends \"${keyText.takeLast(10)}\\0\")")
            log("waiting up to $waitSeconds s: the TV should now show \"Allow USB debugging?\" with fingerprint ${md5(keyBytes)}")
            s.soTimeout = waitSeconds * 1000
            p = recv(i) ?: return
            if (p.cmd == A_CNXN) log("ALLOWED: adbd sent CNXN, banner \"${String(p.data).take(60)}\"")
        }
    }

    private class Packet(val cmd: Int, val a0: Int, val a1: Int, val data: ByteArray)

    private fun name(c: Int) = String(byteArrayOf(c.toByte(), (c shr 8).toByte(), (c shr 16).toByte(), (c shr 24).toByte()), Charsets.US_ASCII)

    private fun send(o: OutputStream, cmd: Int, a0: Int, a1: Int, data: ByteArray, what: String) {
        val h = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN).putInt(cmd).putInt(a0).putInt(a1).putInt(data.size)
            .putInt(data.sumOf { it.toInt() and 0xff }).putInt(cmd.inv()).array()
        o.write(h + data); o.flush()
        log("sent $what")
    }

    private fun recv(i: DataInputStream): Packet? {
        val t0 = System.currentTimeMillis()
        return try {
            val h = ByteArray(24); i.readFully(h)
            val b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN)
            val cmd = b.int; val a0 = b.int; val a1 = b.int; val len = b.int
            val data = ByteArray(len.coerceIn(0, 1 shl 20)); i.readFully(data)
            val type = if (cmd == A_AUTH) " type=$a0 (${mapOf(1 to "TOKEN", 2 to "SIGNATURE", 3 to "RSAPUBLICKEY")[a0] ?: "?"})" else ""
            log("recv ${name(cmd)}$type arg1=$a1 len=$len after ${System.currentTimeMillis() - t0} ms")
            Packet(cmd, a0, a1, data)
        } catch (e: java.net.SocketTimeoutException) { log("no packet for ${System.currentTimeMillis() - t0} ms (timed out)"); null }
        catch (e: java.io.EOFException) { log("adbd closed the connection after ${System.currentTimeMillis() - t0} ms"); null }
    }

    /** RSA PKCS#1 v1.5 over a SHA-1 DigestInfo whose hash is adbd's 20 byte token (what adb does). */
    private fun sign(k: PrivateKey, token: ByteArray): ByteArray =
        Cipher.getInstance("RSA/ECB/PKCS1Padding").apply { init(Cipher.ENCRYPT_MODE, k) }.doFinal(SHA1_PREFIX + token)

    /** Android's RSA public key format (as in ~/.android/adbkey.pub): base64 of the struct, a space, a name. */
    fun pubkeyText(pub: RSAPublicKey, name: String): String {
        val words = 64
        val r32 = BigInteger.ONE.shiftLeft(32)
        val n = pub.modulus
        val n0inv = r32.subtract(n.mod(r32).modInverse(r32)).toInt()
        val rr = BigInteger.ONE.shiftLeft(4096).mod(n)
        val b = ByteBuffer.allocate(4 + 4 + 256 + 256 + 4).order(ByteOrder.LITTLE_ENDIAN)
        b.putInt(words).putInt(n0inv)
        b.put(le(n, 256)); b.put(le(rr, 256))
        b.putInt(pub.publicExponent.toInt())
        return Base64.encodeToString(b.array(), Base64.NO_WRAP) + " " + name
    }

    private fun le(v: BigInteger, size: Int): ByteArray {
        val be = v.toByteArray().let { if (it.size > size) it.copyOfRange(it.size - size, it.size) else it }
        val out = ByteArray(size)
        for (k in be.indices) out[k] = be[be.size - 1 - k]
        return out
    }

    private fun md5(b: ByteArray) = MessageDigest.getInstance("MD5").digest(b).joinToString(":") { "%02X".format(it) }
}

package org.libdither.approver

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request as HttpRequest
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URLDecoder
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/** A pairing link, `dither-approver://pair?url=<the page's URL>&code=<code>`, as the page's QR or text gives it. */
object PairLink {
    class Parsed(val url: String, val code: String)

    private val CODE = Regex("^[A-Za-z0-9_-]{16,64}$")

    /** The link's URL and code, or null. `debug` lets http to the emulator's host through (Checks.managerUrl). */
    fun parse(text: String, debug: Boolean): Parsed? {
        val t = text.trim()
        if (!t.startsWith("dither-approver://pair?")) return null
        val q = t.substringAfter('?').substringBefore('#')
        val params = q.split('&').mapNotNull { p ->
            val i = p.indexOf('=')
            if (i <= 0) null else p.substring(0, i) to runCatching { URLDecoder.decode(p.substring(i + 1), "UTF-8") }.getOrNull()
        }.toMap()
        val url = params["url"]?.let { Checks.managerUrl(it, debug) } ?: return null
        val code = params["code"]?.takeIf { CODE.matches(it) } ?: return null
        return Parsed(url, code)
    }
}

object Pairings {
    val http: OkHttpClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
    private val DEVICE = Regex("^dev_[A-Za-z0-9_-]{16}$")

    fun randomHex(n: Int): String = ByteArray(n).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /**
     * Makes an identity key, sends its SPKI with the code, and keeps the pairing. Blocking: call off the main thread.
     * Throws with a message to show when the manager refuses or can't be reached (the new key is then deleted).
     */
    fun pair(c: Context, url: String, code: String, name: String): Pairing {
        val alias = "identity-" + randomHex(8)
        Keys.identity(c, alias)
        try {
            val spki = Keys.spki(alias)
            val body = JSONObject().put("code", code).put("name", name).put("publicKey", B64.std(spki)).toString()
            val req = HttpRequest.Builder().url("$url/approver/pair").post(body.toRequestBody("application/json".toMediaType())).build()
            val deviceId = http.newCall(req).execute().use { r ->
                val text = r.body?.string().orEmpty()
                if (!r.isSuccessful) {
                    val why = runCatching { JSONObject(text).optString("error") }.getOrNull()?.ifEmpty { null }
                    throw IllegalStateException("The manager refused the pairing (${r.code}${why?.let { ": $it" } ?: ""}). Codes last 10 minutes and work once.")
                }
                runCatching { JSONObject(text).getString("deviceId") }.getOrNull()?.takeIf { DEVICE.matches(it) }
                    ?: throw IllegalStateException("The manager's answer has no deviceId.")
            }
            val p = Pairing(deviceId, url, name, alias, WebAuthn.fingerprint(spki), System.currentTimeMillis())
            synchronized(Store) {
                Store.pairings.removeAll { it.deviceId == deviceId && it.url == url }
                Store.pairings += p
                Store.save()
            }
            return p
        } catch (e: Exception) {
            Keys.delete(alias)
            throw e
        }
    }

    /** Forgets a pairing here (the manager's page removes it there). Its passkeys stay until deleted. */
    fun unpair(p: Pairing) {
        Links.close(p.deviceId)
        synchronized(Store) {
            Store.pairings.remove(p)
            Store.save()
        }
        Keys.delete(p.keyAlias)
    }
}

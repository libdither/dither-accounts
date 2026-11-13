package org.libdither.approver

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** A request from the manager (docs/approver.md, Requests), parsed. Pure JVM: the unit tests build these. */
class Request(
    val id: String,
    val op: String,
    val accountId: String,
    val accountLabel: String,
    val accountKind: String,
    val reason: String,
    val rpId: String,
    val origin: String,
    val clientDataJSON: ByteArray,
    val expiresAt: Long,
    /** create: rp.id, rp.name, user.id (base64url), user.name, user.displayName, algs. */
    val create: Create?,
    /** get: credential ids (base64url); empty means any of this device's for rpId. */
    val allow: List<String>,
) {
    class Create(val rpId: String?, val rpName: String, val userId: String, val userName: String, val userDisplayName: String, val algs: List<Long>)

    companion object {
        /** Throws IllegalArgumentException on anything malformed; `id` is read first so a refusal can name it. */
        fun parse(o: JSONObject): Request {
            val id = o.optString("id").takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("no id")
            val op = o.optString("op")
            require(op == "create" || op == "get") { "op is $op" }
            val acct = o.optJSONObject("account") ?: JSONObject()
            val cdj = o.optString("clientDataJSON").takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("no clientDataJSON")
            val create = if (op == "create") {
                val c = o.optJSONObject("create") ?: throw IllegalArgumentException("create without its options")
                val rp = c.optJSONObject("rp") ?: JSONObject()
                val user = c.optJSONObject("user") ?: throw IllegalArgumentException("create without user")
                val algs = c.optJSONArray("algs")?.let { a -> (0 until a.length()).map { a.getLong(it) } } ?: listOf(WebAuthn.ES256)
                Create(rp.optString("id").ifEmpty { null }, rp.optString("name"), user.optString("id"), user.optString("name"), user.optString("displayName"), algs)
            } else null
            val allow = o.optJSONObject("get")?.optJSONArray("allow")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            return Request(
                id = id,
                op = op,
                accountId = acct.optString("id"),
                accountLabel = acct.optString("label").ifEmpty { acct.optString("id") },
                accountKind = acct.optString("kind"),
                reason = o.optString("reason"),
                rpId = o.optString("rpId"),
                origin = o.optString("origin"),
                clientDataJSON = B64.fromUrl(cdj),
                expiresAt = o.optLong("expiresAt", 0),
                create = create,
                allow = allow,
            )
        }
    }
}

/**
 * The device's checks before it shows a request (docs/approver.md, "The device checks before it shows"). Each returns
 * null when the request passes, or the line for the refusals log. The manager's authenticator has run its own (frame
 * policy, rpId rule, related origins) before sending; these repeat the ones a phone can.
 */
object Checks {
    private val ORIGIN = Regex("^https://([a-z0-9.-]+)(:[0-9]{1,5})?$")
    private val DOMAIN = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")

    /** clientDataJSON, the origin, https, and the origin's host against the rpId. */
    fun site(r: Request): String? {
        val text = utf8(r.clientDataJSON) ?: return "clientDataJSON is not UTF-8"
        val cd = runCatching { JSONObject(text) }.getOrNull() ?: return "clientDataJSON is not JSON"
        val want = "webauthn.${r.op}"
        if (cd.optString("type") != want) return "clientDataJSON type is ${cd.optString("type")}, not $want"
        if (cd.optString("origin") != r.origin) return "clientDataJSON origin ${cd.optString("origin")} is not the request's ${r.origin}"
        if (cd.optString("challenge").isEmpty()) return "clientDataJSON has no challenge"
        return originMatches(r.origin, r.rpId)
    }

    /**
     * The origin must be https, and its host the rpId or under it, or both under the same registrable domain (a related
     * origin: Schwab's rpId www.schwab.com asked from client.schwab.com). The registrable domain comes from the public
     * suffix list (OkHttp's), so a.github.io and b.github.io are not related. An rpId that is itself a public suffix
     * (com, co.uk, github.io) is refused.
     */
    fun originMatches(origin: String, rpId: String): String? {
        val m = ORIGIN.matchEntire(origin) ?: return if (origin.startsWith("https://")) "origin $origin is not a plain https origin" else "origin $origin is not https"
        val host = m.groupValues[1]
        if (!DOMAIN.matches(rpId)) return "rpId $rpId is not a domain"
        val rpSite = registrable(rpId) ?: return "rpId $rpId is a public suffix"
        if (host == rpId || host.endsWith(".$rpId")) return null
        val hostSite = registrable(host)
        if (hostSite != null && hostSite == rpSite) return null
        return "origin $origin is not on $rpId or its site"
    }

    /** The registrable domain (eTLD+1) of a host, or null for a public suffix, an IP, or a malformed host. */
    fun registrable(host: String): String? = runCatching {
        HttpUrl.Builder().scheme("https").host(host).build().topPrivateDomain()
    }.getOrNull()

    fun expired(r: Request, now: Long): Boolean = r.expiresAt <= now

    /** create's own options: rp.id (when given) is the rpId, ES256 is among the algorithms, user.id is 1 to 64 bytes. */
    fun createOptions(r: Request): String? {
        val c = r.create ?: return "create without its options"
        if (c.rpId != null && c.rpId != r.rpId) return "rp.id ${c.rpId} is not the rpId ${r.rpId}"
        if (WebAuthn.ES256 !in c.algs) return "the site asked for ${c.algs.joinToString()}; this device has ES256 (-7) only"
        val uid = runCatching { B64.fromUrl(c.userId) }.getOrNull() ?: return "user.id is not base64url"
        if (uid.size !in 1..64) return "user.id is ${uid.size} bytes"
        return null
    }

    /** The manager's URL as a pairing link gives it: https, or (debug builds) http to the emulator's host or localhost. */
    fun managerUrl(url: String, debug: Boolean): String? {
        val u = url.toHttpUrlOrNull() ?: return null
        if (u.query != null || u.fragment != null) return null
        val local = u.host == "10.0.2.2" || u.host == "localhost" || u.host == "127.0.0.1"
        if (!u.isHttps && !(debug && local)) return null
        return u.toString().trimEnd('/')
    }

    private fun utf8(b: ByteArray): String? = runCatching {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b)).toString()
    }.getOrNull()
}

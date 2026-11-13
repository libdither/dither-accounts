package org.libdither.approver

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.ZoneId

/** A manager this phone is paired with. Its identity key is `keyAlias` in the Keystore. */
data class Pairing(
    val deviceId: String,
    val url: String,
    val name: String,
    val keyAlias: String,
    val fingerprint: String,
    val pairedAt: Long,
    /** The manager closed the link with 4401 (it no longer knows this device): no more reconnecting. */
    var forgotten: Boolean = false,
)

/** A passkey's metadata (the private key stays in the Keystore as `keyAlias`). */
data class Credential(
    val id: String,
    val rpId: String,
    val url: String,
    val deviceId: String,
    val account: String,
    val userHandle: String?,
    var counter: Long,
    val createdAt: Long,
    var lastUsedAt: Long?,
    val keyAlias: String,
    val where: String,
)

data class LogLine(val at: Long, val text: String)

/**
 * Everything the app keeps besides keys: one JSON file in app-private storage (no backup: allowBackup is off), written
 * whole through AtomicFile (a temporary file, fsync, rename), so a counter written here is on disk before it is used.
 */
object Store {
    private lateinit var file: AtomicFile
    val pairings = mutableListOf<Pairing>()
    val credentials = mutableListOf<Credential>()
    /** Refusals and errors, newest last; at most 100. */
    val log = mutableListOf<LogLine>()
    /** Approvals (time, rpId) over the last two days, for "signed for this site today". */
    private val signed = mutableListOf<Pair<Long, String>>()
    var pushEndpoint: String? = null
    var pushStatus: String? = null

    @Synchronized
    fun init(c: Context) {
        if (::file.isInitialized) return
        file = AtomicFile(File(c.filesDir, "state.json"))
        val o = runCatching { JSONObject(String(file.readFully(), Charsets.UTF_8)) }.getOrNull() ?: return
        o.optJSONArray("pairings")?.forEachObject {
            pairings += Pairing(it.getString("deviceId"), it.getString("url"), it.optString("name"), it.getString("keyAlias"), it.optString("fingerprint"), it.optLong("pairedAt"), it.optBoolean("forgotten"))
        }
        o.optJSONArray("credentials")?.forEachObject {
            credentials += Credential(
                it.getString("id"), it.getString("rpId"), it.getString("url"), it.getString("deviceId"), it.optString("account"),
                it.optStringOrNull("userHandle"), it.getLong("counter"), it.getLong("createdAt"), if (it.isNull("lastUsedAt")) null else it.optLong("lastUsedAt"),
                it.getString("keyAlias"), it.optString("where"),
            )
        }
        o.optJSONArray("log")?.forEachObject { log += LogLine(it.getLong("at"), it.getString("text")) }
        o.optJSONArray("signed")?.forEachObject { signed += it.getLong("at") to it.getString("rpId") }
        pushEndpoint = o.optStringOrNull("pushEndpoint")
    }

    /** Throws when the file could not be written: callers that must not go on without it (the counter) let it. */
    @Synchronized
    fun save() {
        val o = JSONObject()
            .put("pairings", JSONArray(pairings.map {
                JSONObject().put("deviceId", it.deviceId).put("url", it.url).put("name", it.name).put("keyAlias", it.keyAlias)
                    .put("fingerprint", it.fingerprint).put("pairedAt", it.pairedAt).put("forgotten", it.forgotten)
            }))
            .put("credentials", JSONArray(credentials.map {
                JSONObject().put("id", it.id).put("rpId", it.rpId).put("url", it.url).put("deviceId", it.deviceId).put("account", it.account)
                    .put("userHandle", it.userHandle ?: JSONObject.NULL).put("counter", it.counter).put("createdAt", it.createdAt)
                    .put("lastUsedAt", it.lastUsedAt ?: JSONObject.NULL).put("keyAlias", it.keyAlias).put("where", it.where)
            }))
            .put("log", JSONArray(log.map { JSONObject().put("at", it.at).put("text", it.text) }))
            .put("signed", JSONArray(signed.map { JSONObject().put("at", it.first).put("rpId", it.second) }))
            .put("pushEndpoint", pushEndpoint ?: JSONObject.NULL)
        val s = file.startWrite()
        try {
            s.write(o.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(s)
        } catch (e: Exception) {
            file.failWrite(s)
            throw e
        }
    }

    @Synchronized
    fun addLog(text: String) {
        log += LogLine(System.currentTimeMillis(), text.take(300))
        while (log.size > 100) log.removeAt(0)
        runCatching { save() }
    }

    @Synchronized
    fun noteSigned(rpId: String, at: Long) {
        val cutoff = at - 2 * 86_400_000L
        signed.removeAll { it.first < cutoff }
        signed += at to rpId
    }

    /** How many times this phone approved for rpId since local midnight. */
    @Synchronized
    fun signedToday(rpId: String, now: Long = System.currentTimeMillis()): Int {
        val zone = ZoneId.systemDefault()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        return signed.count { it.second == rpId && Instant.ofEpochMilli(it.first).atZone(zone).toLocalDate() == today }
    }

    fun pairing(deviceId: String): Pairing? = pairings.firstOrNull { it.deviceId == deviceId }

    private inline fun JSONArray.forEachObject(f: (JSONObject) -> Unit) {
        for (i in 0 until length()) optJSONObject(i)?.let { runCatching { f(it) } }
    }

    private fun JSONObject.optStringOrNull(k: String): String? = if (isNull(k)) null else optString(k).ifEmpty { null }
}

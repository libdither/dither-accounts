package org.libdither.approver

import org.json.JSONObject

/**
 * Approvals (dither-chat's docs/approvals.md): the statement a device signs, and the checks an `approve` request passes
 * before it is shown. Byte for byte as dither-chat's packages/approvals/src/statement.ts; pure JVM, so the unit tests
 * run it.
 */
object Statement {
    const val V1 = "dither-approval-v1"
    val KINDS = setOf("alert", "rebuild", "deploy", "merge", "policy")
    val ID = Regex("^apv_[A-Za-z0-9_-]{22}$")
    val NAME = Regex("^[a-z0-9-]{1,32}$")
    val DEVICE = Regex("^dev_[A-Za-z0-9_-]{1,64}$")
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val MS = Regex("^(0|[1-9][0-9]{0,15})$")
    private val SHA1 = Regex("^[0-9a-f]{40}$")
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")
    const val MAX_TITLE = 200
    const val MAX_PAYLOAD = 4 * 1024
    const val MAX_MESSAGE = 1000

    /** The key a device sends after each `ready`: the identity key signs this over the approval key's SPKI. */
    fun keysInput(deviceId: String, kind: String, approvalSpkiB64: String): ByteArray =
        "dither-approver-key-v1\n$deviceId\n$kind\n$approvalSpkiB64".toByteArray(Charsets.UTF_8)

    fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    fun sha256hex(s: String): String = hex(WebAuthn.sha256(s.toByteArray(Charsets.UTF_8)))

    /** display-sha256: SHA-256 of title + "\n\n" + body. */
    fun displayHash(title: String, body: String) = sha256hex("$title\n\n$body")

    /** message-sha256: of the message's UTF-8, of "" when there is none. */
    fun messageHash(message: String?) = sha256hex(message ?: "")

    /** The asker's part of the statement. */
    data class Ask(
        val id: String,
        val kind: String,
        val asker: String,
        val created: Long,
        val expires: Long,
        val payloadSha256: String,
        val displaySha256: String,
    ) {
        fun text(): String = lines(
            V1, "id $id", "kind $kind", "asker $asker", "created $created", "expires $expires",
            "payload-sha256 $payloadSha256", "display-sha256 $displaySha256",
        )
    }

    private fun lines(vararg l: String) = l.joinToString("") { "$it\n" }

    /** The whole statement: the ask's eight lines, then the device's four. */
    fun text(ask: Ask, action: String, messageSha256: String, device: String, signed: Long): String =
        ask.text() + lines("action $action", "message-sha256 $messageSha256", "device $device", "signed $signed")

    /** The ask's fields, exactly the eight v1 lines in order and in canonical form; throws with the reason otherwise. */
    fun parseAsk(text: String): Ask {
        require(text.endsWith("\n")) { "the ask doesn't end with a newline" }
        val l = text.dropLast(1).split("\n")
        require(l[0] == V1) { "the ask isn't $V1" }
        val keys = listOf("id", "kind", "asker", "created", "expires", "payload-sha256", "display-sha256")
        require(l.size == keys.size + 1) { "the ask has ${l.size - 1} fields, not ${keys.size}" }
        val v = HashMap<String, String>()
        for ((i, k) in keys.withIndex()) {
            val line = l[i + 1]
            val sp = line.indexOf(' ')
            require(sp > 0 && line.substring(0, sp) == k) { "the ask's field ${i + 1} isn't $k" }
            v[k] = line.substring(sp + 1)
        }
        require(ID.matches(v["id"]!!)) { "a bad id" }
        require(v["kind"] in KINDS) { "an unknown kind" }
        require(NAME.matches(v["asker"]!!)) { "a bad asker" }
        for (k in listOf("payload-sha256", "display-sha256")) require(HEX64.matches(v[k]!!)) { "a bad $k" }
        for (k in listOf("created", "expires")) require(MS.matches(v[k]!!)) { "a bad $k" }
        val a = Ask(v["id"]!!, v["kind"]!!, v["asker"]!!, v["created"]!!.toLong(), v["expires"]!!.toLong(), v["payload-sha256"]!!, v["display-sha256"]!!)
        // One text per ask, so nothing can hide in the bytes.
        require(a.text() == text) { "the ask isn't in canonical form" }
        return a
    }

    class Action(val id: String, val label: String, val signed: Boolean)

    /** What the request shows; its hashes are in the ask. */
    class Display(
        val kind: String,
        val asker: String,
        val title: String,
        val body: String,
        val payload: String,
        val urgency: String,
        val actions: List<Action>,
    ) {
        /** The payload's lines without the format line's newline, for showing. */
        val payloadLines get() = payload.removeSuffix("\n").split("\n").filter { it.isNotEmpty() }
    }

    /** A request that passed every check: what the approve screen shows and the answer signs. */
    class Approve(val id: String, val ask: Ask, val askText: String, val display: Display)

    /**
     * A `{t:"request", op:"approve", id, ask, display, expiresAt}` frame checked as docs/approvals.md asks before it is
     * shown: the ask parses as the eight asker lines, its id is the request's, its payload and display hashes match
     * display, kind and asker equal display's, it hasn't expired, and the actions are well formed and include deny.
     * Throws IllegalArgumentException with the reason (for the log) when any fails.
     */
    fun check(o: JSONObject, now: Long): Approve {
        val id = o.optString("id")
        require(o.optString("op") == "approve") { "op is ${o.optString("op")}" }
        val askText = (o.opt("ask") as? String) ?: throw IllegalArgumentException("no ask")
        val ask = parseAsk(askText)
        require(ask.id == id) { "the ask's id ${ask.id} isn't the request's $id" }
        val d = o.optJSONObject("display") ?: throw IllegalArgumentException("no display")
        val title = d.str("title")
        val body = d.str("body")
        val payload = d.str("payload")
        require(title.length <= MAX_TITLE && !CONTROL.containsMatchIn(title)) { "the title isn't one line of at most $MAX_TITLE characters" }
        require(sha256hex(payload) == ask.payloadSha256) { "payload-sha256 doesn't match the payload" }
        require(displayHash(title, body) == ask.displaySha256) { "display-sha256 doesn't match the title and body" }
        require(d.str("kind") == ask.kind) { "display's kind ${d.str("kind")} isn't the ask's ${ask.kind}" }
        require(d.str("asker") == ask.asker) { "display's asker ${d.str("asker")} isn't the ask's ${ask.asker}" }
        require(ask.expires > now) { "expired" }
        payloadProblem(ask.kind, payload)?.let { throw IllegalArgumentException(it) }
        val arr = d.optJSONArray("actions") ?: throw IllegalArgumentException("no actions")
        val actions = (0 until arr.length()).map { i ->
            val a = arr.optJSONObject(i) ?: throw IllegalArgumentException("action ${i + 1} isn't an object")
            val aid = a.str("id")
            require(NAME.matches(aid)) { "a bad action id: ${aid.take(40)}" }
            val needs = a.str("needs")
            require(needs == "signed" || needs == "any") { "action $aid needs \"$needs\", not signed or any" }
            val label = a.str("label").replace(CONTROL, " ").trim().take(60).ifEmpty { aid }
            Action(aid, label, needs == "signed")
        }
        require(actions.map { it.id }.toSet().size == actions.size) { "an action is listed twice" }
        require(actions.any { it.id == "deny" }) { "no deny among the actions" }
        return Approve(id, ask, askText, Display(ask.kind, ask.asker, title, body, payload, d.str("urgency").ifEmpty { "normal" }, actions))
    }

    /** The payload's line format (ASCII, at most 4 KiB, its format name first), and a merge's fields. Null when fine. */
    fun payloadProblem(kind: String, payload: String): String? {
        if (payload.isEmpty()) return if (kind == "alert") null else "a $kind without a payload"
        if (payload.length > MAX_PAYLOAD) return "the payload is over 4 KiB"
        if (!payload.all { it == '\n' || it in ' '..'~' }) return "the payload isn't printable ASCII"
        if (!payload.endsWith("\n")) return "the payload doesn't end with a newline"
        val l = payload.dropLast(1).split("\n")
        if (!Regex("^dither-[a-z]+-v[0-9]+$").matches(l[0])) return "the payload doesn't start with its format"
        val fields = l.drop(1).map { line -> Regex("^([a-z0-9-]+) (.+)$").matchEntire(line)?.let { it.groupValues[1] to it.groupValues[2] } ?: return "a bad payload line: ${line.take(60)}" }
        if (kind == "merge") {
            if (l[0] != "dither-merge-v1") return "a merge's payload isn't dither-merge-v1"
            if (fields.map { it.first } != listOf("repo", "target", "branch", "base", "head", "tree")) return "a merge payload has repo, target, branch, base, head, tree"
            if (fields.drop(3).any { !SHA1.matches(it.second) }) return "a merge's base, head and tree aren't full ids"
        }
        return null
    }

    private fun JSONObject.str(k: String): String = (opt(k) as? String) ?: ""

    /** A DER ECDSA signature as raw r ‖ s (64 bytes), or null when it isn't one: what WebCrypto verifies. */
    fun rawSignature(der: ByteArray): ByteArray? {
        if (der.size < 8 || der[0] != 0x30.toByte() || (der[1].toInt() and 0xff) != der.size - 2) return null
        var i = 2
        fun int(): ByteArray? {
            if (der[i] != 0x02.toByte()) return null
            val len = der[i + 1].toInt() and 0xff
            if (len < 1 || len > 33 || i + 2 + len > der.size) return null
            var v = der.copyOfRange(i + 2, i + 2 + len)
            i += 2 + len
            while (v.size > 32 && v[0] == 0.toByte()) v = v.copyOfRange(1, v.size)
            if (v.size > 32) return null
            return ByteArray(32 - v.size) + v
        }
        val r = int() ?: return null
        val s = int() ?: return null
        return if (i == der.size) r + s else null
    }
}

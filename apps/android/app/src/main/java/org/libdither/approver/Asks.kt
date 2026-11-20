package org.libdither.approver

import android.app.Activity
import android.content.Context
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.security.keystore.KeyPermanentlyInvalidatedException
import org.json.JSONObject

/** An approve request that passed the checks, shown until answered, cancelled or expired. */
class Asked(val p: Pairing, val a: Statement.Approve, val receivedAt: Long) {
    /** What is typed in the message box (kept across redraws). */
    var message = ""
    var note: String? = null
    var busy = false
}

/**
 * Approvals (dither-chat's docs/approvals.md): approve requests from the links, several at once. Each is checked before
 * it is shown (refused without a prompt when a check fails). A `signed` action builds the statement and signs it with
 * the manager's approval key behind a BiometricPrompt with the key's Signature as its CryptoObject; `deny` and `any`
 * actions answer at once, unsigned. Main thread only, except [keysFrame].
 */
object Asks {
    const val KIND = "phone"
    val pending = mutableListOf<Asked>()
    private val answered = LinkedHashSet<String>()

    fun onRequest(p: Pairing, o: JSONObject) {
        val id = o.optString("id")
        if (id.isEmpty()) return Store.addLog("An approval request without an id from ${p.url}: ignored")
        if (pending.any { it.a.id == id && it.p.deviceId == p.deviceId } || "${p.deviceId}/$id" in answered) return
        val now = System.currentTimeMillis()
        val a = try {
            Statement.check(o, now)
        } catch (e: Exception) {
            val why = e.message ?: e.javaClass.simpleName
            val reason = if (why == "expired") "expired" else "refused"
            Store.addLog("Refused approval $id from ${p.url}: $why")
            remember(p, id)
            Links.send(p.deviceId, refusal(id, reason))
            return Links.changed()
        }
        val x = Asked(p, a, now)
        pending += x
        Links.main.postDelayed({ if (x in pending) finish(x, refusal(id, "expired"), "Approval expired while waiting: ${a.display.title}") }, (a.ask.expires - now).coerceAtLeast(0))
        Notify.show(Links.app)
        Links.changed()
    }

    /** The manager says it's answered elsewhere, cancelled or expired: drop it, answer nothing. */
    fun onCancel(p: Pairing, id: String) {
        val x = pending.firstOrNull { it.a.id == id && it.p.deviceId == p.deviceId } ?: return
        pending -= x
        remember(p, id)
        Notify.show(Links.app)
        Links.refresh()
    }

    private fun refusal(id: String, reason: String) = JSONObject().put("t", "response").put("id", id).put("ok", false).put("reason", reason)

    private fun remember(p: Pairing, id: String) {
        answered += "${p.deviceId}/$id"
        while (answered.size > 200) answered.remove(answered.first())
    }

    private fun finish(x: Asked, answer: JSONObject, line: String? = null) {
        if (x !in pending) return
        pending -= x
        remember(x.p, x.a.id)
        line?.let { Store.addLog(it) }
        Links.send(x.p.deviceId, answer)
        Notify.show(Links.app)
        Links.refresh()
    }

    /** The message as sent and hashed: null when nothing was typed. */
    private fun message(x: Asked): String? = x.message.take(Statement.MAX_MESSAGE).ifEmpty { null }

    private fun answer(x: Asked, action: String, signed: Long, signature: String?) =
        JSONObject().put("t", "response").put("id", x.a.id).put("ok", true).put("op", "approve").put("action", action)
            .put("message", message(x) ?: JSONObject.NULL).put("signed", signed)
            .apply { if (signature != null) put("signature", signature) }

    fun act(a: Activity, x: Asked, action: Statement.Action) {
        if (x.busy || x !in pending) return
        if (x.a.ask.expires <= System.currentTimeMillis()) return finish(x, refusal(x.a.id, "expired"), "Approval expired before the answer: ${x.a.display.title}")
        x.note = null
        if (!action.signed || action.id == "deny") return finish(x, answer(x, action.id, System.currentTimeMillis(), null))
        val alias = x.p.approvalAlias ?: run {
            x.note = "This phone has no approval key for ${x.p.url} yet (it needs a screen lock). Set one, then reopen the app."
            return Links.changed()
        }
        val sig = try {
            Keys.signer(alias)
        } catch (e: KeyPermanentlyInvalidatedException) {
            // The screen lock was removed: the key is gone for good. A new one is made and sent at the next link.
            Keys.delete(alias)
            Links.forgetApprovalKey(x.p)
            x.note = "The approval key was invalidated (the screen lock changed?). A new one is being made; its fingerprint changes."
            return Links.changed()
        } catch (e: Exception) {
            x.note = "Could not open the approval key: ${e.message}"
            return Links.changed()
        }
        x.busy = true
        Links.changed()
        val bp = BiometricPrompt.Builder(a)
            .setTitle("${action.label}: ${x.a.display.title}".take(120))
            .setSubtitle("${x.a.display.kind} from ${x.a.display.asker}")
            .setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL)
            .build()
        bp.authenticate(BiometricPrompt.CryptoObject(sig), CancellationSignal(), a.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                x.busy = false
                if (x !in pending) return Links.changed()
                val now = System.currentTimeMillis()
                if (x.a.ask.expires <= now) return finish(x, refusal(x.a.id, "expired"), "Approval expired during the prompt: ${x.a.display.title}")
                val res = runCatching {
                    val text = Statement.text(x.a.ask, action.id, Statement.messageHash(message(x)), x.p.deviceId, now)
                    val bytes = text.toByteArray(Charsets.UTF_8)
                    val der = WebAuthn.sign(result.cryptoObject?.signature ?: sig, bytes)
                    check(WebAuthn.verify(Keys.publicKey(alias), bytes, der)) { "the signature did not verify with the approval key" }
                    der
                }
                res.onSuccess { der -> finish(x, answer(x, action.id, now, B64.url(der))) }
                    .onFailure { e ->
                        val why = e.message ?: e.javaClass.simpleName
                        finish(x, refusal(x.a.id, "error").put("message", why), "Error signing approval ${x.a.display.title}: $why")
                    }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                x.busy = false
                x.note = "Not signed: $errString. Try again, or answer another way."
                Links.changed()
            }
        })
    }

    /**
     * The keys frame for a link that just became ready: makes the manager's approval key when it is missing (StrongBox
     * when there is one, user authentication on every use) and signs its SPKI with the identity key. Blocking (key
     * generation can take a second): call off the main thread. Null, with a line in the log, when no key can be made
     * (no secure screen lock yet).
     */
    fun keysFrame(c: Context, p: Pairing): JSONObject? {
        val alias = p.approvalAlias?.takeIf { Keys.exists(it) } ?: run {
            val alias = "approval-" + Pairings.randomHex(8)
            try {
                Keys.approval(c, alias)
            } catch (e: Exception) {
                Keys.delete(alias)
                Store.addLog("Could not make an approval key for ${p.url} (is a screen lock set?): ${e.message}")
                return null
            }
            val spki = Keys.spki(alias)
            synchronized(Store) {
                p.approvalAlias?.let { Keys.delete(it) }
                p.approvalAlias = alias
                p.approvalFingerprint = WebAuthn.fingerprint(spki)
                runCatching { Store.save() }
            }
            alias
        }
        val approval = B64.std(Keys.spki(alias))
        val sig = WebAuthn.sign(Keys.signer(p.keyAlias), Statement.keysInput(p.deviceId, KIND, approval))
        return JSONObject().put("t", "keys").put("kind", KIND).put("approval", approval).put("sig", B64.url(sig))
    }
}

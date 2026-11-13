package org.libdither.approver

import android.app.Activity
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.security.keystore.KeyPermanentlyInvalidatedException
import org.json.JSONObject
import java.security.SecureRandom
import java.security.Signature

/** A request that passed the checks and waits for Approve or Deny. */
class Pending(val p: Pairing, val r: Request, val receivedAt: Long, val credential: Credential?) {
    /** A line under the request: why the last prompt didn't approve, or what is happening. */
    var note: String? = null
    var busy = false
}

/**
 * Requests from the links: checked before anything is shown (refused without a prompt when a check fails), then shown
 * until you approve, deny, or they expire. Approve runs the Keystore operation behind a BiometricPrompt with a
 * CryptoObject, so the key itself refuses to sign without the fingerprint or PIN. Main thread only.
 */
object Approvals {
    val pending = mutableListOf<Pending>()
    private val answered = LinkedHashSet<String>()

    fun onRequest(p: Pairing, o: JSONObject) {
        val id = o.optString("id")
        if (id.isEmpty()) return Store.addLog("A request without an id from ${p.url}: ignored")
        if (pending.any { it.r.id == id && it.p.deviceId == p.deviceId } || "${p.deviceId}/$id" in answered) return
        val r = try {
            Request.parse(o)
        } catch (e: Exception) {
            return refuse(p, id, "refused", "A malformed request from ${p.url} (${e.message})")
        }
        val now = System.currentTimeMillis()
        val what = "${r.op} for ${r.accountLabel} on ${r.rpId} from ${r.origin}"
        Checks.site(r)?.let { return refuse(p, id, "refused", "Refused $what: $it") }
        if (Checks.expired(r, now)) return refuse(p, id, "expired", "Expired before it was shown: $what")
        var cred: Credential? = null
        if (r.op == "create") {
            Checks.createOptions(r)?.let { return refuse(p, id, "refused", "Refused $what: $it") }
        } else {
            cred = Store.credentials
                .filter { it.deviceId == p.deviceId && it.url == p.url && it.rpId == r.rpId && (r.allow.isEmpty() || it.id in r.allow) }
                .maxByOrNull { it.createdAt }
                ?: return refuse(p, id, "unknown-credential", "No passkey here for $what${if (r.allow.isEmpty()) "" else " (asked for ${r.allow.joinToString { it.take(8) }})"}")
        }
        val pend = Pending(p, r, now, cred)
        pending += pend
        Links.main.postDelayed({ if (pend in pending) finish(pend, refusal(r.id, "expired"), "Expired while waiting: $what") }, (r.expiresAt - now).coerceAtLeast(0))
        Notify.show(Links.app)
        Links.changed()
    }

    private fun refusal(id: String, reason: String) = JSONObject().put("t", "response").put("id", id).put("ok", false).put("reason", reason)

    private fun refuse(p: Pairing, id: String, reason: String, line: String) {
        Store.addLog(line)
        remember(p, id)
        Links.send(p.deviceId, refusal(id, reason))
        Links.changed()
    }

    private fun remember(p: Pairing, id: String) {
        answered += "${p.deviceId}/$id"
        while (answered.size > 200) answered.remove(answered.first())
    }

    /** Sends the answer, drops the request, and logs `line` (a refusal or error) when there is one. */
    private fun finish(pend: Pending, answer: JSONObject, line: String? = null) {
        if (pend !in pending) return
        pending -= pend
        remember(pend.p, pend.r.id)
        line?.let { Store.addLog(it) }
        Links.send(pend.p.deviceId, answer)
        Notify.show(Links.app)
        Links.refresh()
    }

    fun deny(pend: Pending) = finish(pend, refusal(pend.r.id, "denied"), "Denied: ${pend.r.op} for ${pend.r.accountLabel} on ${pend.r.rpId}")

    private fun error(pend: Pending, message: String) =
        finish(pend, refusal(pend.r.id, "error").put("message", message), "Error: ${pend.r.op} for ${pend.r.accountLabel} on ${pend.r.rpId}: $message")

    fun approve(a: Activity, pend: Pending) {
        if (pend.busy || pend !in pending) return
        if (Checks.expired(pend.r, System.currentTimeMillis())) return finish(pend, refusal(pend.r.id, "expired"), "Expired before approval: ${pend.r.rpId}")
        pend.busy = true
        pend.note = null
        if (pend.r.op == "create") create(a, pend) else get(a, pend)
    }

    private fun create(a: Activity, pend: Pending) {
        val r = pend.r
        val alias = "cred-" + Pairings.randomHex(12)
        val sig = try {
            Keys.credential(a, alias)
            Keys.signer(alias)
        } catch (e: Exception) {
            Keys.delete(alias)
            return error(pend, "could not make the key: ${e.message}")
        }
        prompt(a, pend, "Create a passkey for ${r.rpId}", sig, onCancel = { Keys.delete(alias) }) { s ->
            val pub = Keys.publicKey(alias)
            val credId = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val authData = WebAuthn.createAuthData(r.rpId, credId, pub)
            // One signature now, behind the prompt that just passed: proves the new key signs, and with this phone's
            // fingerprint or PIN only, before the site keeps it.
            val probe = WebAuthn.signedData(authData, r.clientDataJSON)
            if (!WebAuthn.verify(pub, probe, WebAuthn.sign(s, probe))) throw IllegalStateException("the new key's signature did not verify")
            val now = System.currentTimeMillis()
            val cred = Credential(
                id = B64.url(credId), rpId = r.rpId, url = pend.p.url, deviceId = pend.p.deviceId, account = r.accountLabel,
                userHandle = r.create!!.userId, counter = 0, createdAt = now, lastUsedAt = null, keyAlias = alias, where = Keys.where(alias),
            )
            synchronized(Store) {
                Store.credentials += cred
                Store.noteSigned(r.rpId, now)
                Store.save()
            }
            JSONObject().put("t", "response").put("id", r.id).put("ok", true)
                .put("credentialId", cred.id)
                .put("publicKey", B64.std(pub.encoded))
                .put("authenticatorData", B64.url(authData))
                .put("attestationObject", B64.url(WebAuthn.attestationObject(authData)))
        }
    }

    private fun get(a: Activity, pend: Pending) {
        val r = pend.r
        val cred = pend.credential!!
        val sig = try {
            Keys.signer(cred.keyAlias)
        } catch (e: KeyPermanentlyInvalidatedException) {
            return error(pend, "the passkey's key was invalidated (the screen lock was removed?); delete it and make a new one")
        } catch (e: Exception) {
            return error(pend, "could not open the key: ${e.message}")
        }
        prompt(a, pend, "Sign in to ${r.rpId}", sig) { s ->
            // The counter is on disk before the signature exists, so it never goes back.
            val count = cred.counter + 1
            val now = System.currentTimeMillis()
            synchronized(Store) {
                cred.counter = count
                cred.lastUsedAt = now
                Store.noteSigned(r.rpId, now)
                Store.save()
            }
            val authData = WebAuthn.getAuthData(r.rpId, count)
            val der = WebAuthn.sign(s, WebAuthn.signedData(authData, r.clientDataJSON))
            JSONObject().put("t", "response").put("id", r.id).put("ok", true)
                .put("credentialId", cred.id)
                .put("authenticatorData", B64.url(authData))
                .put("signature", B64.url(der))
                .put("userHandle", cred.userHandle ?: JSONObject.NULL)
        }
    }

    /** BiometricPrompt (strong biometric or the device credential) unlocking `sig`; `done` builds the answer. */
    private fun prompt(a: Activity, pend: Pending, title: String, sig: Signature, onCancel: () -> Unit = {}, done: (Signature) -> JSONObject) {
        val bp = BiometricPrompt.Builder(a)
            .setTitle(title)
            .setSubtitle(pend.r.accountLabel)
            .setDescription(pend.r.reason)
            .setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL)
            .build()
        val cancel = CancellationSignal()
        bp.authenticate(BiometricPrompt.CryptoObject(sig), cancel, a.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                pend.busy = false
                if (pend !in pending) return onCancel()
                val s = result.cryptoObject?.signature ?: sig
                val answer = try {
                    done(s)
                } catch (e: Exception) {
                    onCancel()
                    return error(pend, e.message ?: e.javaClass.simpleName)
                }
                finish(pend, answer)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                pend.busy = false
                onCancel()
                pend.note = "Not approved: $errString. Approve again, or Deny."
                Links.changed()
            }
        })
    }
}

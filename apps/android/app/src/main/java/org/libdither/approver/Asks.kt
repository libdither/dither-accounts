package org.libdither.approver

import android.app.Activity
import android.content.Context
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.os.SystemClock
import android.provider.Settings
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import org.json.JSONObject

/** An approve request that passed the checks, shown until answered, cancelled or expired. */
class Asked(val p: Pairing, val a: Statement.Approve, val receivedAt: Long) {
    /** What is typed in the message box (kept across redraws). */
    var message = ""
    var note: String? = null
    var busy = false
    /** Ticked for "Approve selected" (only offered when its pairing has a quick-approval key and it has `approve`). */
    var selected = true
}

/**
 * Approvals (dither-chat's docs/approvals.md): approve requests from the links, several at once. Each is checked before
 * it is shown (refused without a prompt when a check fails). A `signed` action builds the statement and signs it with
 * the manager's approval key behind a BiometricPrompt with the key's Signature as its CryptoObject; `deny` and `any`
 * actions answer at once, unsigned. A pairing with a quick-approval key ([Keys.quickApproval]) signs without the
 * CryptoObject: one prompt opens the window the user picked ([QuickWindow]), and "Approve selected" signs several
 * requests after at most one prompt, each as its own statement. Main thread only, except [keysFrame] and [prepareNext].
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
        if (x.p.approvalQuick) return signQuick(a, listOf(x to action))
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

    /** The pending requests "Approve selected" would sign: ticked, on a quick-approval key, offering `approve`. */
    fun selectable(): List<Pair<Asked, Statement.Action>> = pending.filter { it.p.approvalQuick && !it.busy }
        .mapNotNull { x -> x.a.display.actions.firstOrNull { it.id == "approve" && it.signed }?.let { x to it } }

    fun approveSelected(a: Activity) = signQuick(a, selectable().filter { it.first.selected })

    private fun bootCount(c: Context): Int = Settings.Global.getInt(c.contentResolver, Settings.Global.BOOT_COUNT, 0)

    /** Whether the next quick signature needs a prompt first. */
    fun quickNeedsPrompt(c: Context): Boolean =
        QuickWindow.needsPrompt(Store.quickWindowS, Store.lastAuth, SystemClock.elapsedRealtime(), bootCount(c))

    fun quickRemainingMs(c: Context): Long? =
        QuickWindow.remainingMs(Store.quickWindowS, Store.lastAuth, SystemClock.elapsedRealtime(), bootCount(c))

    /** Close the window now: the next quick signature asks again. */
    fun lockQuick() {
        synchronized(Store) {
            Store.lastAuth = null
            runCatching { Store.save() }
        }
    }

    private fun noteAuth(c: Context) {
        synchronized(Store) {
            Store.lastAuth = QuickWindow.LastAuth(SystemClock.elapsedRealtime(), bootCount(c))
            runCatching { Store.save() }
        }
    }

    /**
     * Sign each request with its pairing's quick-approval key: a prompt first when the window is closed (or the
     * Keystore wants one, after a reboot), then one statement per request, each checked again just before it's signed.
     */
    private fun signQuick(a: Activity, items: List<Pair<Asked, Statement.Action>>, prompted: Boolean = false) {
        val todo = items.filter { (x, _) -> x in pending && !x.busy }
        if (todo.isEmpty()) return Links.changed()
        if (!prompted && quickNeedsPrompt(a)) return promptQuick(a, todo)
        var needAuth = false
        for ((x, action) in todo) {
            x.note = null
            if (x !in pending) continue
            if (x.a.ask.expires <= System.currentTimeMillis()) {
                finish(x, refusal(x.a.id, "expired"), "Approval expired before the answer: ${x.a.display.title}")
                continue
            }
            val alias = x.p.approvalAlias
            if (alias == null || !x.p.approvalQuick) {
                x.note = "This pairing has no quick-approval key: approve it on its own."
                continue
            }
            val sig = try {
                Keys.signer(alias)
            } catch (e: UserNotAuthenticatedException) {
                needAuth = true
                break
            } catch (e: KeyPermanentlyInvalidatedException) {
                Keys.delete(alias)
                Links.forgetApprovalKey(x.p)
                x.note = "The approval key was invalidated (the screen lock changed?). A new one is being made; its fingerprint changes."
                continue
            } catch (e: Exception) {
                x.note = "Could not open the approval key: ${e.message}"
                continue
            }
            val now = System.currentTimeMillis()
            runCatching {
                val text = Statement.text(x.a.ask, action.id, Statement.messageHash(message(x)), x.p.deviceId, now)
                val bytes = text.toByteArray(Charsets.UTF_8)
                val der = WebAuthn.sign(sig, bytes)
                check(WebAuthn.verify(Keys.publicKey(alias), bytes, der)) { "the signature did not verify with the approval key" }
                der
            }.onSuccess { der -> finish(x, answer(x, action.id, now, B64.url(der))) }
                .onFailure { e ->
                    if (e is UserNotAuthenticatedException) {
                        needAuth = true
                    } else {
                        val why = e.message ?: e.javaClass.simpleName
                        finish(x, refusal(x.a.id, "error").put("message", why), "Error signing approval ${x.a.display.title}: $why")
                    }
                }
            if (needAuth) break
        }
        // The Keystore's own window ran out (a reboot, or past QUICK_KEY_WINDOW_S): ask once, then go on with the rest.
        if (needAuth && !prompted) return promptQuick(a, todo)
        if (needAuth) todo.forEach { (x, _) -> if (x in pending) x.note = "The approval key still wants a fingerprint or PIN. Try again." }
        Links.changed()
    }

    private fun promptQuick(a: Activity, todo: List<Pair<Asked, Statement.Action>>) {
        todo.forEach { it.first.busy = true }
        Links.changed()
        val (title, subtitle) = if (todo.size == 1) {
            val (x, action) = todo[0]
            "${action.label}: ${x.a.display.title}".take(120) to "${x.a.display.kind} from ${x.a.display.asker}"
        } else {
            "Approve ${todo.size} requests" to todo.joinToString(", ") { it.first.a.display.title }.take(200)
        }
        val bp = BiometricPrompt.Builder(a)
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL)
            .build()
        bp.authenticate(CancellationSignal(), a.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                todo.forEach { it.first.busy = false }
                noteAuth(a)
                signQuick(a, todo, prompted = true)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                todo.forEach { (x, _) -> x.busy = false; if (x in pending) x.note = "Not signed: $errString. Try again, or answer another way." }
                Links.changed()
            }
        })
    }

    /**
     * Make a quick-approval key for a pairing that still has the old kind, without using it: the old key keeps signing
     * and stays the one the manager knows until [useNext]. Blocking (key generation): call off the main thread.
     */
    fun prepareNext(c: Context, p: Pairing): String? {
        if (p.approvalQuick || p.nextAlias != null) return null
        val alias = "approval-" + Pairings.randomHex(8)
        try {
            Keys.quickApproval(c, alias)
        } catch (e: Exception) {
            Keys.delete(alias)
            return "Could not make the key (is a screen lock set?): ${e.message}"
        }
        synchronized(Store) {
            p.nextAlias = alias
            p.nextFingerprint = WebAuthn.fingerprint(Keys.spki(alias))
            runCatching { Store.save() }
        }
        Store.addLog("Made a quick-approval key for ${p.url} (${p.nextFingerprint}); not in use until you switch to it")
        return null
    }

    /** The next key as a `dither-ask keys` line, to pin on the hosts that check answers before switching to it. */
    fun nextKeysLine(p: Pairing): String? {
        val alias = p.nextAlias ?: return null
        val name = p.name.ifEmpty { "phone" }.replace(Regex("\\s+"), " ")
        return "${p.deviceId}  $KIND  ${B64.std(Keys.spki(alias))}  ${p.nextFingerprint}  $name"
    }

    /** Switch to the next key: it signs from now on and is sent to the manager; the old key is destroyed. */
    fun useNext(p: Pairing) {
        val next = p.nextAlias ?: return
        val old = p.approvalAlias
        synchronized(Store) {
            p.approvalAlias = next
            p.approvalFingerprint = p.nextFingerprint
            p.approvalQuick = true
            p.nextAlias = null
            p.nextFingerprint = null
            runCatching { Store.save() }
        }
        if (old != null && old != next) Keys.delete(old)
        Store.addLog("Switched ${p.url} to the quick-approval key ${p.approvalFingerprint}")
        Links.resendKeys(p)
    }

    fun discardNext(p: Pairing) {
        val next = p.nextAlias ?: return
        synchronized(Store) {
            p.nextAlias = null
            p.nextFingerprint = null
            runCatching { Store.save() }
        }
        Keys.delete(next)
    }

    /**
     * The keys frame for a link that just became ready: makes the manager's approval key when it is missing (StrongBox
     * when there is one; a quick-approval key) and signs its SPKI with the identity key. Blocking (key
     * generation can take a second): call off the main thread. Null, with a line in the log, when no key can be made
     * (no secure screen lock yet).
     */
    fun keysFrame(c: Context, p: Pairing): JSONObject? {
        val alias = p.approvalAlias?.takeIf { Keys.exists(it) } ?: run {
            val alias = "approval-" + Pairings.randomHex(8)
            try {
                // A pairing with no approval key yet has nothing pinned to lose: it gets the quick kind straight away.
                Keys.quickApproval(c, alias)
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
                p.approvalQuick = true
                runCatching { Store.save() }
            }
            alias
        }
        val approval = B64.std(Keys.spki(alias))
        val sig = WebAuthn.sign(Keys.signer(p.keyAlias), Statement.keysInput(p.deviceId, KIND, approval))
        return JSONObject().put("t", "keys").put("kind", KIND).put("approval", approval).put("sig", B64.url(sig))
    }
}

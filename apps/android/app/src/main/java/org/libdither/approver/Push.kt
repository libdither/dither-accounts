package org.libdither.approver

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.util.Log
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Wake-ups through UnifiedPush (a distributor app such as ntfy holds the connection). The endpoint goes to every
 * paired manager as {t:"push", endpoint}; a push of {"t":"wake"} opens the links, and whatever waits is shown. The
 * manager's wake-up carries nothing else, so it is not encrypted, and nothing in it is trusted beyond "open the link".
 */
object Push {
    const val INSTANCE = "default"

    fun enable(a: Activity, done: (String?) -> Unit) {
        UnifiedPush.tryUseCurrentOrDefaultDistributor(a) { ok ->
            a.runOnUiThread {
                if (ok) return@runOnUiThread register(a).also { done(null) }
                val all = UnifiedPush.getDistributors(a)
                when (all.size) {
                    0 -> done("No UnifiedPush distributor is installed. Install one (ntfy, from F-Droid), open it once, and try again.")
                    1 -> { UnifiedPush.saveDistributor(a, all[0]); register(a); done(null) }
                    else -> AlertDialog.Builder(a)
                        .setTitle("Wake-ups through")
                        .setItems(all.map { label(a, it) }.toTypedArray()) { _, i -> UnifiedPush.saveDistributor(a, all[i]); register(a); done(null) }
                        .setOnCancelListener { done("No distributor picked.") }
                        .show()
                }
            }
        }
    }

    private fun label(c: Context, pkg: String) = runCatching { c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)

    private fun register(c: Context) {
        Store.pushStatus = "registering…"
        UnifiedPush.register(c, INSTANCE, "dither-approver", null)
    }

    fun disable(c: Context) {
        UnifiedPush.unregister(c, INSTANCE)
        setEndpoint(null, "off")
    }

    fun distributor(c: Context): String? = (UnifiedPush.getAckDistributor(c) ?: UnifiedPush.getSavedDistributor(c))?.let { label(c, it) }

    /** Main thread. */
    fun setEndpoint(url: String?, status: String?) {
        Store.pushEndpoint = url
        Store.pushStatus = status
        runCatching { Store.save() }
        Links.sendPush()
        Links.changed()
    }

    /** What a push says: only {"t":"wake"} opens the links. */
    fun isWake(content: ByteArray): Boolean = runCatching { JSONObject(String(content, Charsets.UTF_8)).optString("t") == "wake" }.getOrDefault(false)
}

/** The connector's callbacks. */
class PushReceiver : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        Links.init(this)
        val url = endpoint.url
        Links.main.post {
            if (!url.startsWith("https://") && !BuildConfig.DEBUG) return@post Push.setEndpoint(null, "the distributor gave a non-https endpoint")
            Push.setEndpoint(url, null)
            // Tell the managers now, even with the app closed.
            Links.wake(this)
        }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        if (!Push.isWake(message.content)) {
            Log.w("ApproverPush", "a push that is not a wake-up: ignored")
            return
        }
        Links.wake(this)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        Links.init(this)
        Links.main.post { Push.setEndpoint(null, "the distributor refused ($reason)") }
    }

    override fun onUnregistered(instance: String) {
        Links.init(this)
        Links.main.post { Push.setEndpoint(null, "unregistered by the distributor") }
    }
}

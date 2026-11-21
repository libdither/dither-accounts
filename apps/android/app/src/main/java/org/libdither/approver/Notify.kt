package org.libdither.approver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/**
 * One notification while a request waits and the app is not on screen: it opens the app. The lock screen shows only
 * that something waits; the account and site show once the phone is unlocked.
 */
object Notify {
    private const val CHANNEL = "requests"
    private const val ID = 1
    private const val ASK_ID = 2

    fun show(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Approval requests", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(c, 0, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        asks(c, nm, open)
        val first = Approvals.pending.firstOrNull()
        if (first == null || Links.isForeground) return nm.cancel(ID)
        val verb = if (first.r.op == "create") "Create a passkey" else "Sign in"
        val public = Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("A sign-in waits for your approval")
            .build()
        val n = Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("$verb: ${first.r.accountLabel}")
            .setContentText("${first.r.rpId}: ${first.r.reason}")
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setTimeoutAfter((first.r.expiresAt - System.currentTimeMillis()).coerceAtLeast(1000))
            .build()
        runCatching { nm.notify(ID, n) }
    }

    /** Approvals: "Approval: <title>" and the asker for the newest; on the lock screen only "An approval waits". */
    private fun asks(c: Context, nm: NotificationManager, open: PendingIntent) {
        val newest = Asks.pending.lastOrNull()
        if (newest == null || Links.isForeground) return nm.cancel(ASK_ID)
        val d = newest.a.display
        val more = Asks.pending.size - 1
        val public = Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (more > 0) "${more + 1} approvals wait" else "An approval waits")
            .build()
        val n = Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Approval: ${d.title}")
            .setContentText("Asked by ${d.asker} (${d.kind})${if (more > 0) ", and $more more" else ""}")
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setTimeoutAfter((Asks.pending.maxOf { it.a.ask.expires } - System.currentTimeMillis()).coerceAtLeast(1000))
            .build()
        runCatching { nm.notify(ASK_ID, n) }
    }
}

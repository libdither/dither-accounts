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

    fun show(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        val first = Approvals.pending.firstOrNull()
        if (first == null || Links.isForeground) return nm.cancel(ID)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Approval requests", NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(c, 0, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
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
}

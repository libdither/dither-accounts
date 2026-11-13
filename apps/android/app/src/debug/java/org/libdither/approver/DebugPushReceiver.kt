package org.libdither.approver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug builds only (src/debug): what UnifiedPush would do, from adb, for the emulator check (apps/android/README.md).
 * `endpoint` sets the push endpoint as a distributor would (sent to the managers as {t:"push"}); `wake` is a push's
 * content, which opens the links when it is {"t":"wake"}.
 *
 *   adb shell am broadcast -a org.libdither.approver.DEBUG_PUSH -n org.libdither.approver/.DebugPushReceiver \
 *     --es endpoint https://push.example/abc --es wake '{"t":"wake"}'
 */
class DebugPushReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        Links.init(c)
        intent.getStringExtra("endpoint")?.let { e -> Links.main.post { Push.setEndpoint(e, null) } }
        intent.getStringExtra("wake")?.let { if (Push.isWake(it.toByteArray())) Links.wake(c) }
    }
}

package org.libdither.approver

/**
 * How long one fingerprint or PIN lets the quick-approval key sign without asking again. The Keystore holds the key for
 * up to [Keys.QUICK_KEY_WINDOW_S] after an unlock; this is the shorter window the user picks, kept by the app. The last
 * prompt is remembered as the time since boot plus the boot count, so it survives the app being killed but never a
 * restart (or a clock change). Pure: the tests drive it with made-up clocks.
 */
object QuickWindow {
    /** Seconds, with [UNTIL_RESTART] for "until the phone restarts". */
    const val UNTIL_RESTART = -1L
    const val DEFAULT_S = 30L
    val CHOICES = listOf(30L, 5 * 60L, 3600L, 8 * 3600L, 24 * 3600L, UNTIL_RESTART)

    data class LastAuth(val elapsedMs: Long, val bootCount: Int)

    fun label(windowS: Long): String = when {
        windowS == UNTIL_RESTART -> "until restart"
        windowS < 60 -> "${windowS} s"
        windowS < 3600 -> "${windowS / 60} min"
        windowS == 86_400L -> "1 day"
        else -> "${windowS / 3600} h"
    }

    /** A known choice, or the default for anything else (an old or hand-edited state file). */
    fun normalize(windowS: Long): Long = if (windowS in CHOICES) windowS else DEFAULT_S

    /**
     * Whether a prompt is needed before signing: no prompt yet, one from before the last boot, a clock that went
     * backwards, or one older than the window.
     */
    fun needsPrompt(windowS: Long, last: LastAuth?, nowElapsedMs: Long, bootCount: Int): Boolean {
        if (last == null || last.bootCount != bootCount || nowElapsedMs < last.elapsedMs) return true
        val w = normalize(windowS)
        if (w == UNTIL_RESTART) return false
        return nowElapsedMs - last.elapsedMs >= w * 1000
    }

    /** Milliseconds left before the next prompt; null when one is needed now, Long.MAX_VALUE until a restart. */
    fun remainingMs(windowS: Long, last: LastAuth?, nowElapsedMs: Long, bootCount: Int): Long? {
        if (needsPrompt(windowS, last, nowElapsedMs, bootCount)) return null
        val w = normalize(windowS)
        if (w == UNTIL_RESTART) return Long.MAX_VALUE
        return w * 1000 - (nowElapsedMs - last!!.elapsedMs)
    }
}

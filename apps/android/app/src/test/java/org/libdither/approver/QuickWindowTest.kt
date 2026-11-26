package org.libdither.approver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuickWindowTest {
    private val boot = 7
    private val at = QuickWindow.LastAuth(elapsedMs = 1_000_000, bootCount = boot)

    @Test fun promptsWhenThereWasNoPromptYet() {
        assertTrue(QuickWindow.needsPrompt(30, null, 5_000_000, boot))
        assertNull(QuickWindow.remainingMs(30, null, 5_000_000, boot))
    }

    @Test fun signsInsideTheWindowAndPromptsAtItsEnd() {
        assertFalse(QuickWindow.needsPrompt(30, at, 1_000_000, boot))
        assertFalse(QuickWindow.needsPrompt(30, at, 1_029_999, boot))
        assertEquals(1L, QuickWindow.remainingMs(30, at, 1_029_999, boot))
        assertTrue(QuickWindow.needsPrompt(30, at, 1_030_000, boot))
        assertFalse(QuickWindow.needsPrompt(86_400, at, 1_000_000 + 86_399_999, boot))
        assertTrue(QuickWindow.needsPrompt(86_400, at, 1_000_000 + 86_400_000, boot))
    }

    @Test fun untilRestartLastsUntilTheBootCountChanges() {
        assertFalse(QuickWindow.needsPrompt(QuickWindow.UNTIL_RESTART, at, 1_000_000 + 40L * 86_400_000, boot))
        assertEquals(Long.MAX_VALUE, QuickWindow.remainingMs(QuickWindow.UNTIL_RESTART, at, 2_000_000, boot))
        assertTrue(QuickWindow.needsPrompt(QuickWindow.UNTIL_RESTART, at, 2_000_000, boot + 1))
    }

    @Test fun anyWindowEndsAtARestart() {
        // After a reboot elapsedRealtime starts again near zero; the boot count is what tells.
        assertTrue(QuickWindow.needsPrompt(86_400, at, 1_000_100, boot + 1))
        assertTrue(QuickWindow.needsPrompt(86_400, at, 5_000, boot + 1))
    }

    @Test fun aClockBeforeTheLastPromptMeansPrompt() {
        assertTrue(QuickWindow.needsPrompt(86_400, at, 999_999, boot))
    }

    @Test fun unknownWindowsFallBackToTheDefault() {
        assertEquals(QuickWindow.DEFAULT_S, QuickWindow.normalize(12_345))
        assertEquals(QuickWindow.DEFAULT_S, QuickWindow.normalize(0))
        assertTrue(QuickWindow.needsPrompt(12_345, at, 1_000_000 + QuickWindow.DEFAULT_S * 1000, boot))
        for (w in QuickWindow.CHOICES) assertEquals(w, QuickWindow.normalize(w))
    }

    @Test fun labels() {
        assertEquals(listOf("30 s", "5 min", "1 h", "8 h", "1 day", "until restart"), QuickWindow.CHOICES.map(QuickWindow::label))
    }
}

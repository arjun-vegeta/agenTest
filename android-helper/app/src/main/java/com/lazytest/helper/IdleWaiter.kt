package com.lazytest.helper

import android.app.UiAutomation
import android.view.accessibility.AccessibilityEvent
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

/**
 * Push-based UI idle detection.
 *
 * Replaces the host-side polling loop in `src/android/idle.ts`. Instead of
 * polling `uiautomator dump` every 200ms and fingerprinting, we let the
 * framework tell us when content has changed via AccessibilityEvent.
 *
 * Algorithm:
 *  1. Install a one-shot listener on UiAutomation.
 *  2. Reset the "last event timestamp" to "now".
 *  3. Loop with short sleeps, checking how long since the last event.
 *  4. When `IDLE_QUIET_MS` has passed without a new event, declare idle.
 *  5. Bail out at `timeoutMs` regardless.
 *
 * This typically resolves in 150-300ms — the time it takes the app to
 * complete its layout pass after the input event, plus the IDLE_QUIET_MS
 * settle window. The previous polling approach took 600-2000ms minimum.
 */
class IdleWaiter(private val uiAutomation: UiAutomation) {

    fun waitForIdle(timeoutMs: Long, packageFilter: String?): JSONObject {
        val lastEventAt = AtomicLong(System.currentTimeMillis())
        val recordedEvents = mutableListOf<String>()

        val listener = UiAutomation.OnAccessibilityEventListener { event ->
            val pkg = event.packageName?.toString()
            if (packageFilter != null && pkg != null && pkg != packageFilter) {
                return@OnAccessibilityEventListener
            }
            // Only events that signal "the UI changed" matter for idle.
            val type = event.eventType
            if (type and CONTENT_CHANGE_MASK != 0) {
                lastEventAt.set(System.currentTimeMillis())
                if (recordedEvents.size < MAX_RECORDED) {
                    recordedEvents.add(AccessibilityEvent.eventTypeToString(type))
                }
            }
        }

        val previous = try {
            // Some API levels don't expose the getter; just install ours and
            // restore null on exit.
            null
        } catch (_: Throwable) {
            null
        }

        uiAutomation.setOnAccessibilityEventListener(listener)
        try {
            val deadline = System.currentTimeMillis() + timeoutMs
            // Initial settle: if no event has fired by IDLE_INITIAL_QUIET_MS,
            // assume the app was already idle when we started.
            Thread.sleep(IDLE_INITIAL_QUIET_MS)
            var quietForMs = System.currentTimeMillis() - lastEventAt.get()

            while (quietForMs < IDLE_QUIET_MS) {
                if (System.currentTimeMillis() >= deadline) {
                    return result(false, "timeout", recordedEvents)
                }
                Thread.sleep(POLL_INTERVAL_MS)
                quietForMs = System.currentTimeMillis() - lastEventAt.get()
            }
            return result(true, "events_quiet", recordedEvents)
        } finally {
            uiAutomation.setOnAccessibilityEventListener(previous)
        }
    }

    private fun result(idle: Boolean, reason: String, events: List<String>): JSONObject {
        val arr = JSONArray()
        events.forEach { arr.put(it) }
        return JSONObject().apply {
            put("ok", true)
            put("idle", idle)
            put("reason", reason)
            put("events", arr)
        }
    }

    private companion object {
        private const val IDLE_INITIAL_QUIET_MS = 50L
        private const val IDLE_QUIET_MS = 150L
        private const val POLL_INTERVAL_MS = 25L
        private const val MAX_RECORDED = 16

        // Event types that mean "UI content changed" — used to bucket out
        // noise like TYPE_VIEW_FOCUSED that fires from cursor blinks.
        private const val CONTENT_CHANGE_MASK =
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                AccessibilityEvent.TYPE_WINDOWS_CHANGED or
                AccessibilityEvent.TYPE_VIEW_SCROLLED or
                AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED
    }
}

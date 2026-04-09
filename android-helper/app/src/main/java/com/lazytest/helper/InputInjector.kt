package com.lazytest.helper

import android.app.UiAutomation
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent

/**
 * In-process input injection via UiAutomation.injectInputEvent.
 *
 * Why this is faster than `adb shell input tap`: ADB forks a new app_process
 * from zygote, initializes ART, loads framework classes, parses args, and
 * makes a Binder call to InputManager. That's ~300-600ms of pure overhead.
 *
 * UiAutomation.injectInputEvent runs inside our already-warm instrumentation
 * process and makes the same Binder call directly — typical latency ~5-15ms.
 */
class InputInjector(private val uiAutomation: UiAutomation) {

    fun tap(x: Int, y: Int) {
        val downTime = SystemClock.uptimeMillis()
        injectMotion(downTime, downTime, MotionEvent.ACTION_DOWN, x, y)
        injectMotion(downTime, downTime + TAP_HOLD_MS, MotionEvent.ACTION_UP, x, y)
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int) {
        val downTime = SystemClock.uptimeMillis()
        injectMotion(downTime, downTime, MotionEvent.ACTION_DOWN, x1, y1)

        val steps = (durationMs * SWIPE_FPS / 1000).coerceAtLeast(2)
        val stepDurationMs = durationMs.toFloat() / steps
        for (i in 1..steps) {
            val t = i.toFloat() / steps
            val cx = (x1 + (x2 - x1) * t).toInt()
            val cy = (y1 + (y2 - y1) * t).toInt()
            val eventTime = downTime + (stepDurationMs * i).toLong()
            injectMotion(downTime, eventTime, MotionEvent.ACTION_MOVE, cx, cy)
            // Pace the loop so the dispatcher sees realistic intervals; without
            // this every step is dispatched in the same vsync and apps see a
            // single jump rather than a swipe gesture.
            SystemClock.sleep(stepDurationMs.toLong().coerceAtLeast(1))
        }
        val upTime = downTime + durationMs
        injectMotion(downTime, upTime, MotionEvent.ACTION_UP, x2, y2)
    }

    fun longPress(x: Int, y: Int, durationMs: Int) {
        val downTime = SystemClock.uptimeMillis()
        injectMotion(downTime, downTime, MotionEvent.ACTION_DOWN, x, y)
        SystemClock.sleep(durationMs.toLong())
        injectMotion(downTime, downTime + durationMs, MotionEvent.ACTION_UP, x, y)
    }

    fun key(keycode: Int) {
        val now = SystemClock.uptimeMillis()
        injectKey(now, now, KeyEvent.ACTION_DOWN, keycode)
        injectKey(now, now + KEY_HOLD_MS, KeyEvent.ACTION_UP, keycode)
    }

    fun typeText(text: String) {
        // Use KeyCharacterMap to translate characters to KeyEvents. This
        // matches what `adb shell input text` does internally but without the
        // process-spawn overhead.
        val keyMap = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        val events = keyMap.getEvents(text.toCharArray())
        if (events == null) {
            // Fallback: dispatch character by character; some characters can't
            // be synthesized by the virtual keymap (emoji, complex unicode).
            // We don't currently handle that here — the host falls back to
            // ADB clipboard paste in those cases.
            return
        }
        val now = SystemClock.uptimeMillis()
        for (e in events) {
            // Re-stamp the event so the dispatcher accepts it. Events from
            // KeyCharacterMap.getEvents have a downTime of 0 which the
            // dispatcher rejects.
            val rebuilt = KeyEvent(
                /* downTime = */ now,
                /* eventTime = */ now,
                /* action = */ e.action,
                /* code = */ e.keyCode,
                /* repeat = */ 0,
                /* metaState = */ e.metaState,
                /* deviceId = */ KeyCharacterMap.VIRTUAL_KEYBOARD,
                /* scancode = */ e.scanCode,
                /* flags = */ e.flags or KeyEvent.FLAG_FROM_SYSTEM,
                /* source = */ InputDevice.SOURCE_KEYBOARD,
            )
            uiAutomation.injectInputEvent(rebuilt, true)
        }
    }

    private fun injectMotion(
        downTime: Long,
        eventTime: Long,
        action: Int,
        x: Int,
        y: Int,
    ) {
        val event = MotionEvent.obtain(
            /* downTime = */ downTime,
            /* eventTime = */ eventTime,
            /* action = */ action,
            /* x = */ x.toFloat(),
            /* y = */ y.toFloat(),
            /* metaState = */ 0,
        )
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        try {
            uiAutomation.injectInputEvent(event, true)
        } finally {
            event.recycle()
        }
    }

    private fun injectKey(downTime: Long, eventTime: Long, action: Int, keycode: Int) {
        val event = KeyEvent(
            downTime,
            eventTime,
            action,
            keycode,
            /* repeat = */ 0,
            /* metaState = */ 0,
            /* deviceId = */ KeyCharacterMap.VIRTUAL_KEYBOARD,
            /* scancode = */ 0,
            /* flags = */ KeyEvent.FLAG_FROM_SYSTEM,
            /* source = */ InputDevice.SOURCE_KEYBOARD,
        )
        uiAutomation.injectInputEvent(event, true)
    }

    private companion object {
        private const val TAP_HOLD_MS = 50L
        private const val KEY_HOLD_MS = 30L
        private const val SWIPE_FPS = 60
    }
}

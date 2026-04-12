package com.agentest.helper

import android.app.UiAutomation
import android.graphics.Bitmap
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * In-process screenshot capture via UiAutomation.takeScreenshot.
 *
 * Faster than `adb exec-out screencap -p` because:
 *   - No subprocess fork
 *   - No PNG encoding in adbd then re-decoding on the host
 *   - Bitmap is already in our process memory
 *
 * The PNG encode is the dominant cost (~50-150ms for a 1080x1920 frame).
 * Base64 adds ~30% bandwidth but keeps the response cleanly JSON.
 */
class ScreenshotEncoder(private val uiAutomation: UiAutomation) {

    fun captureBase64(): String {
        val bitmap: Bitmap = uiAutomation.takeScreenshot()
            ?: error("UiAutomation.takeScreenshot returned null")
        try {
            val baos = ByteArrayOutputStream(INITIAL_BUFFER_BYTES)
            bitmap.compress(Bitmap.CompressFormat.PNG, /* quality = */ 100, baos)
            return Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        } finally {
            bitmap.recycle()
        }
    }

    private companion object {
        // Pre-size to ~256 KB; PNGs of typical screens fit in 1-2 MB.
        private const val INITIAL_BUFFER_BYTES = 256 * 1024
    }
}

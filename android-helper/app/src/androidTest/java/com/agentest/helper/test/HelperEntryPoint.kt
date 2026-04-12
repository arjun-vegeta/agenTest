package com.agentest.helper.test

import android.app.UiAutomation
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.Configurator
import com.agentest.helper.HelperServer
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * Long-running entry point for the AgenTest helper.
 *
 * This class is an instrumentation @Test method by name only — the JUnit
 * runner is being abused as a way to keep an Android process alive with
 * shell-UID privileges (granted via `am instrument`).
 *
 * The host MCP server launches us with:
 *
 *     adb shell am instrument -w -r \
 *         com.agentest.helper.test/androidx.test.runner.AndroidJUnitRunner
 *
 * The -w flag makes adb wait for completion. We never complete (we block on
 * a CountDownLatch for up to MAX_RUNTIME_MS), so the host can keep talking
 * to us over the forwarded HTTP port until it sends `kill HelperServer`.
 *
 * Pattern reference: appium/appium-uiautomator2-server (Apache 2.0).
 */
@RunWith(AndroidJUnit4::class)
class HelperEntryPoint {

    @Test
    fun startHelperServer() {
        // Configure UiAutomation flags BEFORE acquiring the instance.
        // FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES keeps TalkBack and other
        // a11y services running so Compose / Flutter trees stay populated for
        // the host MCP server.
        Configurator.getInstance().uiAutomationFlags =
            UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES

        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val ui = instrumentation.uiAutomation
        val server = HelperServer.startSingleton(instrumentation, ui)
        // Block until the server signals shutdown via /shutdown or until the
        // ceiling timeout fires (24h). The instrumentation process exits the
        // moment this method returns.
        server.shutdownLatch.await(MAX_RUNTIME_MS, TimeUnit.MILLISECONDS)
    }

    private companion object {
        private const val MAX_RUNTIME_MS: Long = 24L * 60L * 60L * 1000L
    }
}

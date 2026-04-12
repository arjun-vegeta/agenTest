package com.agentest.helper

import android.app.Instrumentation
import android.app.UiAutomation
import android.os.Build
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.CountDownLatch

/**
 * Embedded HTTP server that exposes UiAutomation primitives over a localhost
 * port. The host TypeScript MCP server reaches us via `adb forward`.
 *
 * Routes:
 *   GET  /status            — health check, returns version info
 *   GET  /tree              — full UI tree as compact JSON
 *   GET  /tree?compact=1    — pruned LLM-friendly tree
 *   GET  /framework         — detect framework (rn / flutter / compose / native)
 *   GET  /screenshot        — base64 PNG of current screen
 *   GET  /wait-idle         — block until UI settles (push-based via a11y events)
 *   POST /tap               — { x, y }
 *   POST /tap-coordinates   — alias for /tap
 *   POST /swipe             — { x1, y1, x2, y2, durationMs }
 *   POST /long-press        — { x, y, durationMs }
 *   POST /key               — { keycode } (numeric Android KeyEvent code)
 *   POST /text              — { text } (uses UiAutomation typing path)
 *   POST /shutdown          — releases the entry-point latch
 *
 * Designed for low overhead: every request handler runs synchronously on
 * NanoHTTPD's worker threads, the UiAutomation instance is acquired once
 * at startup, and JSON serialization happens directly into the response
 * body without intermediate XML.
 */
class HelperServer private constructor(
    private val instrumentation: Instrumentation,
    private val uiAutomation: UiAutomation,
    port: Int,
) : NanoHTTPD("127.0.0.1", port) {

    val shutdownLatch: CountDownLatch = CountDownLatch(1)

    private val treeDumper = TreeDumper(uiAutomation)
    private val inputInjector = InputInjector(uiAutomation)
    private val idleWaiter = IdleWaiter(uiAutomation)
    private val screenshotEncoder = ScreenshotEncoder(uiAutomation)
    private val frameworkDetector = FrameworkDetector(instrumentation)

    override fun serve(session: IHTTPSession): Response {
        return try {
            route(session)
        } catch (t: Throwable) {
            Log.e(TAG, "Handler error for ${session.method} ${session.uri}", t)
            errorResponse(t)
        }
    }

    private fun route(session: IHTTPSession): Response {
        val uri = session.uri.trimEnd('/')
        return when {
            session.method == Method.GET && uri == "/status" -> handleStatus()
            session.method == Method.GET && uri == "/tree" -> handleTree(session)
            session.method == Method.GET && uri == "/framework" -> handleFramework(session)
            session.method == Method.GET && uri == "/screenshot" -> handleScreenshot()
            session.method == Method.GET && uri == "/wait-idle" -> handleWaitIdle(session)
            session.method == Method.POST && (uri == "/tap" || uri == "/tap-coordinates") ->
                handleTap(session)
            session.method == Method.POST && uri == "/swipe" -> handleSwipe(session)
            session.method == Method.POST && uri == "/long-press" -> handleLongPress(session)
            session.method == Method.POST && uri == "/key" -> handleKey(session)
            session.method == Method.POST && uri == "/text" -> handleText(session)
            session.method == Method.POST && uri == "/shutdown" -> handleShutdown()
            else -> notFound(uri)
        }
    }

    // ----- Handlers ---------------------------------------------------------

    private fun handleStatus(): Response {
        val body = JSONObject().apply {
            put("ok", true)
            put("name", "agentest-helper")
            put("version", VERSION)
            put("protocolVersion", PROTOCOL_VERSION)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("device", Build.MODEL)
            put("manufacturer", Build.MANUFACTURER)
        }
        return jsonResponse(body)
    }

    private fun handleTree(session: IHTTPSession): Response {
        val params = session.parameters
        val compact = params["compact"]?.firstOrNull() == "1"
        val packageName = params["package"]?.firstOrNull()
        val tree = treeDumper.dump(packageName, compact = compact)
        return jsonResponse(tree)
    }

    private fun handleFramework(session: IHTTPSession): Response {
        val packageName = session.parameters["package"]?.firstOrNull()
        val info = frameworkDetector.detect(packageName)
        return jsonResponse(info)
    }

    private fun handleScreenshot(): Response {
        val base64 = screenshotEncoder.captureBase64()
        val body = JSONObject().apply {
            put("ok", true)
            put("format", "png")
            put("base64", base64)
        }
        return jsonResponse(body)
    }

    private fun handleWaitIdle(session: IHTTPSession): Response {
        val timeoutMs = session.parameters["timeoutMs"]
            ?.firstOrNull()
            ?.toLongOrNull()
            ?: DEFAULT_IDLE_TIMEOUT_MS
        val packageName = session.parameters["package"]?.firstOrNull()
        val result = idleWaiter.waitForIdle(timeoutMs, packageName)
        return jsonResponse(result)
    }

    private fun handleTap(session: IHTTPSession): Response {
        val body = readJsonBody(session)
        val x = body.getInt("x")
        val y = body.getInt("y")
        inputInjector.tap(x, y)
        return ok()
    }

    private fun handleSwipe(session: IHTTPSession): Response {
        val body = readJsonBody(session)
        val x1 = body.getInt("x1")
        val y1 = body.getInt("y1")
        val x2 = body.getInt("x2")
        val y2 = body.getInt("y2")
        val durationMs = body.optInt("durationMs", DEFAULT_SWIPE_MS)
        inputInjector.swipe(x1, y1, x2, y2, durationMs)
        return ok()
    }

    private fun handleLongPress(session: IHTTPSession): Response {
        val body = readJsonBody(session)
        val x = body.getInt("x")
        val y = body.getInt("y")
        val durationMs = body.optInt("durationMs", DEFAULT_LONG_PRESS_MS)
        inputInjector.longPress(x, y, durationMs)
        return ok()
    }

    private fun handleKey(session: IHTTPSession): Response {
        val body = readJsonBody(session)
        val keycode = body.getInt("keycode")
        inputInjector.key(keycode)
        return ok()
    }

    private fun handleText(session: IHTTPSession): Response {
        val body = readJsonBody(session)
        val text = body.getString("text")
        inputInjector.typeText(text)
        return ok()
    }

    private fun handleShutdown(): Response {
        shutdownLatch.countDown()
        return ok()
    }

    // ----- Helpers ----------------------------------------------------------

    private fun readJsonBody(session: IHTTPSession): JSONObject {
        val files = HashMap<String, String>()
        session.parseBody(files)
        val raw = files["postData"]
            ?: session.parameters["postData"]?.firstOrNull()
            ?: throw IOException("Missing JSON body")
        return JSONObject(raw)
    }

    private fun jsonResponse(body: JSONObject): Response {
        val res = newFixedLengthResponse(
            Response.Status.OK,
            CONTENT_TYPE_JSON,
            body.toString(),
        )
        res.addHeader("X-Helper-Version", VERSION)
        return res
    }

    private fun ok(): Response {
        val body = JSONObject().put("ok", true)
        return jsonResponse(body)
    }

    private fun notFound(uri: String): Response {
        val body = JSONObject().apply {
            put("ok", false)
            put("error", "No handler for $uri")
            put("code", "NOT_FOUND")
        }
        return newFixedLengthResponse(
            Response.Status.NOT_FOUND,
            CONTENT_TYPE_JSON,
            body.toString(),
        )
    }

    private fun errorResponse(t: Throwable): Response {
        val body = JSONObject().apply {
            put("ok", false)
            put("error", t.message ?: t::class.java.simpleName)
            put("code", t::class.java.simpleName)
        }
        return newFixedLengthResponse(
            Response.Status.INTERNAL_ERROR,
            CONTENT_TYPE_JSON,
            body.toString(),
        )
    }

    companion object {
        private const val TAG = "AgenTestHelper"
        const val VERSION = "1.0.0"

        // Bumped whenever the wire protocol changes incompatibly. The host
        // TypeScript installer compares this against `expectedProtocolVersion`
        // and reinstalls if mismatched.
        const val PROTOCOL_VERSION = 1

        const val DEFAULT_PORT = 8765
        private const val CONTENT_TYPE_JSON = "application/json; charset=utf-8"
        private const val DEFAULT_IDLE_TIMEOUT_MS = 10_000L
        private const val DEFAULT_SWIPE_MS = 300
        private const val DEFAULT_LONG_PRESS_MS = 1000

        @Volatile private var instance: HelperServer? = null

        /**
         * Start (or return the already-running) singleton helper server.
         *
         * Called from the @Test entry point. Idempotent — calling it twice
         * within the same instrumentation process returns the same instance.
         */
        @Synchronized
        fun startSingleton(
            instrumentation: Instrumentation,
            uiAutomation: UiAutomation,
        ): HelperServer {
            instance?.let { return it }
            val server = HelperServer(instrumentation, uiAutomation, DEFAULT_PORT)
            server.start(SOCKET_READ_TIMEOUT_MS, false)
            instance = server
            Log.i(TAG, "AgenTest helper started on port $DEFAULT_PORT (v$VERSION)")
            return server
        }

        // NanoHTTPD socket read timeout. Defaults to 5s; we set it higher
        // because /wait-idle can legitimately block for several seconds.
        private const val SOCKET_READ_TIMEOUT_MS = 60_000
    }
}

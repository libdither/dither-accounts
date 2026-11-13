package org.libdither.approver

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request as HttpRequest
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The links to the paired managers (docs/approver.md, The link): one WebSocket each to <url>/approver/ws. Kept open
 * while the app is in the foreground, for two minutes after a push wakes it, and while a request waits on screen.
 * Everything here runs on the main thread; OkHttp's callbacks post to it.
 */
object Links {
    private const val TAG = "ApproverLink"
    const val WAKE_MS = 120_000L
    val main = Handler(Looper.getMainLooper())
    private val links = mutableMapOf<String, Link>()
    private var foreground = false
    private var wakeUntil = 0L
    private val listeners = mutableListOf<() -> Unit>()
    lateinit var app: Context
    val ws: OkHttpClient by lazy { Pairings.http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build() }

    fun init(c: Context) {
        if (::app.isInitialized) return
        app = c.applicationContext
        Store.init(app)
    }

    fun listen(f: () -> Unit) { listeners += f }
    fun unlisten(f: () -> Unit) { listeners -= f }
    fun changed() = listeners.toList().forEach { it() }

    fun setForeground(on: Boolean) {
        foreground = on
        refresh()
    }

    val isForeground get() = foreground

    /** A push said a request waits: open every link for a while. */
    fun wake(c: Context) {
        init(c)
        main.post {
            wakeUntil = SystemClock.elapsedRealtime() + WAKE_MS
            refresh()
            main.postDelayed({ refresh() }, WAKE_MS + 1000)
        }
    }

    private fun wanted() = foreground || SystemClock.elapsedRealtime() < wakeUntil || Approvals.pending.isNotEmpty()

    /** Opens or closes links to match what is wanted and which pairings exist. */
    fun refresh() {
        val want = wanted()
        val live = Store.pairings.filter { !it.forgotten }.associateBy { it.deviceId }
        for ((id, l) in links.toMap()) if (id !in live || (!want && !l.busy)) {
            l.close()
            links.remove(id)
        }
        if (want) for ((id, p) in live) links.getOrPut(id) { Link(p).also { it.open() } }
        changed()
    }

    fun close(deviceId: String) {
        links.remove(deviceId)?.close()
        changed()
    }

    fun state(deviceId: String): String = links[deviceId]?.state ?: "closed"

    /** Sends on that device's link; queued until the link is ready if it is not. */
    fun send(deviceId: String, o: JSONObject) {
        val l = links[deviceId] ?: Store.pairing(deviceId)?.takeIf { !it.forgotten }?.let { p -> Link(p).also { links[deviceId] = it; it.open() } }
        if (l == null) {
            Log.w(TAG, "no link for $deviceId; dropped a ${o.optString("t")}")
            return
        }
        l.send(o)
    }

    /** Tells every open link this phone's push endpoint (or null after unregistering). */
    fun sendPush() {
        for (l in links.values) l.sendPush()
    }
}

class Link(val p: Pairing) {
    var state = "connecting"
        private set
    private var ws: WebSocket? = null
    private var ready = false
    private var closed = false
    private var backoff = 1000L
    private var lastFrame = 0L
    private val outbox = ArrayDeque<JSONObject>()
    private val main get() = Links.main

    fun open() {
        if (closed) return
        state = "connecting"
        ready = false
        lastFrame = SystemClock.elapsedRealtime()
        val req = HttpRequest.Builder().url("${p.url}/approver/ws").build()
        ws = Links.ws.newWebSocket(req, Listener())
        main.removeCallbacks(watchdog)
        main.postDelayed(watchdog, 30_000)
        Links.changed()
    }

    fun close() {
        closed = true
        main.removeCallbacks(watchdog)
        main.removeCallbacks(reopen)
        ws?.close(1000, null)
        ws = null
        state = "closed"
    }

    /** Answers wait in the outbox: the link stays until they are sent. */
    val busy get() = outbox.isNotEmpty()

    fun send(o: JSONObject) {
        if (ready) ws?.send(o.toString()) else outbox.addLast(o)
    }

    fun sendPush() {
        if (ready) ws?.send(JSONObject().put("t", "push").put("endpoint", Store.pushEndpoint ?: JSONObject.NULL).toString())
    }

    /** The server pings every 30 s; after 95 s without a frame the link is taken as dead and reopened. */
    private val watchdog = object : Runnable {
        override fun run() {
            if (closed) return
            if (SystemClock.elapsedRealtime() - lastFrame > 95_000) ws?.cancel() else main.postDelayed(this, 30_000)
        }
    }

    private val reopen = Runnable { open() }

    private fun dropped(why: String) {
        ws = null
        ready = false
        main.removeCallbacks(watchdog)
        if (closed) return
        state = why
        main.removeCallbacks(reopen)
        main.postDelayed(reopen, backoff)
        backoff = (backoff * 2).coerceAtMost(30_000)
        Links.changed()
    }

    private inner class Listener : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            val o = runCatching { JSONObject(text) }.getOrNull() ?: return
            // The hello is signed here, off the main thread (a StrongBox signature can take a moment).
            val hello = if (o.optString("t") == "challenge") runCatching {
                val nonce = o.getString("nonce")
                val sig = WebAuthn.sign(Keys.signer(p.keyAlias), WebAuthn.helloInput(p.deviceId, nonce))
                JSONObject().put("t", "hello").put("deviceId", p.deviceId).put("sig", B64.url(sig)).put("app", "android/${BuildConfig.VERSION_NAME}")
            }.getOrElse { e -> Store.addLog("Could not sign the link's hello for ${p.url}: ${e.message}"); null } else null
            main.post {
                if (webSocket !== ws) return@post
                lastFrame = SystemClock.elapsedRealtime()
                when (o.optString("t")) {
                    "challenge" -> if (hello != null) webSocket.send(hello.toString()) else webSocket.close(1000, null)
                    "ready" -> {
                        ready = true
                        backoff = 1000
                        state = "ready"
                        if (Store.pushEndpoint != null) sendPush()
                        while (outbox.isNotEmpty()) webSocket.send(outbox.removeFirst().toString())
                        Links.refresh()
                    }
                    "ping" -> webSocket.send("""{"t":"pong"}""")
                    "pong" -> {}
                    "request" -> if (ready) Approvals.onRequest(p, o)
                }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
            main.post {
                if (webSocket !== ws) return@post
                if (code == 4401) {
                    // Unknown device or bad signature: the manager removed this phone (or never had it). Stop trying.
                    p.forgotten = true
                    runCatching { Store.save() }
                    Store.addLog("${p.url} no longer knows this phone (4401): pair again to use it")
                    closed = true
                    ws = null
                    ready = false
                    state = "removed by the manager"
                    Links.changed()
                } else dropped("reconnecting (closed $code)")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            main.post { if (webSocket === ws) dropped("reconnecting (${t.javaClass.simpleName})") }
        }
    }
}

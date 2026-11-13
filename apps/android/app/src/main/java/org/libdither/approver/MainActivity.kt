package org.libdither.approver

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The app's one screen, with four views: Requests (what waits, the pairings and their links, wake-ups), Pair,
 * Passkeys and Log. Hand-built views: there is little to show and nothing to load.
 */
class MainActivity : Activity() {
    private lateinit var content: LinearLayout
    private lateinit var tabs: LinearLayout
    private var tab = "home"
    private var linkText = ""
    private var link: PairLink.Parsed? = null
    private var deviceName = Build.MODEL ?: "Android phone"
    private var pairMsg: String? = null
    private var pairing = false
    private var justPaired: Pairing? = null
    private var pushMsg: String? = null
    private val onChange: () -> Unit = { render() }
    /** The shown request's countdown, updated each second without rebuilding the view. */
    private var countdown: Pair<TextView, Long>? = null
    private val tick = object : Runnable {
        override fun run() {
            countdown?.let { (t, at) -> t.text = expiresIn(at) }
            Links.main.postDelayed(this, 1000)
        }
    }

    private fun expiresIn(at: Long) = "Expires in: ${((at - System.currentTimeMillis()) / 1000).coerceAtLeast(0)} s"

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        Links.init(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(TextView(this).apply {
            text = "dither-approver"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(16), dp(12), dp(16), dp(4))
        })
        tabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(dp(8), 0, dp(8), 0) }
        root.addView(tabs)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(8), dp(16), dp(24)) }
        root.addView(ScrollView(this).apply { addView(content) }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        root.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsets.CONSUMED
        }
        setContentView(root)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        Links.listen(onChange)
        Links.setForeground(true)
        Notify.show(this)
        Links.main.post(tick)
        render()
    }

    override fun onStop() {
        Links.main.removeCallbacks(tick)
        Links.unlisten(onChange)
        Links.setForeground(false)
        Notify.show(this)
        super.onStop()
    }

    /** A pairing link from the QR (the system camera or a browser opening it) fills the Pair view; pairing waits for a tap. */
    private fun handle(i: Intent?) {
        val data = i?.dataString ?: return
        if (!data.startsWith("dither-approver:")) return
        useLink(data)
        i.data = null
    }

    private fun useLink(text: String) {
        linkText = text.trim()
        link = PairLink.parse(linkText, BuildConfig.DEBUG)
        justPaired = null
        pairMsg = if (link == null) {
            if (BuildConfig.DEBUG) "That is not a pairing link (dither-approver://pair?url=…&code=…)." else "That is not a pairing link (dither-approver://pair?url=https://…&code=…)."
        } else null
        tab = "pair"
        render()
    }

    @Deprecated("Activity result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 2 && resultCode == RESULT_OK) data?.getStringExtra(ScanActivity.EXTRA_TEXT)?.let { useLink(it) }
    }

    // ------------------------------------------------------------------ views

    private fun render() {
        renderTabs()
        countdown = null
        content.removeAllViews()
        when (tab) {
            "home" -> home()
            "pair" -> pair()
            "keys" -> keys()
            "log" -> log()
        }
    }

    private fun renderTabs() {
        tabs.removeAllViews()
        val waiting = Approvals.pending.size
        for ((id, label) in listOf("home" to if (waiting > 0) "Requests ($waiting)" else "Requests", "pair" to "Pair", "keys" to "Passkeys", "log" to "Log")) {
            tabs.addView(Button(this, null, android.R.attr.borderlessButtonStyle).apply {
                text = label
                isAllCaps = false
                alpha = if (id == tab) 1f else 0.6f
                setTypeface(typeface, if (id == tab) Typeface.BOLD else Typeface.NORMAL)
                setOnClickListener { tab = id; render() }
            })
        }
    }

    private fun home() {
        val first = Approvals.pending.firstOrNull()
        if (first != null) request(first) else text("Nothing waiting.", muted = true)
        if (Approvals.pending.size > 1) text("${Approvals.pending.size - 1} more waiting after this one.", muted = true)

        heading("Paired managers")
        if (Store.pairings.isEmpty()) {
            text("Not paired. On the manager's page: Approvers → Pair a phone, then scan its QR or paste its link here.")
            button("Pair") { tab = "pair"; render() }
        }
        for (p in Store.pairings) {
            text(p.url, bold = true)
            text("This phone there: ${p.name.ifEmpty { "(no name)" }}, ${p.deviceId}, paired ${time(p.pairedAt)}", muted = true)
            text("Key fingerprint  ${p.fingerprint}", mono = true)
            text(if (p.forgotten) "The manager no longer knows this phone. Pair again." else "Link: ${Links.state(p.deviceId)}")
            row(button("Unpair", add = false) {
                confirm("Unpair from ${p.url}?", "This phone stops answering it. Its passkeys stay until you delete them; remove the phone on the page too.") { Pairings.unpair(p); render() }
            })
        }

        heading("Wake-ups")
        val endpoint = Store.pushEndpoint
        text(
            when {
                endpoint != null -> "On, through ${Push.distributor(this) ?: "UnifiedPush"}. A request waiting on the manager wakes this app."
                else -> "Off${Store.pushStatus?.let { " ($it)" } ?: ""}. Without them, requests reach this phone only while the app is open."
            },
        )
        pushMsg?.let { text(it) }
        if (endpoint == null) button("Turn on (UnifiedPush)") {
            askNotifications()
            Push.enable(this) { pushMsg = it; render() }
        } else button("Turn off") { Push.disable(this); render() }
    }

    private fun request(x: Pending) {
        val r = x.r
        heading(if (r.op == "create") "Create a passkey" else "Sign in")
        field("Account", if (r.accountKind.isNotEmpty()) "${r.accountLabel} (${r.accountKind})" else r.accountLabel)
        field("Site", r.rpId)
        field("Asked from", r.origin)
        field("Why", r.reason.ifEmpty { "(no reason given)" })
        field("Asked at", time(x.receivedAt, "HH:mm:ss"))
        field("Approved for ${r.rpId} today", "${Store.signedToday(r.rpId)} times")
        x.credential?.let { field("Passkey", "${it.id.take(8)}…, used ${it.counter} times") }
        field("Manager", x.p.url)
        countdown = text(expiresIn(r.expiresAt)) to r.expiresAt
        x.note?.let { text(it) }
        row(
            button(if (x.busy) "Waiting…" else "Approve", add = false) { Approvals.approve(this, x); render() },
            button("Deny", add = false) { Approvals.deny(x) },
        )
    }

    private fun pair() {
        heading("Pair with a manager")
        text("On the manager's page: Approvers → Pair a phone. Scan its QR, or copy its link and paste it here.")
        val input = EditText(this).apply {
            hint = "dither-approver://pair?url=…&code=…"
            setText(linkText)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        content.addView(input)
        row(
            button("Use this link", add = false) { useLink(input.text.toString()) },
            button("Paste", add = false) {
                val clip = getSystemService(ClipboardManager::class.java).primaryClip
                useLink(clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString().orEmpty())
            },
            button("Scan QR", add = false) {
                @Suppress("DEPRECATION")
                startActivityForResult(Intent(this, ScanActivity::class.java), 2)
            },
        )
        val l = link
        if (l != null && justPaired == null) {
            field("Manager", l.url)
            field("Code", l.code.take(4) + "…")
            val name = EditText(this).apply { setText(deviceName); hint = "This phone's name"; setSingleLine() }
            content.addView(name)
            button(if (pairing) "Pairing…" else "Pair") {
                if (pairing) return@button
                deviceName = name.text.toString().trim().ifEmpty { Build.MODEL ?: "Android phone" }
                pairing = true
                pairMsg = null
                render()
                val app = applicationContext
                Thread {
                    val result = runCatching { Pairings.pair(app, l.url, l.code, deviceName) }
                    runOnUiThread {
                        pairing = false
                        result.onSuccess { justPaired = it; link = null; linkText = ""; askNotifications(); Links.refresh() }
                            .onFailure { pairMsg = it.message ?: it.javaClass.simpleName }
                        render()
                    }
                }.start()
            }
        }
        pairMsg?.let { text(it) }
        justPaired?.let {
            heading("Paired")
            text("Compare this with the fingerprint the page shows beside the new device. If they differ, unpair and remove it there.")
            text(it.fingerprint, mono = true, big = true)
            text("${it.url}\n${it.deviceId}", muted = true)
        }
    }

    private fun keys() {
        heading("Passkeys on this phone")
        if (Store.credentials.isEmpty()) text("None yet. A site's \"add a passkey\", asked through a paired manager, makes one here.", muted = true)
        for (c in Store.credentials.sortedByDescending { it.createdAt }) {
            text("${c.account} — ${c.rpId}", bold = true)
            text(
                "id ${c.id.take(8)}…  created ${time(c.createdAt)}\n" +
                    "last used ${c.lastUsedAt?.let { time(it) } ?: "never"}, counter ${c.counter}\n" +
                    "key in ${c.where}, through ${c.url}",
                muted = true,
            )
            button("Delete") {
                confirm("Delete the passkey for ${c.account} on ${c.rpId}?", "The key is destroyed; the site won't accept it any more. Remove it in the site's settings and on the manager's page too.") {
                    synchronized(Store) {
                        Store.credentials.remove(c)
                        runCatching { Store.save() }
                    }
                    Keys.delete(c.keyAlias)
                    Store.addLog("Deleted the passkey ${c.id.take(8)} for ${c.account} on ${c.rpId}")
                    render()
                }
            }
        }
    }

    private fun log() {
        heading("Refusals and errors")
        if (Store.log.isEmpty()) text("Nothing yet.", muted = true)
        for (l in Store.log.asReversed()) text("${time(l.at, "MM-dd HH:mm:ss")}  ${l.text}")
    }

    // ------------------------------------------------------------------ bits

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 3)
        }
    }

    private fun confirm(title: String, msg: String, yes: () -> Unit) {
        AlertDialog.Builder(this).setTitle(title).setMessage(msg).setPositiveButton("Yes") { _, _ -> yes() }.setNegativeButton("Cancel", null).show()
    }

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    private fun time(ms: Long, pattern: String = "yyyy-MM-dd HH:mm"): String = DateTimeFormatter.ofPattern(pattern).withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(ms))

    private fun heading(s: String) = text(s, bold = true, big = true).also { it.setPadding(0, dp(16), 0, dp(4)) }

    private fun field(label: String, value: String) = text("$label: $value")

    private fun text(s: String, bold: Boolean = false, muted: Boolean = false, mono: Boolean = false, big: Boolean = false): TextView {
        val t = TextView(this).apply {
            text = s
            setTextIsSelectable(mono)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, if (big) 18f else 15f)
            if (bold) setTypeface(typeface, Typeface.BOLD)
            if (mono) typeface = Typeface.MONOSPACE
            if (muted) alpha = 0.7f
            setPadding(0, dp(3), 0, dp(3))
        }
        content.addView(t)
        return t
    }

    private fun button(label: String, add: Boolean = true, onClick: () -> Unit): Button {
        val b = Button(this).apply {
            text = label
            isAllCaps = false
            setOnClickListener { onClick() }
        }
        if (add) content.addView(b, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        return b
    }

    private fun row(vararg views: View) {
        val r = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.START }
        for (v in views) r.addView(v, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginEnd = dp(8) })
        content.addView(r)
    }
}

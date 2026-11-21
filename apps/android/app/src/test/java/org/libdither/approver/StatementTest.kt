package org.libdither.approver

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * Approvals' statement and checks. The vector was computed with dither-chat's packages/approvals/src/statement.ts
 * (mergePayload, displayHash, messageHash, statementText, fingerprint; a WebCrypto P-256 key and derSignature).
 */
class StatementTest {
    private val payload = "dither-merge-v1\nrepo system-config\ntarget main\nbranch review/fix-caddy\n" +
        "base ${"a".repeat(40)}\nhead ${"b".repeat(40)}\ntree ${"c".repeat(40)}\n"
    private val title = "Merge review/fix-caddy into main (system-config)"
    private val body = "a1b2c3d Fix the proxy — ✓\n\n 1 file changed, 2 insertions(+)\nci ok"
    private val message = "ok, but rebuild the other host after ✓"

    private val payloadSha = "a5ef3ad01063c74515442676b5a1382a5ae29ebf9abaf037506270e3c6bbfb67"
    private val displaySha = "08cc408d440bf4ddda4267c225b5b0328c043449d64532fe840f5174edfa1059"
    private val messageSha = "21ba0aa030258b3b1b8bc6a56d6de3d7a61402934bb28a98bc3b0e3a263acc05"

    private val askText = "dither-approval-v1\n" +
        "id apv_3qJ0d1x8Yc4mT2bE9kQwZp\n" +
        "kind merge\n" +
        "asker review\n" +
        "created 1763600000000\n" +
        "expires 1763603600000\n" +
        "payload-sha256 $payloadSha\n" +
        "display-sha256 $displaySha\n"
    private val statement = askText +
        "action approve\n" +
        "message-sha256 $messageSha\n" +
        "device dev_Q2hTcFk3a0xYb1pW\n" +
        "signed 1763600123456\n"

    /** The TS reference's key and its DER signature over `statement` (r has its high bit set: a 33-byte INTEGER). */
    private val spki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhq2dtbOkP4hUqcBH/D+K3hJ/1jpP2XWtXdsubyMLrArONEXdMIiFwnVyEX4j4zHZf4AJQ9o1Ipv91YBDU1f6aw=="
    private val fingerprint = "cb:28:73:99:0c:00:9e:c8"
    private val rawHex = "de2b33118176dd784bd4faf70f20b7723817de656b1308a525a7c5fba5e83ae4d8d35684ddd6b2d048caf771ea709a11209abcf6a8800dd15152d587f8d6e45b"
    private val der = "MEYCIQDeKzMRgXbdeEvU-vcPILdyOBfeZWsTCKUlp8X7peg65AIhANjTVoTd1rLQSMr3cepwmhEgmrz2qIAN0VFS1Yf41uRb"

    private val now = 1763600000001L

    @Test fun hashes() {
        assertEquals(payloadSha, Statement.sha256hex(payload))
        assertEquals(displaySha, Statement.displayHash(title, body))
        assertEquals(messageSha, Statement.messageHash(message))
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Statement.messageHash(null))
    }

    @Test fun statementByteForByte() {
        val ask = Statement.parseAsk(askText)
        assertEquals(askText, ask.text())
        val text = Statement.text(ask, "approve", Statement.messageHash(message), "dev_Q2hTcFk3a0xYb1pW", 1763600123456)
        assertArrayEquals(statement.toByteArray(Charsets.UTF_8), text.toByteArray(Charsets.UTF_8))
    }

    @Test fun keysInput() = assertEquals(
        "dither-approver-key-v1\ndev_Q2hTcFk3a0xYb1pW\nphone\n$spki",
        String(Statement.keysInput("dev_Q2hTcFk3a0xYb1pW", "phone", spki), Charsets.UTF_8),
    )

    @Test fun fingerprintOfTheReferenceKey() = assertEquals(fingerprint, WebAuthn.fingerprint(java.util.Base64.getDecoder().decode(spki)))

    // ------------------------------------------------------------------ DER

    @Test fun referenceDerVerifiesHere() {
        val pub = WebAuthn.publicKeyFromSpki(java.util.Base64.getDecoder().decode(spki))
        assertTrue(WebAuthn.verify(pub, statement.toByteArray(Charsets.UTF_8), B64.fromUrl(der)))
        assertEquals(rawHex, Statement.hex(Statement.rawSignature(B64.fromUrl(der))!!))
        // Another statement (one byte off) doesn't.
        assertTrue(!WebAuthn.verify(pub, statement.replace("approve", "approvf").toByteArray(Charsets.UTF_8), B64.fromUrl(der)))
    }

    @Test fun jdkDerIsWhatTheReferenceReads() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val bytes = statement.toByteArray(Charsets.UTF_8)
        repeat(20) {
            val sig = WebAuthn.sign(Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private) }, bytes)
            val raw = Statement.rawSignature(sig)
            assertNotNull(raw)
            assertEquals(64, raw!!.size)
            assertTrue(WebAuthn.verify(kp.public as ECPublicKey, bytes, sig))
            // base64url without padding, as the answer carries it
            assertTrue(Regex("^[A-Za-z0-9_-]+$").matches(B64.url(sig)))
        }
    }

    @Test fun malformedDer() {
        val good = B64.fromUrl(der)
        assertNull(Statement.rawSignature(good.copyOf(good.size - 1)))
        assertNull(Statement.rawSignature(good + byteArrayOf(0)))
        assertNull(Statement.rawSignature(byteArrayOf(0x31) + good.copyOfRange(1, good.size)))
        assertNull(Statement.rawSignature(ByteArray(4)))
    }

    // ------------------------------------------------------------------ the checks

    private fun actions(vararg a: Pair<String, String>) = JSONArray(a.map { JSONObject().put("id", it.first).put("label", it.first.replaceFirstChar { c -> c.uppercase() }).put("needs", it.second) })

    private fun frame(
        ask: String = askText,
        id: String = "apv_3qJ0d1x8Yc4mT2bE9kQwZp",
        kind: String = "merge",
        asker: String = "review",
        title: String = this.title,
        body: String = this.body,
        payload: String = this.payload,
        actions: JSONArray = actions("approve" to "signed", "deny" to "any"),
    ) = JSONObject().put("t", "request").put("id", id).put("op", "approve").put("ask", ask).put("expiresAt", 1763603600000)
        .put("display", JSONObject().put("kind", kind).put("asker", asker).put("title", title).put("body", body).put("payload", payload).put("urgency", "normal").put("actions", actions))

    /** An ask over other title, body and payload, so a check further on is the one that fails. */
    private fun askFor(title: String = this.title, body: String = this.body, payload: String = this.payload, kind: String = "merge", expires: Long = 1763603600000) =
        "dither-approval-v1\nid apv_3qJ0d1x8Yc4mT2bE9kQwZp\nkind $kind\nasker review\ncreated 1763600000000\nexpires $expires\n" +
            "payload-sha256 ${Statement.sha256hex(payload)}\ndisplay-sha256 ${Statement.displayHash(title, body)}\n"

    private fun refused(o: JSONObject, why: String, at: Long = now) {
        try {
            Statement.check(o, at)
            fail("expected a refusal: $why")
        } catch (e: IllegalArgumentException) {
            assertTrue("\"${e.message}\" should say $why", e.message!!.contains(why))
        }
    }

    @Test fun goodRequest() {
        val a = Statement.check(frame(), now)
        assertEquals("apv_3qJ0d1x8Yc4mT2bE9kQwZp", a.id)
        assertEquals(askText, a.askText)
        assertEquals(listOf("approve", "deny"), a.display.actions.map { it.id })
        assertEquals(listOf(true, false), a.display.actions.map { it.signed })
        assertEquals(7, a.display.payloadLines.size)
    }

    @Test fun askNotEightLines() {
        refused(frame(ask = askText + "action approve\n"), "fields")
        refused(frame(ask = askText.removeSuffix("\n")), "newline")
        refused(frame(ask = askText.replace("dither-approval-v1", "dither-approval-v2")), "isn't dither-approval-v1")
        refused(frame(ask = askText.replace("asker review\ncreated", "created")), "fields")
        refused(frame(ask = askText.replace("kind merge\nasker review", "asker review\nkind merge")), "isn't kind")
        refused(frame(ask = askText.replace("created 1763600000000", "created 01763600000000")), "a bad created")
        refused(frame(ask = askText.replace("kind merge", "kind launch")), "unknown kind")
        refused(frame(ask = askText.replace(payloadSha, payloadSha.uppercase())), "a bad payload-sha256")
        refused(frame(ask = askText.replace("asker review", "asker Review")), "a bad asker")
        refused(frame(ask = askText.replace("apv_3qJ0d1x8Yc4mT2bE9kQwZp", "apv_short"), id = "apv_short"), "a bad id")
    }

    @Test fun idMismatch() = refused(frame(id = "apv_000000000000000000000A"), "isn't the request's")

    @Test fun payloadHashMismatch() = refused(frame(payload = payload.replace("main", "next")), "payload-sha256")

    @Test fun displayHashMismatch() {
        refused(frame(title = "Merge something else"), "display-sha256")
        refused(frame(body = body + "\n"), "display-sha256")
    }

    @Test fun titleThatMovesTheBoundary() {
        // "a\n\nb" + "" hashes like "a" + "b": a title is one line, so this is refused before the hashes.
        refused(frame(ask = askFor(title = "a\n\nb", body = ""), title = "a\n\nb", body = ""), "one line")
    }

    @Test fun kindAndAskerMustEqualDisplays() {
        refused(frame(kind = "rebuild"), "display's kind")
        refused(frame(asker = "deployer"), "display's asker")
    }

    @Test fun expired() {
        refused(frame(), "expired", at = 1763603600000)
        refused(frame(), "expired", at = 1763603600001)
    }

    @Test fun actionsWellFormed() {
        refused(frame(actions = actions("approve" to "signed")), "no deny")
        refused(frame(actions = actions("approve" to "signed", "Deny" to "any")), "a bad action id")
        refused(frame(actions = actions("approve" to "always", "deny" to "any")), "not signed or any")
        refused(frame(actions = actions("approve" to "signed", "approve" to "any", "deny" to "any")), "twice")
        refused(frame(actions = JSONArray().put("deny")), "isn't an object")
        refused(frame().apply { getJSONObject("display").remove("actions") }, "no actions")
    }

    @Test fun payloadWellFormed() {
        val bad = payload.replace("tree ${"c".repeat(40)}", "tree main")
        refused(frame(ask = askFor(payload = bad), payload = bad), "full ids")
        val unordered = "dither-merge-v1\nrepo r\n"
        refused(frame(ask = askFor(payload = unordered), payload = unordered), "repo, target")
        val notAscii = payload.replace("main", "mäin")
        refused(frame(ask = askFor(payload = notAscii), payload = notAscii), "ASCII")
        refused(frame(ask = askFor(payload = ""), payload = ""), "without a payload")
    }

    @Test fun deployWithAnAnyAction() {
        val p = "dither-deploy-v1\nhost laptop\ncommit ${"d".repeat(40)}\nstate failed\nreason the switch failed\n"
        val a = Statement.check(
            frame(ask = askFor(payload = p, kind = "deploy"), kind = "deploy", payload = p, actions = actions("resume" to "signed", "hold" to "any", "deny" to "any")),
            now,
        )
        assertEquals(listOf("resume", "hold", "deny"), a.display.actions.map { it.id })
    }

    @Test fun notApprove() = refused(frame().put("op", "get"), "op is get")
}

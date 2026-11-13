package org.libdither.approver

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChecksTest {
    private fun cdj(type: String, origin: String) =
        B64.url("""{"type":"$type","challenge":"Y2hhbGxlbmdl","origin":"$origin","crossOrigin":false}""".toByteArray())

    private fun req(op: String = "get", rpId: String, origin: String, cdType: String = "webauthn.$op", cdOrigin: String = origin, expiresAt: Long = Long.MAX_VALUE): Request {
        val o = JSONObject().put("t", "request").put("id", "r1").put("op", op)
            .put("account", JSONObject().put("id", "schwab-1").put("label", "Charles Schwab").put("kind", "schwab"))
            .put("reason", "Sign in for the daily statements pull")
            .put("rpId", rpId).put("origin", origin).put("clientDataJSON", cdj(cdType, cdOrigin)).put("expiresAt", expiresAt)
        if (op == "create") o.put("create", JSONObject().put("rp", JSONObject().put("id", rpId).put("name", "Site"))
            .put("user", JSONObject().put("id", B64.url(byteArrayOf(1, 2, 3))).put("name", "u").put("displayName", "U")).put("algs", JSONArray().put(-7)))
        else o.put("get", JSONObject().put("allow", JSONArray()))
        return Request.parse(o)
    }

    @Test fun goodSameHost() = assertNull(Checks.site(req(rpId = "www.schwab.com", origin = "https://www.schwab.com")))

    @Test fun goodParentDomain() = assertNull(Checks.site(req(rpId = "schwab.com", origin = "https://sws-gateway-nr.schwab.com")))

    @Test fun goodCreate() {
        val r = req(op = "create", rpId = "privacy.com", origin = "https://app.privacy.com")
        assertNull(Checks.site(r))
        assertNull(Checks.createOptions(r))
    }

    /** Schwab asks for rpId www.schwab.com from client.schwab.com: a related origin under the same registrable domain. */
    @Test fun relatedOriginSchwab() = assertNull(Checks.site(req(op = "create", rpId = "www.schwab.com", origin = "https://client.schwab.com")))

    @Test fun siblingUnderTheSameSite() = assertNull(Checks.originMatches("https://sws-gateway-nr.schwab.com", "www.schwab.com"))

    /** Siblings under a public suffix are different sites. */
    @Test fun siblingUnderAPublicSuffixRefused() {
        assertNotNull(Checks.originMatches("https://alice.github.io", "bob.github.io"))
        assertNotNull(Checks.originMatches("https://a.example.co.uk", "b.other.co.uk"))
    }

    @Test fun foreignRefused() {
        assertNotNull(Checks.site(req(rpId = "www.schwab.com", origin = "https://evil.com")))
        assertNotNull(Checks.site(req(rpId = "schwab.com", origin = "https://schwab.com.evil.com")))
        assertNotNull(Checks.site(req(rpId = "evil.com", origin = "https://www.schwab.com")))
    }

    @Test fun publicSuffixRpIdRefused() {
        assertNotNull(Checks.originMatches("https://www.schwab.com", "com"))
        assertNotNull(Checks.originMatches("https://alice.github.io", "github.io"))
    }

    @Test fun httpRefused() {
        val why = Checks.site(req(rpId = "www.schwab.com", origin = "http://www.schwab.com"))
        assertTrue(why!!.contains("not https"))
        assertNotNull(Checks.originMatches("http://localhost:8080", "localhost"))
    }

    @Test fun originWithPathOrUserRefused() {
        assertNotNull(Checks.originMatches("https://www.schwab.com/login", "www.schwab.com"))
        assertNotNull(Checks.originMatches("https://evil.com@www.schwab.com", "www.schwab.com"))
    }

    @Test fun typeMismatchRefused() {
        val why = Checks.site(req(op = "get", rpId = "www.schwab.com", origin = "https://www.schwab.com", cdType = "webauthn.create"))
        assertTrue(why!!.contains("type"))
        assertNotNull(Checks.site(req(op = "create", rpId = "www.schwab.com", origin = "https://www.schwab.com", cdType = "webauthn.get")))
    }

    @Test fun clientDataOriginMustEqualTheRequests() {
        val why = Checks.site(req(rpId = "www.schwab.com", origin = "https://www.schwab.com", cdOrigin = "https://evil.com"))
        assertTrue(why!!.contains("origin"))
    }

    @Test fun malformedClientData() {
        val o = JSONObject().put("id", "r2").put("op", "get").put("rpId", "a.com").put("origin", "https://a.com")
            .put("clientDataJSON", B64.url("not json".toByteArray())).put("expiresAt", Long.MAX_VALUE)
        assertNotNull(Checks.site(Request.parse(o)))
        assertTrue(runCatching { Request.parse(JSONObject(o.toString()).put("clientDataJSON", "+++")) }.isFailure)
        assertTrue(runCatching { Request.parse(JSONObject(o.toString()).put("op", "sign")) }.isFailure)
    }

    @Test fun expiry() {
        val r = req(rpId = "a.com", origin = "https://a.com", expiresAt = 1000)
        assertTrue(Checks.expired(r, 1000))
        assertTrue(!Checks.expired(r, 999))
    }

    @Test fun createOptions() {
        val ok = req(op = "create", rpId = "www.schwab.com", origin = "https://client.schwab.com")
        assertNull(Checks.createOptions(ok))
        val o = JSONObject().put("id", "r3").put("op", "create").put("rpId", "a.com").put("origin", "https://a.com")
            .put("clientDataJSON", cdj("webauthn.create", "https://a.com")).put("expiresAt", Long.MAX_VALUE)
        val user = JSONObject().put("id", B64.url(byteArrayOf(9)))
        assertNotNull(Checks.createOptions(Request.parse(JSONObject(o.toString()).put("create", JSONObject().put("rp", JSONObject().put("id", "b.com")).put("user", user)))))
        assertNotNull(Checks.createOptions(Request.parse(JSONObject(o.toString()).put("create", JSONObject().put("user", user).put("algs", JSONArray().put(-8))))))
        assertNotNull(Checks.createOptions(Request.parse(JSONObject(o.toString()).put("create", JSONObject().put("user", JSONObject().put("id", B64.url(ByteArray(65))))))))
        assertNull(Checks.createOptions(Request.parse(JSONObject(o.toString()).put("create", JSONObject().put("user", user)))))
    }

    @Test fun pairingLinks() {
        val l = PairLink.parse("dither-approver://pair?url=https%3A%2F%2Faccounts.example.net&code=AAAAAAAAAAAAAAAAAAAAAA", debug = false)!!
        assertEquals("https://accounts.example.net", l.url)
        assertEquals("AAAAAAAAAAAAAAAAAAAAAA", l.code)
        // Unencoded, with a trailing slash.
        assertEquals("https://accounts.example.net", PairLink.parse("dither-approver://pair?url=https://accounts.example.net/&code=AAAAAAAAAAAAAAAAAAAAAA", false)!!.url)
        // http: debug builds only, and only to the emulator's host or localhost.
        assertNull(PairLink.parse("dither-approver://pair?url=http://10.0.2.2:9120&code=AAAAAAAAAAAAAAAAAAAAAA", false))
        assertEquals("http://10.0.2.2:9120", PairLink.parse("dither-approver://pair?url=http://10.0.2.2:9120&code=AAAAAAAAAAAAAAAAAAAAAA", true)!!.url)
        assertNull(PairLink.parse("dither-approver://pair?url=http://evil.com&code=AAAAAAAAAAAAAAAAAAAAAA", true))
        assertNull(PairLink.parse("dither-approver://pair?url=https://a.com&code=short", false))
        assertNull(PairLink.parse("https://a.com/?url=https://a.com&code=AAAAAAAAAAAAAAAAAAAAAA", false))
    }
}

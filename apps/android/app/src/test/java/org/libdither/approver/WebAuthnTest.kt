package org.libdither.approver

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

/**
 * The expected bytes were made by packages/passkey's own code (cbor.ts `encode`, and authenticator.ts's layout of
 * authenticator data) for the same key, credential id and rpId, so these pin the app to what the software
 * authenticator, and the relying parties that accept it, produce.
 */
class WebAuthnTest {
    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun hexOf(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private val x = "3f3eca524bbb37704c8a92e5601df1cc5a15364bf2259071ec7d8a990c1cea35"
    private val y = "440869ebf33780448f9e073d51a6a22d89fdf1c59b7914c2560c84490ab3501f"
    private val refCose = "a50102032620012158203f3eca524bbb37704c8a92e5601df1cc5a15364bf2259071ec7d8a990c1cea35225820440869ebf33780448f9e073d51a6a22d89fdf1c59b7914c2560c84490ab3501f"
    private val refCreate = "24781094703d6fe7b395dbcbbb32ca4ea4885172d6c23ce5d84bc2ae3a8df7c34500000000000000000000000000000000000000000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f$refCose"
    private val refAtt = "a363666d74646e6f6e656761747453746d74a068617574684461746158a4$refCreate"
    private val refGet = "24781094703d6fe7b395dbcbbb32ca4ea4885172d6c23ce5d84bc2ae3a8df7c30500000102"
    private val credId = ByteArray(32) { it.toByte() }

    private fun p256(): ECParameterSpec = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)

    private fun fixedKey(): ECPublicKey =
        KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, hex(x)), BigInteger(1, hex(y))), p256())) as ECPublicKey

    private fun newPair() = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    @Test fun coseKeyMatchesCborTs() = assertEquals(refCose, hexOf(WebAuthn.coseKey(fixedKey())))

    @Test fun createAuthDataByteForByte() = assertEquals(refCreate, hexOf(WebAuthn.createAuthData("www.schwab.com", credId, fixedKey())))

    @Test fun attestationObjectByteForByte() = assertEquals(refAtt, hexOf(WebAuthn.attestationObject(hex(refCreate))))

    @Test fun getAuthDataByteForByte() = assertEquals(refGet, hexOf(WebAuthn.getAuthData("www.schwab.com", 258)))

    @Test fun createAuthDataLayout() {
        val a = WebAuthn.createAuthData("example.com", credId, fixedKey())
        assertArrayEquals(WebAuthn.sha256("example.com".toByteArray()), a.copyOfRange(0, 32))
        assertEquals(0x45, a[32].toInt())
        assertArrayEquals(ByteArray(4), a.copyOfRange(33, 37))
        assertArrayEquals(ByteArray(16), a.copyOfRange(37, 53))
        assertEquals(32, ((a[53].toInt() and 0xff) shl 8) or (a[54].toInt() and 0xff))
        assertArrayEquals(credId, a.copyOfRange(55, 87))
        assertEquals(refCose, hexOf(a.copyOfRange(87, a.size)))
    }

    @Test fun getAuthDataCounterIsBigEndian() {
        val a = WebAuthn.getAuthData("example.com", 0x01020304)
        assertEquals(37, a.size)
        assertEquals(0x05, a[32].toInt())
        assertEquals("01020304", hexOf(a.copyOfRange(33, 37)))
    }

    @Test fun coordinatesAreAlways32Bytes() {
        assertEquals(32, WebAuthn.fixed32(BigInteger.ONE).size)
        assertEquals(1, WebAuthn.fixed32(BigInteger.ONE)[31].toInt())
        // A top bit set: BigInteger adds a sign byte, which must go.
        val high = BigInteger(1, ByteArray(32) { 0xff.toByte() })
        assertEquals(33, high.toByteArray().size)
        assertArrayEquals(ByteArray(32) { 0xff.toByte() }, WebAuthn.fixed32(high))
    }

    @Test fun cborHeadsForLongerItems() {
        val c = Cbor().apply { bytes(ByteArray(300)); int(-300); int(65536); text("é") }.toByteArray()
        assertEquals("59012c", hexOf(c.copyOfRange(0, 3)))
        assertEquals("39012b" + "1a00010000" + "62c3a9", hexOf(c.copyOfRange(303, c.size)))
    }

    /** A signature from a real key over authData ‖ SHA-256(clientDataJSON), checked as a relying party would. */
    @Test fun assertionSignatureVerifies() {
        val kp = newPair()
        val pub = kp.public as ECPublicKey
        val cdj = """{"type":"webauthn.get","challenge":"Y2hhbGxlbmdl","origin":"https://www.schwab.com","crossOrigin":false}""".toByteArray()
        val authData = WebAuthn.getAuthData("www.schwab.com", 5)
        val der = WebAuthn.sign(Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private) }, WebAuthn.signedData(authData, cdj))
        // DER: SEQUENCE of two INTEGERs.
        assertEquals(0x30, der[0].toInt() and 0xff)
        assertEquals(der.size - 2, der[1].toInt() and 0xff)
        assertEquals(0x02, der[2].toInt())
        // The public key goes out as SPKI; a relying party reads it back and verifies.
        val back = WebAuthn.publicKeyFromSpki(pub.encoded)
        val verifier = Signature.getInstance("SHA256withECDSA").apply { initVerify(back); update(authData); update(WebAuthn.sha256(cdj)) }
        assertTrue(verifier.verify(der))
        assertTrue(WebAuthn.verify(back, WebAuthn.signedData(authData, cdj), der))
        assertFalse(WebAuthn.verify(back, WebAuthn.signedData(WebAuthn.getAuthData("www.schwab.com", 6), cdj), der))
    }

    /** The COSE key in a create's authData is the same point as the SPKI the response carries. */
    @Test fun coseKeyIsTheSpkiKey() {
        val pub = newPair().public as ECPublicKey
        val back = WebAuthn.publicKeyFromSpki(pub.encoded)
        val cose = WebAuthn.coseKey(back)
        assertArrayEquals(WebAuthn.fixed32(pub.w.affineX), cose.copyOfRange(10, 42))
        assertArrayEquals(WebAuthn.fixed32(pub.w.affineY), cose.copyOfRange(45, 77))
    }

    @Test fun helloSignatureInput() {
        val input = WebAuthn.helloInput("dev_AAAAAAAAAAAAAAAA", "bm9uY2U")
        assertEquals("dither-approver-v1\ndev_AAAAAAAAAAAAAAAA\nbm9uY2U", String(input, Charsets.UTF_8))
        val kp = newPair()
        val sig = WebAuthn.sign(Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private) }, input)
        assertTrue(WebAuthn.verify(kp.public as ECPublicKey, "dither-approver-v1\ndev_AAAAAAAAAAAAAAAA\nbm9uY2U".toByteArray(), sig))
        assertTrue(Regex("^[A-Za-z0-9_-]+$").matches(B64.url(sig)))
    }

    @Test fun fingerprintIsFirstEightBytesOfSpkiHash() {
        val spki = fixedKey().encoded
        val h = WebAuthn.sha256(spki)
        val fp = WebAuthn.fingerprint(spki)
        assertEquals(23, fp.length)
        assertEquals(hexOf(h.copyOfRange(0, 8)), fp.replace(":", ""))
    }

    @Test fun base64url() {
        assertEquals("-_8", B64.url(byteArrayOf(0xfb.toByte(), 0xff.toByte())))
        assertArrayEquals(byteArrayOf(0xfb.toByte(), 0xff.toByte()), B64.fromUrl("-_8"))
        assertArrayEquals(byteArrayOf(0xfb.toByte(), 0xff.toByte()), B64.fromUrl("-_8="))
        assertTrue(runCatching { B64.fromUrl("+/8") }.isFailure)
    }
}

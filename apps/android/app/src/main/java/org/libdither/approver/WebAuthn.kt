package org.libdither.approver

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * The bytes WebAuthn wants, built the way packages/passkey's software authenticator builds them (authenticator.ts,
 * cbor.ts), so a relying party that accepts one accepts the other. Pure JVM code: the unit tests run it with JDK keys.
 */
object WebAuthn {
    const val ES256 = -7L
    const val UP = 0x01
    const val UV = 0x04
    const val AT = 0x40

    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

    /** The COSE EC2 P-256 key: {1:2, 3:-7, -1:1, -2:x, -3:y}, keys in CTAP2 canonical order. */
    fun coseKey(pub: ECPublicKey): ByteArray = Cbor().apply {
        map(5)
        int(1); int(2) // kty: EC2
        int(3); int(ES256)
        int(-1); int(1) // crv: P-256
        int(-2); bytes(fixed32(pub.w.affineX))
        int(-3); bytes(fixed32(pub.w.affineY))
    }.toByteArray()

    /** create: rpIdHash ‖ flags (UP|UV|AT) ‖ counter 0 ‖ AAGUID (16 zero bytes) ‖ id length (2) ‖ id ‖ COSE key. */
    fun createAuthData(rpId: String, credentialId: ByteArray, pub: ECPublicKey): ByteArray {
        val o = ByteArrayOutputStream()
        o.write(sha256(rpId.toByteArray(Charsets.UTF_8)))
        o.write(UP or UV or AT)
        o.write(u32(0))
        o.write(ByteArray(16))
        o.write(credentialId.size shr 8)
        o.write(credentialId.size and 0xff)
        o.write(credentialId)
        o.write(coseKey(pub))
        return o.toByteArray()
    }

    /** get: rpIdHash ‖ flags (UP|UV) ‖ counter (4 bytes, big-endian). */
    fun getAuthData(rpId: String, counter: Long): ByteArray =
        sha256(rpId.toByteArray(Charsets.UTF_8)) + byteArrayOf((UP or UV).toByte()) + u32(counter)

    /** {fmt:"none", attStmt:{}, authData}: CTAP2 canonical order (shorter keys first). */
    fun attestationObject(authData: ByteArray): ByteArray = Cbor().apply {
        map(3)
        text("fmt"); text("none")
        text("attStmt"); map(0)
        text("authData"); bytes(authData)
    }.toByteArray()

    /** What an assertion signs: authenticatorData ‖ SHA-256(clientDataJSON). */
    fun signedData(authData: ByteArray, clientDataJSON: ByteArray): ByteArray = authData + sha256(clientDataJSON)

    /** Signs with an initialized SHA256withECDSA Signature (a Keystore one already unlocked, or a JDK one in tests). DER. */
    fun sign(sig: Signature, data: ByteArray): ByteArray {
        sig.update(data)
        return sig.sign()
    }

    /** The link's hello: UTF-8 "dither-approver-v1\n" + deviceId + "\n" + nonce. */
    fun helloInput(deviceId: String, nonce: String): ByteArray = "dither-approver-v1\n$deviceId\n$nonce".toByteArray(Charsets.UTF_8)

    /** SHA-256 of the SPKI, first 8 bytes as hex pairs: what the page shows beside the device, to compare. */
    fun fingerprint(spki: ByteArray): String = sha256(spki).take(8).joinToString(":") { "%02x".format(it.toInt() and 0xff) }

    fun publicKeyFromSpki(spki: ByteArray): ECPublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki)) as ECPublicKey

    fun verify(pub: ECPublicKey, data: ByteArray, der: ByteArray): Boolean = runCatching {
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(pub)
            update(data)
            verify(der)
        }
    }.getOrDefault(false)

    fun u32(n: Long): ByteArray = byteArrayOf((n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte())

    /** A coordinate as exactly 32 unsigned big-endian bytes. */
    fun fixed32(v: BigInteger): ByteArray {
        val b = v.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size) // a leading sign byte
            else -> ByteArray(32 - b.size) + b
        }
    }
}

/** The little CBOR WebAuthn needs, written in the order given (callers put keys in canonical order), as cbor.ts does. */
class Cbor {
    private val out = ByteArrayOutputStream()

    private fun head(major: Int, n: Long) {
        val m = major shl 5
        when {
            n < 24 -> out.write(m or n.toInt())
            n < 0x100 -> { out.write(m or 24); out.write(n.toInt()) }
            n < 0x10000 -> { out.write(m or 25); out.write((n shr 8).toInt() and 0xff); out.write(n.toInt() and 0xff) }
            n < 0x100000000 -> { out.write(m or 26); for (s in intArrayOf(24, 16, 8, 0)) out.write((n shr s).toInt() and 0xff) }
            else -> throw IllegalArgumentException("cbor: integer too large")
        }
    }

    fun int(v: Long) = if (v >= 0) head(0, v) else head(1, -1 - v)
    fun int(v: Int) = int(v.toLong())
    fun bytes(b: ByteArray) { head(2, b.size.toLong()); out.write(b) }
    fun text(s: String) {
        val b = s.toByteArray(Charsets.UTF_8)
        head(3, b.size.toLong())
        out.write(b)
    }
    fun map(n: Int) = head(5, n.toLong())
    fun toByteArray(): ByteArray = out.toByteArray()
}

object B64 {
    fun url(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    /** Strict base64url (padding allowed); throws IllegalArgumentException otherwise. */
    fun fromUrl(s: String): ByteArray {
        require(Regex("^[A-Za-z0-9_-]*={0,2}$").matches(s)) { "not base64url" }
        return Base64.getUrlDecoder().decode(s.trimEnd('='))
    }
    fun std(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
}

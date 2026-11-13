package org.libdither.approver

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * Keys in the Android Keystore (docs/approver.md): P-256, signing only, never exported, in StrongBox when the phone has
 * one. The identity key proves the device on every connection and asks for nothing. A credential key asks on every
 * use (fingerprint or the device's PIN), works only while the phone is unlocked, and survives a new fingerprint.
 */
object Keys {
    private const val STORE = "AndroidKeyStore"

    private fun keystore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

    fun identity(c: Context, alias: String) = generate(c, alias) { }

    fun credential(c: Context, alias: String) = generate(c, alias) {
        it.setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .setUnlockedDeviceRequired(true)
            .setInvalidatedByBiometricEnrollment(false)
    }

    private fun generate(c: Context, alias: String, extra: (KeyGenParameterSpec.Builder) -> Unit) {
        fun make(strongBox: Boolean) {
            val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setIsStrongBoxBacked(strongBox)
            extra(b)
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).apply { initialize(b.build()) }.generateKeyPair()
        }
        if (c.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)) {
            try {
                return make(true)
            } catch (_: StrongBoxUnavailableException) {
            }
        }
        make(false)
    }

    fun publicKey(alias: String): ECPublicKey = keystore().getCertificate(alias).publicKey as ECPublicKey

    fun spki(alias: String): ByteArray = publicKey(alias).encoded

    private fun privateKey(alias: String): PrivateKey = keystore().getKey(alias, null) as PrivateKey? ?: throw IllegalStateException("no key $alias")

    /** A signer for this key, initialized: for a credential key it still needs the BiometricPrompt before it signs. */
    fun signer(alias: String): Signature = Signature.getInstance("SHA256withECDSA").apply { initSign(privateKey(alias)) }

    fun exists(alias: String): Boolean = runCatching { keystore().containsAlias(alias) }.getOrDefault(false)

    fun delete(alias: String) {
        runCatching { keystore().deleteEntry(alias) }
    }

    /** Where the key lives: StrongBox, TEE, or software (an emulator's). */
    fun where(alias: String): String = runCatching {
        val k = privateKey(alias)
        val info = KeyFactory.getInstance(k.algorithm, STORE).getKeySpec(k, KeyInfo::class.java)
        if (Build.VERSION.SDK_INT >= 31) when (info.securityLevel) {
            KeyProperties.SECURITY_LEVEL_STRONGBOX -> "StrongBox"
            KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TEE"
            KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
            else -> "secure hardware"
        } else {
            @Suppress("DEPRECATION")
            if (info.isInsideSecureHardware) "secure hardware" else "software"
        }
    }.getOrDefault("unknown")
}

package org.libdither.approver

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/** A QR code in a camera frame's luminance (the Y plane), or null. Pure JVM: tested with a generated code. */
object Qr {
    private val hints = mapOf(DecodeHintType.TRY_HARDER to true, DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE))

    fun decode(y: ByteArray, rowStride: Int, width: Int, height: Int): String? = runCatching {
        val src = PlanarYUVLuminanceSource(y, rowStride, height, 0, 0, width, height, false)
        QRCodeReader().decode(BinaryBitmap(HybridBinarizer(src)), hints).text
    }.getOrNull()
}

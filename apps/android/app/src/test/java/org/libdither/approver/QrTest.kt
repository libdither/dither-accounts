package org.libdither.approver

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QrTest {
    /** A code drawn into a Y plane with row padding (as camera frames have), read back. */
    @Test fun decodesALinkFromALuminancePlane() {
        val link = "dither-approver://pair?url=https%3A%2F%2Faccounts.example.net&code=AAAAAAAAAAAAAAAAAAAAAA"
        val w = 640
        val h = 480
        val stride = 704
        val m = QRCodeWriter().encode(link, BarcodeFormat.QR_CODE, 400, 400)
        val y = ByteArray(stride * h) { 0xc8.toByte() }
        for (j in 0 until 400) for (i in 0 until 400) if (m[i, j]) y[(j + 40) * stride + i + 120] = 0x20
        assertEquals(link, Qr.decode(y, stride, w, h))
        assertNull(Qr.decode(ByteArray(stride * h) { 0x80.toByte() }, stride, w, h))
    }
}

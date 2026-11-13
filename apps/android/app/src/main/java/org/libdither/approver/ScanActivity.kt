package org.libdither.approver

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.ImageReader
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.TextView

/**
 * Scans the pairing QR with the camera: Camera2 frames, decoded by ZXing's core (no Play Services). Returns the
 * text as EXTRA_TEXT when it is a dither-approver link. The preview is 720×1280, portrait.
 */
class ScanActivity : Activity() {
    companion object {
        const val EXTRA_TEXT = "text"
        private const val W = 1280
        private const val H = 720
    }

    private lateinit var view: TextureView
    private lateinit var hint: TextView
    private var thread: HandlerThread? = null
    private var bg: Handler? = null
    private var camera: CameraDevice? = null
    private var reader: ImageReader? = null
    @Volatile private var done = false

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val root = FrameLayout(this)
        view = TextureView(this)
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        hint = TextView(this).apply { text = "Point the camera at the pairing QR on the page"; setPadding(48, 48, 48, 48); gravity = Gravity.CENTER }
        root.addView(hint, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        root.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(WindowInsets.Type.systemBars())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsets.CONSUMED
        }
        view.addOnLayoutChangeListener { v, l, _, r, _, _, _, _, _ ->
            val want = (r - l) * W / H
            if (v.layoutParams.height != want) v.post { v.layoutParams = v.layoutParams.apply { height = want } }
        }
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
            return
        }
        start()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
            hint.text = "The camera is not allowed. Paste the link instead."
        }
    }

    override fun onPause() {
        stop()
        super.onPause()
    }

    private fun stop() {
        camera?.close(); camera = null
        reader?.close(); reader = null
        thread?.quitSafely(); thread = null; bg = null
    }

    private fun start() {
        if (camera != null) return
        if (!view.isAvailable) {
            view.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(s: SurfaceTexture, w: Int, h: Int) = start()
                override fun onSurfaceTextureSizeChanged(s: SurfaceTexture, w: Int, h: Int) {}
                override fun onSurfaceTextureDestroyed(s: SurfaceTexture) = true
                override fun onSurfaceTextureUpdated(s: SurfaceTexture) {}
            }
            return
        }
        val cm = getSystemService(CameraManager::class.java)
        val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
            ?: cm.cameraIdList.firstOrNull()
            ?: return run { hint.text = "This phone has no camera. Paste the link instead." }
        thread = HandlerThread("scan").also { it.start() }
        bg = Handler(thread!!.looper)
        val r = ImageReader.newInstance(W, H, ImageFormat.YUV_420_888, 2)
        reader = r
        r.setOnImageAvailableListener({ ir ->
            val img = ir.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                if (done) return@setOnImageAvailableListener
                val plane = img.planes[0]
                val buf = plane.buffer
                val y = ByteArray(buf.remaining()).also { buf.get(it) }
                val text = Qr.decode(if (y.size >= plane.rowStride * img.height) y else y.copyOf(plane.rowStride * img.height), plane.rowStride, img.width, img.height)
                if (text != null) runOnUiThread { found(text) }
            } finally {
                img.close()
            }
        }, bg)
        open(cm, id, r)
    }

    @SuppressLint("MissingPermission")
    private fun open(cm: CameraManager, id: String, r: ImageReader) {
        cm.openCamera(id, mainExecutor, object : CameraDevice.StateCallback() {
            override fun onOpened(cam: CameraDevice) {
                camera = cam
                val st = view.surfaceTexture ?: return
                st.setDefaultBufferSize(W, H)
                val preview = Surface(st)
                val outs = listOf(OutputConfiguration(preview), OutputConfiguration(r.surface))
                cam.createCaptureSession(SessionConfiguration(SessionConfiguration.SESSION_REGULAR, outs, mainExecutor, object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(s: CameraCaptureSession) {
                        val req = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                            addTarget(preview)
                            addTarget(r.surface)
                            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                        }.build()
                        runCatching { s.setRepeatingRequest(req, null, bg) }
                    }

                    override fun onConfigureFailed(s: CameraCaptureSession) {
                        hint.text = "The camera could not start. Paste the link instead."
                    }
                }))
            }

            override fun onDisconnected(cam: CameraDevice) { cam.close(); camera = null }
            override fun onError(cam: CameraDevice, error: Int) {
                cam.close(); camera = null
                hint.text = "The camera could not start ($error). Paste the link instead."
            }
        })
    }

    private fun found(text: String) {
        if (done) return
        if (PairLink.parse(text, BuildConfig.DEBUG) == null) {
            hint.text = "That QR is not a dither-approver pairing link."
            return
        }
        done = true
        setResult(RESULT_OK, Intent().putExtra(EXTRA_TEXT, text))
        finish()
    }
}

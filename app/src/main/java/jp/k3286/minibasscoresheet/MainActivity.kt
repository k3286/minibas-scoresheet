package jp.k3286.minibasscoresheet

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * ミニバス スコアシート
 *
 * 単一 Activity + WebView の構成です。
 * スコアシート本体（入力 UI・公式シート描画・印刷用 CSS）は
 * assets/scoresheet/ 以下の HTML/CSS/JS で実装し、
 * 印刷だけを Android の印刷フレームワークへブリッジします。
 * データは WebView の localStorage に自動保存されます。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var voiceBridge: VoiceBridge? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        webView.webViewClient = WebViewClient()
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // localStorage による自動保存
            builtInZoomControls = true
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        // JavaScript から印刷フレームワークを呼び出すためのブリッジ
        webView.addJavascriptInterface(PrintBridge(this, webView), "AndroidPrint")
        // JavaScript から音声認識を呼び出すためのブリッジ
        val vb = VoiceBridge(this, webView)
        voiceBridge = vb
        webView.addJavascriptInterface(vb, "AndroidVoice")

        webView.loadUrl("file:///android_asset/scoresheet/index.html")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == VoiceBridge.REQUEST_RECORD_AUDIO) {
            val granted = grantResults.isNotEmpty() &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED
            if (granted) {
                voiceBridge?.startListening()
            } else {
                // 権限が拒否されたら JS 側へエラーとして伝える
                voiceBridge?.notifyError(VoiceBridge.ERROR_PERMISSION_DENIED)
            }
        }
    }

    override fun onDestroy() {
        voiceBridge?.release()
        super.onDestroy()
    }

    /**
     * JavaScript 側の window.AndroidPrint.printSheet() から呼ばれ、
     * WebView の内容（印刷用 CSS で公式シートのみ表示）を
     * Android 標準の印刷ダイアログ（A4）へ渡します。
     */
    class PrintBridge(
        private val context: Context,
        private val webView: WebView
    ) {
        @JavascriptInterface
        fun printSheet() {
            (context as? Activity)?.runOnUiThread {
                val printManager =
                    context.getSystemService(Context.PRINT_SERVICE) as PrintManager
                val adapter = webView.createPrintDocumentAdapter("ミニバス スコアシート")
                val attributes = PrintAttributes.Builder()
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                    .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                    .build()
                printManager.print("ミニバス スコアシート", adapter, attributes)
            }
        }
    }

    /**
     * JavaScript 側の window.AndroidVoice.startRecognition() から呼ばれ、
     * Android 標準の音声認識（SpeechRecognizer）で日本語の発話を取得し、
     * 結果を window.onVoiceResult(text) / window.onVoiceError(code) で返す。
     * WebView 単体では音声認識が動かないためのネイティブブリッジ。
     *
     * 権限要求はプロジェクトに androidx が無いため、framework の
     * Activity.requestPermissions（API 23+、minSdk 26 なので問題なし）を使う。
     */
    class VoiceBridge(
        private val context: Context,
        private val webView: WebView
    ) {
        companion object {
            const val REQUEST_RECORD_AUDIO = 1001
            const val ERROR_PERMISSION_DENIED = -1
            const val ERROR_RECOGNIZER_UNAVAILABLE = -2
        }

        private var recognizer: SpeechRecognizer? = null

        @JavascriptInterface
        fun startRecognition() {
            val activity = context as? Activity ?: return
            // SpeechRecognizer の生成・開始と権限要求はメインスレッドで行う
            activity.runOnUiThread {
                if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    startListening()
                } else {
                    activity.requestPermissions(
                        arrayOf(Manifest.permission.RECORD_AUDIO),
                        REQUEST_RECORD_AUDIO
                    )
                }
            }
        }

        /** 権限が許可された状態で認識を開始する。メインスレッドで呼ぶこと。 */
        fun startListening() {
            val activity = context as? Activity ?: return
            if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
                notifyError(ERROR_RECOGNIZER_UNAVAILABLE)
                return
            }
            // 認識中にもう一度呼ばれた場合は、前の認識を破棄してやり直す
            destroyRecognizer()
            val r = SpeechRecognizer.createSpeechRecognizer(activity)
            recognizer = r
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}

                override fun onError(error: Int) {
                    notifyError(error)
                }

                override fun onResults(results: Bundle?) {
                    val texts =
                        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    val text = texts?.firstOrNull().orEmpty()
                    if (text.isNotEmpty()) {
                        notifyResult(text)
                    } else {
                        notifyError(SpeechRecognizer.ERROR_NO_MATCH)
                    }
                }
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
                )
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ja-JP")
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            try {
                r.startListening(intent)
            } catch (e: Exception) {
                notifyError(ERROR_RECOGNIZER_UNAVAILABLE)
            }
        }

        /** Activity 破棄時に認識を止めてリソースを解放する */
        fun release() {
            destroyRecognizer()
        }

        private fun destroyRecognizer() {
            try {
                recognizer?.cancel()
                recognizer?.destroy()
            } catch (e: Exception) {
                // 破棄時の例外は無視する
            }
            recognizer = null
        }

        private fun notifyResult(text: String) {
            val js = "window.onVoiceResult && window.onVoiceResult(" +
                JSONObject.quote(text) + ")"
            (context as? Activity)?.runOnUiThread {
                webView.evaluateJavascript(js, null)
            }
        }

        fun notifyError(code: Int) {
            val js = "window.onVoiceError && window.onVoiceError(" + code + ")"
            (context as? Activity)?.runOnUiThread {
                webView.evaluateJavascript(js, null)
            }
        }
    }
}

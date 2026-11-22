package jp.k3286.minibasscoresheet

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient

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
}

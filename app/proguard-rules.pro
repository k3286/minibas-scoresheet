# Add project specific ProGuard rules here.
# WebView + JavaScript ブリッジ用のクラスを保持します。
-keepclassmembers class jp.k3286.minibasscoresheet.MainActivity$PrintBridge {
    public *;
}

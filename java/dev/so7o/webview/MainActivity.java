package dev.so7o.webview;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * Minimal WebView shell whose only trick is: remote debugging is on, so the
 * page can be driven over the Chrome DevTools Protocol from Termux.
 *
 * The DevTools server listens on the abstract unix socket
 *   webview_devtools_remote_<pid>
 * which cannot be reached from another app (SELinux), so the client side is
 * `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` (see
 * cdp-webview.sh).
 */
public class MainActivity extends Activity {

    private static final String TAG = "So7oWebView";
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        // Must run before any WebView is constructed. Global to the process.
        WebView.setWebContentsDebuggingEnabled(true);
        final int pid = android.os.Process.myPid();
        Log.i(TAG, "devtools socket = webview_devtools_remote_" + pid);

        super.onCreate(state);

        // Freeze-exempt while backgrounded (see KeepAliveService) — without this
        // the DevTools socket stops accepting once the app leaves the foreground.
        startForegroundService(new Intent(this, KeepAliveService.class));

        web = new WebView(this);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient());
        web.addJavascriptInterface(new Bridge(), "so7o");
        web.loadUrl("file:///android_asset/index.html");

        // Publish the DevTools socket on 127.0.0.1 so clients can skip adb forward.
        new RelayServer().start();
    }

    /** In-app channel (page -> Java), independent of CDP. */
    public class Bridge {
        @JavascriptInterface
        public String ping() {
            return "pong from app pid " + android.os.Process.myPid()
                    + " at " + System.currentTimeMillis();
        }

        /** Introspection: which socket should an outside client aim at? */
        @JavascriptInterface
        public String info() {
            int pid = android.os.Process.myPid();
            return "{\"pid\":" + pid
                    + ",\"socket\":\"webview_devtools_remote_" + pid
                    + "\",\"relay\":\"127.0.0.1:" + RelayServer.PORT
                    + "\",\"uptime_ms\":" + android.os.SystemClock.elapsedRealtime() + "}";
        }

        /** Prove that a CDP call really crossed into the Android layer. */
        @JavascriptInterface
        public String toast(final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show();
                }
            });
            return "toasted: " + text;
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}

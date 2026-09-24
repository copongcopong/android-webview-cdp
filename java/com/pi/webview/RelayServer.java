package com.pi.webview;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;

/**
 * Publishes the WebView's own DevTools socket on 127.0.0.1 so clients do not
 * need `adb forward`.
 *
 * The DevTools server listens on the abstract unix socket
 * `webview_devtools_remote_<pid>`. SELinux stops every *other* app from
 * connecting to it — but a process may connect to an abstract socket it created
 * itself, so the relay is allowed where an outside client is not. The relay must
 * therefore live inside the WebView's process: nothing external can do this.
 *
 * Note the port is not 9333 — the `adb forward` path already owns that on the
 * device's loopback (adb's server runs inside Termux).
 */
public class RelayServer {

    private static final String TAG = "PiWebViewRelay";
    public static final int PORT = 9334;

    /** The relay belongs to the process, not the Activity — onCreate can run
     *  again (display change, rotation, task move) and a second bind would just
     *  fail with EADDRINUSE while the first one keeps serving. */
    private static boolean started = false;

    private volatile boolean running;

    public synchronized void start() {
        if (started) {
            Log.i(TAG, "relay already running on 127.0.0.1:" + PORT);
            return;
        }
        started = true;
        running = true;
        Thread acceptor = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "pi-relay-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    private void acceptLoop() {
        ServerSocket server = null;
        try {
            server = new ServerSocket(PORT, 8, InetAddress.getByName("127.0.0.1"));
            Log.i(TAG, "relay 127.0.0.1:" + PORT + " -> @webview_devtools_remote_"
                    + android.os.Process.myPid());
            while (running) {
                final Socket client = server.accept();
                Thread conn = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        pipe(client);
                    }
                }, "pi-relay-conn");
                conn.setDaemon(true);
                conn.start();
            }
        } catch (IOException e) {
            Log.e(TAG, "relay unavailable: " + e.getMessage());
            started = false;
        } finally {
            closeQuietly(server);
        }
    }

    private void pipe(final Socket client) {
        LocalSocket local = new LocalSocket();
        try {
            client.setTcpNoDelay(true);
            client.setSoTimeout(0);
            local.connect(new LocalSocketAddress(devtoolsSocketName(),
                    LocalSocketAddress.Namespace.ABSTRACT));

            final InputStream clientIn = client.getInputStream();
            final OutputStream clientOut = client.getOutputStream();
            final InputStream localIn = local.getInputStream();
            final OutputStream localOut = local.getOutputStream();

            // both directions run at once: CDP is request/response *and* a
            // server-push stream (WebSocket frames, events)
            Thread back = new Thread(new Runnable() {
                @Override
                public void run() {
                    pump(localIn, clientOut, client);
                }
            }, "pi-relay-back");
            back.setDaemon(true);
            back.start();

            pump(clientIn, localOut, local);
        } catch (IOException e) {
            Log.w(TAG, "connection dropped: " + e.getMessage());
        } finally {
            closeQuietly(client);
            closeQuietly(local);
        }
    }

    private void pump(InputStream in, OutputStream out, Object closeOnEnd) {
        byte[] buf = new byte[16 * 1024];
        try {
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                out.flush();
            }
        } catch (IOException e) {
            // normal end of stream / client vanished
        } finally {
            if (closeOnEnd instanceof Socket) closeQuietly((Socket) closeOnEnd);
            else closeQuietly((LocalSocket) closeOnEnd);
        }
    }

    private static String devtoolsSocketName() {
        return "webview_devtools_remote_" + android.os.Process.myPid();
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try {
            c.close();
        } catch (IOException ignored) {
        }
    }
}

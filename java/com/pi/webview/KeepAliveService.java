package com.pi.webview;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * Keeps the process out of the frozen cgroup while the app is backgrounded.
 *
 * Without this, Samsung's freezer (and the platform's own cached-app freezer)
 * puts the process in /frozen once the app has been in the background for a
 * while. The DevTools socket stays *listed* in /proc/net/unix but is never
 * accepted, so CDP clients hang instead of failing cleanly.
 *
 * A foreground service makes the process freeze-exempt — which is what this
 * app needs, since the whole point is to drive it from Termux, i.e. while it
 * is not the visible app.
 */
public class KeepAliveService extends Service {

    private static final String CHANNEL = "pi-webview-keepalive";
    private static final int NOTIFICATION_ID = 1;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, "WebView keep-alive", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        channel.setDescription("Keeps the DevTools socket reachable");

        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.createNotificationChannel(channel);

        Notification n = new Notification.Builder(this, CHANNEL)
                .setContentTitle("Pi WebView Shell")
                .setContentText("CDP reachable · pid " + android.os.Process.myPid())
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .build();

        startForeground(NOTIFICATION_ID, n);
        return START_STICKY;
    }
}

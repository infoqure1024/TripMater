package com.odometer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Minimal Foreground Service that keeps the process alive while the user is
 * navigating away from the app.  Location tracking itself runs in the JS thread
 * via react-native-geolocation-service / watchPosition; this service just shows
 * the required persistent notification so Android does not kill the process.
 *
 * Accepts three Intent actions:
 *   ACTION_START  — startForeground with the supplied title/text
 *   ACTION_UPDATE — update the notification text (e.g. live distance)
 *   ACTION_STOP   — stopForeground + stopSelf
 */
class LocationForegroundService : Service() {

    companion object {
        const val ACTION_START  = "com.odometer.fgs.START"
        const val ACTION_STOP   = "com.odometer.fgs.STOP"
        const val ACTION_UPDATE = "com.odometer.fgs.UPDATE"
        const val EXTRA_TITLE   = "title"
        const val EXTRA_TEXT    = "text"
        const val NOTIFICATION_ID = 1001
        const val CHANNEL_ID      = "trip_meter_channel"
    }

    private val notificationManager: NotificationManager by lazy {
        getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    }

    private var isForegrounded = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val title = intent.getStringExtra(EXTRA_TITLE) ?: "走行計測中"
                val text  = intent.getStringExtra(EXTRA_TEXT)  ?: "計測を継続しています"
                callStartForeground(buildNotification(title, text))
            }
            ACTION_UPDATE -> {
                // Ignore if not already foregrounded — avoids FGS timeout when the
                // service is reached via startService without a preceding ACTION_START.
                if (!isForegrounded) return START_STICKY
                val title = intent.getStringExtra(EXTRA_TITLE) ?: "走行計測中"
                val text  = intent.getStringExtra(EXTRA_TEXT)  ?: ""
                notificationManager.notify(NOTIFICATION_ID, buildNotification(title, text))
            }
            ACTION_STOP -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                isForegrounded = false
                stopSelf()
            }
            else -> {
                // START_STICKY restart delivers null intent — must call startForeground
                // within 5 s or Android raises ForegroundServiceDidNotStartInTimeException.
                callStartForeground(buildNotification("走行計測中", "計測を継続しています"))
            }
        }
        return START_STICKY
    }

    private fun callStartForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        isForegrounded = true
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "走行計測",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "走行計測中の常駐通知"
                setShowBadge(false)
            }
            notificationManager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(title: String, text: String): Notification {
        val launchIntent = (packageManager.getLaunchIntentForPackage(packageName)
            ?: Intent()).apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP }
        val piFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else
            PendingIntent.FLAG_UPDATE_CURRENT
        val pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, piFlags)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}

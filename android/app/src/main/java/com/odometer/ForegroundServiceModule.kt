package com.odometer

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class ForegroundServiceModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "LocationForegroundService"
    }

    override fun getName() = NAME

    @ReactMethod
    fun start(title: String, text: String, promise: Promise) {
        try {
            val intent = serviceIntent(LocationForegroundService.ACTION_START)
                .putExtra(LocationForegroundService.EXTRA_TITLE, title)
                .putExtra(LocationForegroundService.EXTRA_TEXT, text)
            startService(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("FGS_START_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            startService(serviceIntent(LocationForegroundService.ACTION_STOP))
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("FGS_STOP_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun updateNotification(title: String, text: String, promise: Promise) {
        try {
            val intent = serviceIntent(LocationForegroundService.ACTION_UPDATE)
                .putExtra(LocationForegroundService.EXTRA_TITLE, title)
                .putExtra(LocationForegroundService.EXTRA_TEXT, text)
            startService(intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("FGS_UPDATE_FAILED", e.message, e)
        }
    }

    private fun serviceIntent(action: String) =
        Intent(reactContext, LocationForegroundService::class.java).apply {
            this.action = action
        }

    private fun startService(intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent)
        } else {
            reactContext.startService(intent)
        }
    }
}

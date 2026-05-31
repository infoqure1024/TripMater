package com.odometer

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity

class ActivityRecognitionModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "ActivityRecognition"
    private const val ACTION_TRANSITION = "com.odometer.ACTIVITY_TRANSITION"
    private const val EVENT_NAME = "activityUpdate"
  }

  private var pendingIntent: PendingIntent? = null

  override fun getName() = NAME

  @ReactMethod
  fun start(promise: Promise) {
    val intent = Intent(reactContext, ActivityTransitionReceiver::class.java).apply {
      action = ACTION_TRANSITION
    }
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
    else
      PendingIntent.FLAG_UPDATE_CURRENT
    val pi = PendingIntent.getBroadcast(reactContext, 100, intent, flags)
    pendingIntent = pi

    val transitions = listOf(
      ActivityTransition.Builder()
        .setActivityType(DetectedActivity.STILL)
        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
        .build(),
      ActivityTransition.Builder()
        .setActivityType(DetectedActivity.STILL)
        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
        .build(),
    )
    val request = ActivityTransitionRequest(transitions)

    ActivityEventBus.onStillChanged = { isStill -> emit(isStill) }

    ActivityRecognition.getClient(reactContext)
      .requestActivityTransitionUpdates(request, pi)
      .addOnSuccessListener { promise.resolve(null) }
      .addOnFailureListener { e -> promise.reject("AR_START_FAILED", e.message, e) }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    val pi = pendingIntent ?: run { promise.resolve(null); return }
    ActivityEventBus.onStillChanged = null
    ActivityRecognition.getClient(reactContext)
      .removeActivityTransitionUpdates(pi)
      .addOnSuccessListener { promise.resolve(null) }
      .addOnFailureListener { e -> promise.reject("AR_STOP_FAILED", e.message, e) }
  }

  // RN の NativeEventEmitter が要求するスタブ
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}
  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {}

  private fun emit(isStill: Boolean) {
    val params = Arguments.createMap().apply { putBoolean("isStill", isStill) }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(EVENT_NAME, params)
  }
}

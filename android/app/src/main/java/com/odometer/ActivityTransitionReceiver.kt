package com.odometer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!ActivityTransitionResult.hasResult(intent)) return
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    for (event in result.transitionEvents) {
      if (event.activityType == DetectedActivity.STILL) {
        val isStill = event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
        ActivityEventBus.onStillChanged?.invoke(isStill)
      }
    }
  }
}

package com.odometer

object ActivityEventBus {
  var onStillChanged: ((isStill: Boolean) -> Unit)? = null
}

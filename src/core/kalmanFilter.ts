// 1D Kalman filter for GPS speed smoothing.
// Process model: constant velocity. Error covariance grows as Q·dt between updates.

export class SpeedKalmanFilter {
  private x = 0;       // speed estimate (m/s)
  private p = 1.0;     // error covariance
  private ready = false;

  constructor(
    private readonly q: number, // process noise variance per second (m/s)²/s
    private readonly r: number, // measurement noise variance (m/s)²
  ) {}

  reset(): void {
    this.ready = false;
  }

  /**
   * Feed a new GPS speed measurement and return the filtered estimate.
   * @param measuredMps  raw GPS speed in m/s
   * @param dt           seconds since the previous update (ignored on first call)
   */
  update(measuredMps: number, dt: number): number {
    if (!this.ready) {
      this.x = measuredMps;
      this.p = this.r;
      this.ready = true;
      return measuredMps;
    }
    // Predict: constant-velocity model; variance grows proportional to elapsed time
    const pPred = this.p + this.q * dt;
    // Update: blend prediction with measurement weighted by Kalman gain
    const k = pPred / (pPred + this.r);
    this.x = this.x + k * (measuredMps - this.x);
    this.p = (1 - k) * pPred;
    return Math.max(0, this.x); // speed is non-negative
  }
}

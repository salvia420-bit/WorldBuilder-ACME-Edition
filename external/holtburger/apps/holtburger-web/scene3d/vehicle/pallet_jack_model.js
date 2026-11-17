
export class PalletJackModel {
    constructor() {
        this.liftNorm = 0;
        this.jackFlags = 0;
        this.speed = 0;
        this.steerAngle = 0;
    }

    pump(isLoaded) {
        const increment = isLoaded ? 0.125 : 0.20;
        this.liftNorm = Math.min(this.liftNorm + increment, 1.0);
    }

    lower(dt) {
        this.liftNorm = Math.max(this.liftNorm - 0.5 * dt, 0.0);
    }

    step(throttle, steer, dt) {
        // Steering
        const steerLock = 1.5359; // ±88 degrees
        this.steerAngle = steer * steerLock;

        // Drive (simplified)
        let drag = (this.jackFlags & 0x10) ? 0.45 : 1.0;
        this.speed += throttle * 2.0 * drag * dt;
        this.speed = Math.max(-1.65, Math.min(this.speed, 2.3)) * drag;

        // Position update (simplified)
        // ... (physics logic)
    }
}

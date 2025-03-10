import Complex from './complex.js';

class Polar {
  constructor(magnitude, phase) {
    this._magnitude = magnitude;
    this._phase = phase;
    this._normalizePhase();
  }

  // Static factory methods
  static fromComplex(complex) {
    const magnitude = Math.sqrt(complex.re * complex.re + complex.im * complex.im);
    const phase = Math.atan2(complex.im, complex.re);
    return new Polar(magnitude, phase);
  }

  static fromDb(dbValue, phaseDegrees) {
    const magnitude = Polar.DbToLinearGain(dbValue);
    const phaseRadians = Polar.degreesToRadians(phaseDegrees);
    return new Polar(magnitude, phaseRadians);
  }

  // Convert to Complex
  toComplex() {
    return Complex.fromPolar(this._magnitude, this._phase);
  }

  // Getters
  get magnitude() {
    return this._magnitude;
  }

  get phase() {
    return this._phase;
  }

  get magnitudeDb() {
    return 20 * Math.log10(Math.max(this._magnitude, Number.EPSILON));
  }

  get phaseDegrees() {
    return Polar.radiansToDegrees(this._phase);
  }

  // Basic operations that utilize the Complex class
  add(other) {
    const result = this.toComplex().add(other.toComplex());
    return Polar.fromComplex(result);
  }

  subtract(other) {
    const result = this.toComplex().sub(other.toComplex());
    return Polar.fromComplex(result);
  }

  multiply(other) {
    return new Polar(this._magnitude * other.magnitude, this._phase + other.phase);
  }

  divide(other) {
    return new Polar(this._magnitude / other.magnitude, this._phase - other.phase);
  }

  // Scaling and phase operations
  scale(factor) {
    return new Polar(this._magnitude * factor, this._phase);
  }

  scaleDb(gainDb) {
    const linearGain = Polar.DbToLinearGain(gainDb);
    return this.scale(linearGain);
  }

  addGain(magnitude) {
    return new Polar(this._magnitude + magnitude, this._phase);
  }

  addGainDb(gainDb) {
    const linearGain = Polar.DbToLinearGain(gainDb);
    return this.addGain(linearGain);
  }

  addPhase(phaseRadians) {
    return new Polar(this._magnitude, this._phase + phaseRadians);
  }

  addPhaseDegrees(phaseDegrees) {
    return this.addPhase(Polar.degreesToRadians(phaseDegrees));
  }

  // Audio-specific operations
  delay(delaySeconds, frequency) {
    const delayPhase = 2 * Math.PI * frequency * delaySeconds;
    return this.addPhase(delayPhase);
  }

  invertPolarity() {
    return new Polar(this._magnitude, this._phase + Math.PI);
  }

  // Utility methods
  conjugate() {
    return new Polar(this._magnitude, -this._phase);
  }

  inverse() {
    return new Polar(1 / this._magnitude, -this._phase);
  }

  // Private helper method to normalize phase to [-π, π]
  _normalizePhase() {
    this._phase = ((this._phase + Math.PI) % (2 * Math.PI)) - Math.PI;
  }

  // Static utility methods
  static degreesToRadians(degrees) {
    return (degrees * Math.PI) / 180;
  }

  static radiansToDegrees(radians) {
    return (radians * 180) / Math.PI;
  }

  static DbToLinearGain(magnitudeDb) {
    return Math.pow(10, magnitudeDb / 20);
  }

  // Static methods for array operations
  static addResponses(responses) {
    return responses.reduce((sum, response) => {
      if (!(response instanceof Polar)) {
        throw new Error('All elements must be Polar instances');
      }
      return sum ? sum.add(response) : response;
    }, null);
  }

  static averageResponses(responses) {
    if (!responses.length) return null;
    const sum = Polar.addResponses(responses);
    return sum.scale(1 / responses.length);
  }

  // Format output
  toString() {
    return `${this.magnitudeDb.toFixed(2)}dB ∠${this.phaseDegrees.toFixed(2)}°`;
  }

  // Convert to object for serialization
  toObject() {
    const complex = this.toComplex();
    return {
      magnitude: this._magnitude,
      phase: this._phase,
      magnitudeDb: this.magnitudeDb,
      phaseDegrees: this.phaseDegrees,
      real: complex.re,
      imaginary: complex.im,
    };
  }
}

export default Polar;

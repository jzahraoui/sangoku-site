class Complex {
  constructor(re, im) {
    this.re = re;
    this.im = im;
  }

  static fromPolar(magnitude, phase) {
    return new Complex(
      magnitude * Math.cos(phase),
      magnitude * Math.sin(phase)
    );
  }

  add(other) {
    return new Complex(
      this.re + other.re,
      this.im + other.im
    );
  }

  sub(other) {
    return new Complex(
      this.re - other.re,
      this.im - other.im
    );
  }

  mul(other) {
    return new Complex(
      this.re * other.re - this.im * other.im,
      this.re * other.im + this.im * other.re
    );
  }

  div(other) {
    const denom = other.re * other.re + other.im * other.im;
    return new Complex(
      (this.re * other.re + this.im * other.im) / denom,
      (this.im * other.re - this.re * other.im) / denom
    );
  }
}

export default Complex;
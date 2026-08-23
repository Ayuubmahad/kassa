// Domain errors for refunds. Route maps these to HTTP 4xx; anything else is 500.
export class RefundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class PaymentNotFoundError extends RefundError {
  constructor(paymentId: number) {
    super(`Payment not found: ${paymentId}`);
  }
}

export class PaymentNotRefundableError extends RefundError {
  constructor(paymentId: number, status: string) {
    super(`Payment ${paymentId} is not refundable (status: ${status}).`);
  }
}

export class RefundExceedsRemainingError extends RefundError {
  constructor(requested: number, remaining: number) {
    super(`Refund of ${requested} exceeds remaining refundable amount ${remaining}.`);
  }
}

export class InvalidRefundAmountError extends RefundError {
  constructor(amount: number) {
    super(`Refund amount must be a positive integer (minor units); got ${amount}.`);
  }
}

// Domain errors for checkout. The route maps these to HTTP 4xx; anything else
// is a real 500. Distinguishing "client asked for something impossible" from
// "we broke" is the difference between a usable API and a black box.
export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnknownSkuError extends CheckoutError {
  constructor(sku: string) {
    super(`Unknown SKU: ${sku}`);
  }
}

export class InsufficientInventoryError extends CheckoutError {
  constructor(sku: string, requested: number, available: number) {
    super(
      `Insufficient inventory for ${sku}: requested ${requested}, available ${available}`,
    );
  }
}

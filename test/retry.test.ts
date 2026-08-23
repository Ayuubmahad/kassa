import { afterAll, describe, expect, it } from "vitest";
import { withTransactionRetry, closePool } from "../src/db/pool.js";

afterAll(async () => {
  await closePool();
});

function pgError(code: string): Error {
  const e = new Error(`simulated ${code}`);
  (e as Error & { code: string }).code = code;
  return e;
}

describe("withTransactionRetry", () => {
  it("retries on serialization_failure (40001) then succeeds", async () => {
    let attempts = 0;
    const result = await withTransactionRetry(async () => {
      attempts++;
      if (attempts < 3) throw pgError("40001");
      return "done";
    });
    expect(result).toBe("done");
    expect(attempts).toBe(3);
  });

  it("retries on deadlock_detected (40P01)", async () => {
    let attempts = 0;
    await withTransactionRetry(async () => {
      attempts++;
      if (attempts < 2) throw pgError("40P01");
      return null;
    });
    expect(attempts).toBe(2);
  });

  it("does NOT retry a non-retryable error (e.g. unique_violation 23505)", async () => {
    let attempts = 0;
    await expect(
      withTransactionRetry(async () => {
        attempts++;
        throw pgError("23505");
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("gives up after the retry budget is exhausted", async () => {
    let attempts = 0;
    await expect(
      withTransactionRetry(
        async () => {
          attempts++;
          throw pgError("40001");
        },
        { retries: 2 },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(3); // initial + 2 retries
  });
});

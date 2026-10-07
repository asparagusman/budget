import { MAX_SCAFFOLD_PERIODS, billHistoryQuerySchema, variableCostsCyclesQuerySchema } from "@budget/schema";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createBillsRoutes } from "./bills.js";
import { createVariableCostsRoutes } from "./variable-costs.js";

// Both entry scaffolds build one row per requested period on the request
// thread, and `periods` had no upper bound — `?periods=1e7` (a typo away from
// a real request) pinned Node. Validation runs before the handler touches the
// database, so these need none: a request that reaches the db stub has
// already got past the cap, and fails the test loudly.
const unreachableDb = /** @type {import("@budget/schema").Db} */ (
  /** @type {unknown} */ (
    new Proxy(
      {},
      {
        get() {
          throw new Error("validation should have refused this before any query ran");
        },
      },
    )
  )
);

const app = new Hono()
  .route("/bills", createBillsRoutes({ db: unreachableDb }))
  .route("/variable-costs", createVariableCostsRoutes({ db: unreachableDb }));

describe("the entry scaffolds' `periods`", () => {
  it("accepts the cap itself and refuses one past it", () => {
    for (const schema of [billHistoryQuerySchema, variableCostsCyclesQuerySchema]) {
      expect(schema.parse({ periods: String(MAX_SCAFFOLD_PERIODS) }).periods).toBe(120);
      const refused = schema.safeParse({ periods: String(MAX_SCAFFOLD_PERIODS + 1) });
      expect(refused.success).toBe(false);
      expect(refused.error?.issues[0]?.message).toBe("At most 120 periods at a time.");
    }
  });

  it.each([
    ["/bills/10000000-0000-4000-8000-000000000401/history?periods=1e7"],
    ["/variable-costs/cycles?periods=1e7"],
  ])("answers %s with a 400 that names the field", async (path) => {
    const res = await app.request(path);
    /** @type {any} */
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.fields.periods).toEqual(["At most 120 periods at a time."]);
  });
});

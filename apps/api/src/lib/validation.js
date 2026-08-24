import { z } from "zod";

/**
 * Shared `zValidator` failure hook — turns a Zod failure into this repo's
 * `{ error: { code, message, fields } }` response shape (see
 * phases/README.md "API") instead of @hono/zod-validator's default raw Zod
 * error body. Passing this as every `zValidator(...)`'s third argument is
 * also what makes the endpoint's request type participate in `ApiRoutes`
 * for the RPC client — a bare `c.req.json()` inside a handler body doesn't.
 *
 * The result's `error` is zod/v4/core's `$ZodError`, not the classic
 * top-level `ZodError` — @hono/zod-validator supports zod 3 and 4 through
 * one Hook type, so it's typed at the more general (core) shape, which has
 * no `.flatten()` method. `z.flattenError()` is the standalone function
 * that works on either.
 *
 * @param {{ success: boolean, error?: import("zod/v4/core").$ZodError, data: unknown }} result
 * @param {import("hono").Context} c
 */
export function handleValidation(result, c) {
  if (!result.success && result.error) {
    return c.json(
      {
        error: {
          code: "invalid_request",
          message: "Invalid request.",
          fields: z.flattenError(result.error).fieldErrors,
        },
      },
      400,
    );
  }
}

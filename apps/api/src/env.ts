import { z } from "zod";

// Validated once at startup. A silently-missing SESSION_SECRET is a
// security hole three phases later, so this fails loudly and names exactly
// which variable is wrong instead of throwing a raw connection error later.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(3001),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  PUBLIC_ORIGIN: z.string().min(1, "PUBLIC_ORIGIN is required"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    console.error("Refusing to start: invalid environment configuration.");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

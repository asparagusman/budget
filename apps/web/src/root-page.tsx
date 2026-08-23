import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api.js";

export function RootPage() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await api.health.$get();
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      return res.json();
    },
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
      <div className="rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Foundation OK</h1>
        <p className="mt-2 text-sm text-gray-500">
          {health.isLoading && "Checking API…"}
          {health.isError && `API unreachable: ${(health.error as Error).message}`}
          {health.data &&
            `API ok: ${health.data.ok}, db: ${health.data.db}`}
        </p>
      </div>
    </main>
  );
}

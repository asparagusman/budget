import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { BillHistoryEntry } from "@/components/bill-history-entry.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";

/**
 * The full-screen route for bill history entry. The interaction itself lives
 * in `<BillHistoryEntry>`, which /costs/fixed also opens in a dialog beside
 * the bill being edited — that is the fast path now, and this route stays for
 * a bookmarked or shared deep link.
 */
export function BillHistoryPage() {
  const { billId } = useParams({ strict: false });
  const navigate = useNavigate();

  const billQuery = useQuery({
    queryKey: ["bill-detail", billId],
    queryFn: async () => {
      if (billId === undefined) throw new Error("No bill in the address.");
      const res = await api.bills[":id"].$get({ param: { id: billId } });
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).bill;
    },
    enabled: billId !== undefined,
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "bill-history:back",
          group: "Navigation",
          label: "Back to Fixed Costs",
          icon: ArrowLeftIcon,
          run: () => navigate({ to: "/costs/fixed" }),
        },
      ]),
    [navigate],
  );

  if (billId === undefined) return null;

  return (
    <>
      <PageHeader
        title={billQuery.data ? `${billQuery.data.name} — history` : "Bill history"}
        description="Enter downward, newest first — the dates are derived from this bill's own cadence."
        actions={
          <Button variant="outline" onClick={() => navigate({ to: "/costs/fixed" })}>
            <ArrowLeftIcon />
            Back
          </Button>
        }
      />
      <BillHistoryEntry billId={billId} />
    </>
  );
}

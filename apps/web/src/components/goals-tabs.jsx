import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";

const GOALS_TABS = /** @type {const} */ ([
  { value: "savings", path: "/goals", label: "Savings goals" },
  { value: "house", path: "/goals/house", label: "Buying a house" },
]);

/**
 * The two halves of Goals: what the savings accounts are heading for, and
 * what a house would cost against the budget. Each tab is its own route and
 * its own chunk — the house calculator isn't downloaded to read a goal — so
 * this is only the strip, with no panels; switching tabs navigates, the same
 * way Admin's tabs do.
 */
export function GoalsTabs() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = GOALS_TABS.find((tab) => tab.path === pathname)?.value ?? "savings";

  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        const tab = GOALS_TABS.find((t) => t.value === value);
        if (tab) navigate({ to: tab.path });
      }}
    >
      <TabsList className="md:self-start">
        {GOALS_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

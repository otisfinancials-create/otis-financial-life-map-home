import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { Shell } from "@/components/layout/Shell";
import Dashboard from "@/pages/dashboard";
import Bills from "@/pages/bills";
import Accounts from "@/pages/accounts";
import Forecast from "@/pages/forecast";
import PaySchedules from "@/pages/pay-schedules";
import LifeEvents from "@/pages/life-events";
import Loans from "@/pages/loans";
import AI from "@/pages/ai";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/bills" component={Bills} />
        <Route path="/accounts" component={Accounts} />
        <Route path="/forecast" component={Forecast} />
        <Route path="/pay-schedules" component={PaySchedules} />
        <Route path="/life-events" component={LifeEvents} />
        <Route path="/loans" component={Loans} />
        <Route path="/ai" component={AI} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

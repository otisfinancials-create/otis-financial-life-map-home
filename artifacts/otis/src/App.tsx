import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, useLocation, Redirect, Router as WouterRouter } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/queryClient";

import { Shell } from "@/components/layout/Shell";
import Dashboard from "@/pages/dashboard";
import Bills from "@/pages/bills";
import Budget from "@/pages/budget";
import Goals from "@/pages/goals";
import Accounts from "@/pages/accounts";
import AssetsLiabilities from "@/pages/assets-liabilities";
import SavingsInvestments from "@/pages/savings-investments";
import Forecast from "@/pages/forecast";
import PaySchedules from "@/pages/pay-schedules";
import LifeEvents from "@/pages/life-events";
import Retirement from "@/pages/retirement";
import Loans from "@/pages/loans";
import Otis from "@/pages/otis";
import NotFound from "@/pages/not-found";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(210, 100%, 50%)",
    colorForeground: "hsl(240, 28%, 14%)",
    colorMutedForeground: "hsl(0, 0%, 40%)",
    colorDanger: "hsl(0, 72%, 51%)",
    colorBackground: "hsl(0, 0%, 100%)",
    colorInput: "hsl(214, 32%, 91%)",
    colorInputForeground: "hsl(240, 28%, 14%)",
    colorNeutral: "hsl(214, 32%, 80%)",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white border border-[hsl(214,32%,91%)] rounded-2xl w-[440px] max-w-full overflow-hidden shadow-md",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[hsl(240,28%,14%)]",
    headerSubtitle: "text-[hsl(0,0%,40%)]",
    socialButtonsBlockButtonText: "text-[hsl(240,28%,14%)]",
    formFieldLabel: "text-[hsl(240,28%,14%)]",
    footerActionLink: "text-[hsl(210,100%,50%)]",
    footerActionText: "text-[hsl(0,0%,40%)]",
    dividerText: "text-[hsl(0,0%,40%)]",
    identityPreviewEditButton: "text-[hsl(210,100%,50%)]",
    formFieldSuccessText: "text-[hsl(165,72%,33%)]",
    alertText: "text-[hsl(240,28%,14%)]",
    logoBox: "mb-2",
    logoImage: "h-10 w-10",
    socialButtonsBlockButton: "border-[hsl(214,32%,91%)] bg-white hover:bg-[hsl(210,17%,96%)]",
    formButtonPrimary: "bg-[hsl(210,100%,50%)] hover:bg-[hsl(210,100%,45%)] text-white",
    formFieldInput: "bg-white border-[hsl(214,32%,91%)] text-[hsl(240,28%,14%)]",
    footerAction: "bg-transparent",
    dividerLine: "bg-[hsl(214,32%,91%)]",
    alert: "bg-[hsl(210,17%,96%)]",
    otpCodeFieldInput: "bg-white border-[hsl(214,32%,91%)] text-[hsl(240,28%,14%)]",
    formFieldRow: "gap-2",
    main: "gap-4",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function LandingPage() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 text-foreground">
      <div className="mb-8 flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
          <span className="text-primary-foreground text-lg font-bold font-mono">O</span>
        </div>
        <span className="text-3xl font-semibold tracking-tight">Otis</span>
      </div>
      <p className="mb-8 max-w-sm text-center text-muted-foreground">
        Your financial life map. Sign in to access your dashboard.
      </p>
      <div className="flex gap-3">
        <a
          href={`${basePath}/sign-in`}
          className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Sign in
        </a>
        <a
          href={`${basePath}/sign-up`}
          className="rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground hover:bg-accent transition-colors"
        >
          Create account
        </a>
      </div>
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Shell>
          <Dashboard />
        </Shell>
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

function ProtectedShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">
        <Shell>{children}</Shell>
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to access your financial dashboard",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Get started with Otis today",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route path="/bills">
              <ProtectedShell><Bills /></ProtectedShell>
            </Route>
            <Route path="/budget">
              <ProtectedShell><Budget /></ProtectedShell>
            </Route>
            <Route path="/goals">
              <ProtectedShell><Goals /></ProtectedShell>
            </Route>
            <Route path="/accounts">
              <ProtectedShell><Accounts /></ProtectedShell>
            </Route>
            <Route path="/assets-liabilities">
              <ProtectedShell><AssetsLiabilities /></ProtectedShell>
            </Route>
            <Route path="/savings-investments">
              <ProtectedShell><SavingsInvestments /></ProtectedShell>
            </Route>
            <Route path="/forecast">
              <ProtectedShell><Forecast /></ProtectedShell>
            </Route>
            <Route path="/pay-schedules">
              <ProtectedShell><PaySchedules /></ProtectedShell>
            </Route>
            <Route path="/life-events">
              <ProtectedShell><LifeEvents /></ProtectedShell>
            </Route>
            <Route path="/retirement">
              <ProtectedShell><Retirement /></ProtectedShell>
            </Route>
            <Route path="/loans">
              <ProtectedShell><Loans /></ProtectedShell>
            </Route>
            <Route path="/otis">
              <ProtectedShell><Otis /></ProtectedShell>
            </Route>
            <Route>
              <ProtectedShell><NotFound /></ProtectedShell>
            </Route>
          </Switch>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;

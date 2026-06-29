import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

interface ShellProps {
  children: ReactNode;
}

export function Shell({ children }: ShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-background focus:outline-none">
          <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 md:py-10 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

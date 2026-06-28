import { Bot } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function AI() {
  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in duration-500 h-[calc(100vh-8rem)] flex flex-col">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Bot className="h-6 w-6 text-primary" />
          Otis AI
        </h1>
        <p className="text-muted-foreground mt-1">Your personal financial intelligence assistant.</p>
      </div>
      
      <Card className="flex-1 flex flex-col overflow-hidden bg-card border-border shadow-sm">
        <CardContent className="flex-1 overflow-y-auto p-6 space-y-6 flex flex-col">
          <div className="flex items-start gap-4">
            <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
              <Bot className="h-4 w-4 text-primary" />
            </div>
            <div className="bg-secondary rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-secondary-foreground max-w-[80%]">
              Hello. I've analyzed your upcoming cash flow. It looks like you have 3 unusual expenses this month totaling $1,420. Would you like to review them or adjust your forecast?
            </div>
          </div>
          
          <div className="flex items-start gap-4 flex-row-reverse">
            <div className="h-8 w-8 rounded-full bg-secondary flex items-center justify-center shrink-0 border border-border text-xs font-medium">
              JS
            </div>
            <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-3 text-sm max-w-[80%]">
              Show me the unusual expenses.
            </div>
          </div>

          <div className="flex items-start gap-4">
            <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
              <Bot className="h-4 w-4 text-primary" />
            </div>
            <div className="bg-secondary rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-secondary-foreground max-w-[80%]">
              <p className="mb-2">Here they are:</p>
              <ul className="space-y-1 font-mono text-xs mb-3">
                <li className="flex justify-between gap-4"><span>Car Insurance (Annual)</span><span>$850.00</span></li>
                <li className="flex justify-between gap-4"><span>Property Tax</span><span>$420.00</span></li>
                <li className="flex justify-between gap-4"><span>HOA Fee</span><span>$150.00</span></li>
              </ul>
              <p>Since your target checking buffer is $5,000, you will dip below it on the 14th. Should I model a transfer from your high-yield savings?</p>
            </div>
          </div>
          
          <div className="flex-1" />
        </CardContent>
        <div className="p-4 border-t border-border bg-card">
          <form className="flex gap-2" onSubmit={(e) => e.preventDefault()}>
            <Input 
              placeholder="Ask Otis about your finances..." 
              className="flex-1 bg-background border-border focus-visible:ring-primary"
              disabled
            />
            <Button disabled>Send</Button>
          </form>
          <p className="text-center text-xs text-muted-foreground mt-2">
            Otis AI is currently in early access preview.
          </p>
        </div>
      </Card>
    </div>
  );
}

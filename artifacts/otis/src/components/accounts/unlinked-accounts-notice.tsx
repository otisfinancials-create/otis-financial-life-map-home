import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface UnlinkedAccount {
  id: number;
  accountName: string;
  accountNumberLast4: string | null;
  /** PRE-unlink value — true means the forecast just lost this account's basis. */
  isForecastAccount: boolean;
}

interface Props {
  institutionName: string;
  accounts: UnlinkedAccount[];
  onClose: () => void;
}

/**
 * Shown after an update-mode Plaid Link session when the bank stopped sharing
 * one or more accounts. The rows are kept locally as manual accounts, but
 * bill↔transaction matching stops and (if selected) the forecast loses their
 * balance basis — the user needs to know, not find out from a quietly wrong
 * forecast.
 */
export function UnlinkedAccountsNotice({ institutionName, accounts, onClose }: Props) {
  const one = accounts.length === 1;
  const lostForecast = accounts.some((a) => a.isForecastAccount);
  return (
    <AlertDialog open>
      <AlertDialogContent data-testid="dialog-unlinked-accounts">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {one ? "An account was disconnected" : `${accounts.length} accounts were disconnected`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                {institutionName} no longer shares{one ? " this account" : " these accounts"} with
                Otis. We kept{one ? " it" : " them"} as manual accounts:
              </p>
              <ul className="list-disc pl-5">
                {accounts.map((a) => (
                  <li key={a.id} data-testid={`text-unlinked-account-${a.id}`}>
                    {a.accountName}
                    {a.accountNumberLast4 ? ` ····${a.accountNumberLast4}` : ""}
                  </li>
                ))}
              </ul>
              <p>
                Any bills paid from {one ? "this account" : "these accounts"} will no longer match
                new bank transactions automatically.
                {lostForecast &&
                  " Your forecast no longer includes " +
                    (one ? "this account's balance." : "their balances.")}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction data-testid="button-unlinked-accounts-ok" onClick={onClose}>
            Got it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { RiAlertLine } from "@remixicon/react";
import { createContext, type ReactNode, use } from "react";

interface ImportReviewValue {
  readonly marks: ReadonlySet<string>;
  readonly dismiss: (mark: string) => void;
}

const ImportReviewContext = createContext<ImportReviewValue | null>(null);

export function ImportReviewProvider({
  marks,
  dismiss,
  children,
}: {
  readonly marks: readonly string[];
  readonly dismiss: (mark: string) => void;
  readonly children: ReactNode;
}) {
  return <ImportReviewContext value={{ marks: new Set(marks), dismiss }}>{children}</ImportReviewContext>;
}

export function ImportReview({ mark, children }: { readonly mark: string; readonly children: ReactNode }) {
  const review = use(ImportReviewContext);
  if (!review?.marks.has(mark)) return children;
  return (
    <span
      data-import-review={mark}
      className="inline-flex flex-wrap items-center gap-1 rounded-md outline-2 outline-offset-2 outline-warning"
    >
      {children}
    </span>
  );
}

export function useDismissImportReview() {
  const review = use(ImportReviewContext);
  return (mark: string) => {
    review?.dismiss(mark);
  };
}

export function ImportReviewBanner() {
  const review = use(ImportReviewContext);
  if (!review || review.marks.size === 0) return null;
  return (
    <Alert variant="warning" role="status">
      <RiAlertLine />
      <AlertTitle>Review these before you turn this on</AlertTitle>
      <AlertDescription>
        These values came from another machine. Change one to clear its highlight. Save accepts the rest.
      </AlertDescription>
    </Alert>
  );
}

import { cn } from "@cogwork/ui/lib/utils";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// App-level markdown surface. The triage proposal is the first caller; the
// run-transcript ticket extends this (syntax highlighting) rather than adding a
// second renderer. Styling maps straight onto semantic tokens — react-markdown
// escapes raw HTML by default, so agent-authored prose is safe to render.
const components: Components = {
  p: ({ className, ...props }) => <p className={cn("leading-relaxed", className)} {...props} />,
  a: ({ className, ...props }) => (
    <a
      className={cn("font-medium text-primary underline underline-offset-2", className)}
      rel="noreferrer"
      target="_blank"
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("flex list-disc flex-col gap-1 ps-5", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("flex list-decimal flex-col gap-1 ps-5", className)} {...props} />
  ),
  code: ({ className, ...props }) => (
    <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", className)} {...props} />
  ),
  pre: ({ className, ...props }) => (
    <pre className={cn("overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong className={cn("font-semibold text-foreground", className)} {...props} />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn("border-s-2 ps-3 text-muted-foreground italic", className)} {...props} />
  ),
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 text-sm wrap-break-word", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

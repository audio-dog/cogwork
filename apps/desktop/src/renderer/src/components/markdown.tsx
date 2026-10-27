import { highlighter } from "@cogwork/ui/lib/highlighter";
import { cn } from "@cogwork/ui/lib/utils";
import { createTanStackMarkdownHighlighter } from "@tanstack/highlight/markdown";
import { type MarkdownComponentProps, Markdown as TanStackMarkdown } from "@tanstack/markdown/react";
import { safeHref } from "../features/safe-href";

const markdownHighlighter = createTanStackMarkdownHighlighter(highlighter);

function MarkdownParagraph({ className, ...props }: MarkdownComponentProps<"p">) {
  return <p className={cn("leading-relaxed", className)} {...props} />;
}

function MarkdownLink({ className, href, ...props }: MarkdownComponentProps<"a">) {
  const safe = safeHref(href);
  if (!safe) return <span className={className} {...props} />;
  return (
    <a
      className={cn("font-medium text-primary underline underline-offset-2", className)}
      href={safe}
      rel="noreferrer"
      target="_blank"
      {...props}
    />
  );
}

function MarkdownList({ className, ...props }: MarkdownComponentProps<"ul">) {
  return <ul className={cn("flex list-disc flex-col gap-1 ps-5", className)} {...props} />;
}

function MarkdownOrderedList({ className, ...props }: MarkdownComponentProps<"ol">) {
  return <ol className={cn("flex list-decimal flex-col gap-1 ps-5", className)} {...props} />;
}

function MarkdownInlineCode({ className, ...props }: MarkdownComponentProps<"code">) {
  return (
    <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]", className)} {...props} />
  );
}

function MarkdownPre({ className, ...props }: MarkdownComponentProps<"pre">) {
  return (
    <pre className={cn("overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs", className)} {...props} />
  );
}

function MarkdownStrong({ className, ...props }: MarkdownComponentProps<"strong">) {
  return <strong className={cn("font-semibold text-foreground", className)} {...props} />;
}

function MarkdownBlockquote({ className, ...props }: MarkdownComponentProps<"blockquote">) {
  return <blockquote className={cn("border-s-2 ps-3 text-muted-foreground italic", className)} {...props} />;
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 text-sm wrap-break-word", className)}>
      <TanStackMarkdown
        highlighter={markdownHighlighter}
        components={{
          p: MarkdownParagraph,
          a: MarkdownLink,
          ul: MarkdownList,
          ol: MarkdownOrderedList,
          code: MarkdownInlineCode,
          pre: MarkdownPre,
          strong: MarkdownStrong,
          blockquote: MarkdownBlockquote,
        }}
      >
        {children}
      </TanStackMarkdown>
    </div>
  );
}

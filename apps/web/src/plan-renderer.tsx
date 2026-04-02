import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
export { isWebHref, normalizePlanDocument } from "./plan-document";
import { isWebHref } from "./plan-document";

export function MarkdownPlanDocument({
  markdown,
  variant = "panel",
}: {
  markdown: string;
  variant?: "panel" | "thread";
}) {
  return (
    <div className={cn(
      variant === "panel" && "rounded-xl border border-brd bg-white px-5 py-4",
      variant === "thread" && "px-0 py-0"
    )}>
      <div className={cn(
        "text-[13px] leading-6 text-t2 text-pretty",
        variant === "panel" && "mx-auto max-w-[860px]",
        variant === "thread" && "max-w-none"
      )}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => (
              <h1 className="mb-4 text-balance text-[24px] font-semibold leading-tight text-t1">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="mb-3 mt-6 text-balance text-[18px] font-semibold leading-tight text-t1 first:mt-0">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mb-2 mt-5 text-balance text-[15px] font-semibold leading-tight text-t1 first:mt-0">
                {children}
              </h3>
            ),
            h4: ({ children }) => (
              <h4 className="mb-2 mt-4 text-[13px] font-semibold leading-tight text-t1 first:mt-0">
                {children}
              </h4>
            ),
            p: ({ children }) => <p className="mb-3 text-pretty last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="mb-4 list-disc space-y-1 pl-5 marker:text-t4">{children}</ul>,
            ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1 pl-5 marker:font-medium marker:text-t4">{children}</ol>,
            li: ({ children }) => <li className="pl-1">{children}</li>,
            hr: () => <hr className="my-5 border-0 border-t border-brd" />,
            blockquote: ({ children }) => (
              <blockquote className="mb-4 border-l-2 border-brd-strong pl-4 text-[12px] text-t3">
                {children}
              </blockquote>
            ),
            code: ({ className, children }) => (
              <code
                className={cn(
                  "rounded bg-gz-1 px-1.5 py-px font-mono text-[12px] text-t1",
                  className
                )}
              >
                {children}
              </code>
            ),
            pre: ({ children }) => (
              <pre className="mb-4 overflow-x-auto rounded-xl border border-brd bg-gz-1 px-4 py-3 text-[12px] leading-5 [&_code]:block [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0">
                {children}
              </pre>
            ),
            a: ({ href, children }) =>
              isWebHref(href) ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-t1 underline decoration-brd-strong underline-offset-3 transition-colors hover:text-green"
                >
                  {children}
                </a>
              ) : (
                <code className="rounded bg-gz-1 px-1.5 py-px font-mono text-[12px] text-t1">
                  {flattenChildren(children)}
                </code>
              ),
            table: ({ children }) => (
              <div className="mb-4 overflow-x-auto rounded-xl border border-brd">
                <table className="min-w-full border-collapse bg-white text-left text-[12px]">
                  {children}
                </table>
              </div>
            ),
            thead: ({ children }) => <thead className="bg-gz-1">{children}</thead>,
            tbody: ({ children }) => <tbody>{children}</tbody>,
            tr: ({ children }) => <tr className="border-b border-brd last:border-b-0">{children}</tr>,
            th: ({ children }) => (
              <th className="px-3 py-2 font-semibold text-t1">{children}</th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-2 align-top text-t2">{children}</td>
            ),
            input: ({ checked, disabled, type }) =>
              type === "checkbox" ? (
                <input
                  checked={checked}
                  disabled={disabled ?? true}
                  readOnly
                  type="checkbox"
                  className="mr-2 size-3.5 rounded border border-brd accent-t1"
                />
              ) : null,
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function flattenChildren(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => flattenChildren(child)).join("");
  }
  return "";
}

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function ExpandablePromptText({
  text,
  collapsedLines = 3,
  textClassName,
  toggleClassName,
}: {
  text: string;
  collapsedLines?: number;
  textClassName: string;
  toggleClassName?: string;
}) {
  const {
    expanded,
    setExpanded,
    canExpand,
    textRef,
  } = useExpandablePromptText(text);

  return (
    <div className="min-w-0">
      <p
        ref={textRef}
        className={cn(
          textClassName,
          "whitespace-pre-wrap break-words",
          !expanded && "overflow-hidden"
        )}
        style={getPromptClampStyle(!expanded, collapsedLines)}
      >
        {text}
      </p>
      {canExpand && (
        <div className={toggleClassName}>
          <PromptTextToggle
            expanded={expanded}
            onToggle={() => setExpanded((current) => !current)}
          />
        </div>
      )}
    </div>
  );
}

export function PromptTextToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-[11px] font-medium text-t3 transition-colors hover:text-t1"
    >
      {expanded ? "Show less" : "Show more"}
    </button>
  );
}

export function useExpandablePromptText(text: string) {
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [text]);

  useEffect(() => {
    const element = textRef.current;
    if (!element) {
      setCanExpand(false);
      return;
    }

    if (expanded) {
      setCanExpand(true);
      return;
    }

    let frame = 0;
    const measure = () => {
      setCanExpand(element.scrollHeight > element.clientHeight + 1);
    };

    frame = window.requestAnimationFrame(measure);

    if (typeof ResizeObserver === "undefined") {
      return () => window.cancelAnimationFrame(frame);
    }

    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    });
    observer.observe(element);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [expanded, text]);

  return { expanded, setExpanded, canExpand, textRef };
}

export function getPromptClampStyle(collapsed: boolean, collapsedLines: number) {
  if (!collapsed) {
    return undefined;
  }

  return {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: String(collapsedLines),
  } as const;
}

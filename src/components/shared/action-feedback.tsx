import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

type Tone = "success" | "error" | "info";
type FeedbackValue = string | {
  text?: string;
  message?: string;
  tone?: Tone;
  kind?: Tone | "pending";
  error?: boolean;
} | null;
type Notice = { id: number; source: string; text: string; tone: Tone; expiresAt: number | null };
type FeedbackContextValue = {
  show: (source: string, text: string, tone: Tone) => void;
  clear: (source: string) => void;
};

const FeedbackContext = createContext<FeedbackContextValue>({
  show: () => {},
  clear: () => {},
});

function feedbackDetails(value: FeedbackValue, defaultTone: Tone) {
  if (!value) return null;
  if (typeof value === "string") return value.trim() ? { text: value.trim(), tone: defaultTone } : null;
  const text = (value.text ?? value.message ?? "").trim();
  if (!text) return null;
  const tone = value.error ? "error" : value.tone ?? (value.kind === "pending" ? "info" : value.kind) ?? defaultTone;
  return { text, tone };
}

export function ActionFeedbackProvider({ children }: PropsWithChildren) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(0);

  const show = useCallback((source: string, text: string, tone: Tone) => {
    const notice: Notice = {
      id: ++nextId.current,
      source,
      text,
      tone,
      expiresAt: tone === "error" ? null : Date.now() + 8000,
    };
    setNotices((current) => [...current.filter((item) => item.source !== source), notice].slice(-3));
  }, []);

  const clear = useCallback((source: string) => {
    setNotices((current) => current.filter((item) => item.source !== source));
  }, []);
  const contextValue = useMemo(() => ({ show, clear }), [show, clear]);

  useEffect(() => {
    const timers = notices.filter((notice) => notice.expiresAt !== null).map((notice) =>
      window.setTimeout(() => {
        setNotices((current) => current.filter((item) => item.id !== notice.id));
      }, Math.max(0, notice.expiresAt! - Date.now())),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [notices]);

  return (
    <FeedbackContext.Provider value={contextValue}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[100] mx-auto flex max-w-md flex-col gap-2 sm:inset-x-auto sm:right-5 sm:top-5 sm:w-full" aria-label="Action results">
        {notices.map((notice) => {
          const Icon = notice.tone === "error" ? AlertCircle : notice.tone === "success" ? CheckCircle2 : Info;
          return (
            <div key={notice.id} role={notice.tone === "error" ? "alert" : "status"} className={`pointer-events-auto flex items-start gap-3 rounded-xl border bg-white p-4 text-sm shadow-lg ${notice.tone === "error" ? "border-red-300 text-red-900" : notice.tone === "success" ? "border-emerald-300 text-emerald-900" : "border-amber-300 text-stone-900"}`}>
              <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <p className="min-w-0 flex-1 leading-5">{notice.text}</p>
              <button type="button" onClick={() => clear(notice.source)} aria-label="Dismiss notification" className="-mr-1 -mt-1 rounded-md p-1 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700"><X className="size-4" aria-hidden="true" /></button>
            </div>
          );
        })}
      </div>
    </FeedbackContext.Provider>
  );
}

// The hook intentionally shares this file with its provider so every action uses the same notice queue.
// eslint-disable-next-line react-refresh/only-export-components
export function useActionMessage<T extends FeedbackValue>(initial: T | (() => T), defaultTone: Tone = "info") {
  const [value, setValue] = useState<T>(initial);
  const source = useId();
  const context = useContext(FeedbackContext);

  const setMessage = useCallback((next: T) => {
    setValue(next);
    const details = feedbackDetails(next, defaultTone);
    if (details) context.show(source, details.text, details.tone);
    else context.clear(source);
  }, [context, defaultTone, source]);

  return [value, setMessage] as const;
}

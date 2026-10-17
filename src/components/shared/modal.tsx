import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

type ModalProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  size?: "default" | "wide";
};

export function Modal({
  open,
  title,
  children,
  onClose,
  size = "default",
}: ModalProps) {
  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center p-5"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 cursor-default bg-stone-950/40"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={`relative z-10 max-h-[90vh] w-full overflow-y-auto rounded-xl bg-white p-6 shadow-xl ring-1 ring-stone-200 ${size === "wide" ? "max-w-5xl" : "max-w-lg"}`}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="modal-title" className="text-lg font-semibold text-stone-950">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close dialog"
            title="Close dialog"
            onClick={onClose}
            className="rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-5">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

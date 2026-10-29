import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, BookOpen, Search, ShieldCheck, X } from "lucide-react";
import { Link, useLocation } from "react-router-dom";

import { useAccess } from "@/features/auth/use-access";

import { getVisibleHelpGuides } from "./help-content";

type HelpCenterProps = { open: boolean; onClose: () => void };

export function HelpCenter({ open, onClose }: HelpCenterProps) {
  const [search, setSearch] = useState("");
  const { roleCodes, isLoading, error } = useAccess();
  const { pathname } = useLocation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const guides = getVisibleHelpGuides(roleCodes, search);
  const guideSections = Array.from(
    guides.reduce((sections, guide) => {
      const existing = sections.get(guide.route) ?? [];
      existing.push(guide);
      sections.set(guide.route, existing);
      return sections;
    }, new Map<string, typeof guides>()),
  ).sort(([first], [second]) => Number(second === pathname) - Number(first === pathname));
  const primaryRole = roleCodes[0]?.replaceAll("_", " ") ?? "staff";

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const focusable = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), a[href], summary',
          ) ?? [],
        ).filter((element) => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        aria-label="Close help panel"
        onClick={onClose}
        className="absolute inset-0 bg-stone-950/35 backdrop-blur-[1px]"
      />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-stone-200 bg-[#fbfaf8] shadow-2xl"
      >
        <header className="border-b border-stone-200 bg-white px-5 py-5 sm:px-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.15em] text-amber-800">
                <BookOpen className="size-3.5" aria-hidden="true" /> Staff guide
              </p>
              <h2
                id="help-center-title"
                className="mt-1 text-xl font-semibold tracking-tight text-stone-950"
              >
                How can we help?
              </h2>
              <p className="mt-1 text-sm text-stone-600">
                Quick instructions for your {primaryRole} role.
              </p>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label="Close help panel"
              className="grid size-10 shrink-0 place-items-center rounded-xl border border-stone-200 text-stone-600 hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
            >
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          <label className="mt-5 flex items-center gap-2 rounded-xl border border-stone-300 bg-white px-3.5 py-3 shadow-sm focus-within:border-amber-700 focus-within:ring-2 focus-within:ring-amber-100">
            <Search className="size-4 shrink-0 text-stone-400" aria-hidden="true" />
            <span className="sr-only">Search help guides</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search reservations, payments, checkout…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-stone-400"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="text-xs font-semibold text-amber-900 hover:underline"
              >
                Clear
              </button>
            )}
          </label>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-7">
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-xs leading-5 text-emerald-950">
            <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
            <p>
              These guides explain workflows only. They do not access guest or
              payment records or perform actions.
            </p>
          </div>

          {isLoading ? (
            <p className="rounded-xl border border-stone-200 bg-white p-5 text-sm text-stone-600" role="status">
              Loading guides for your role…
            </p>
          ) : error ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950" role="alert">
              We couldn’t confirm your role, so role-specific guides are
              unavailable. Refresh the page or ask the GM to check your
              account access.
            </p>
          ) : guides.length ? (
            <div className="space-y-6">
              {guideSections.map(([route, sectionGuides]) => (
                <section
                  key={route}
                  aria-label={sectionGuides[0].routeLabel.replace(/^Open /, "")}
                >
                  <h3 className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-stone-500">
                    {route === pathname ? "On this page · " : ""}
                    {sectionGuides[0].routeLabel.replace(/^Open /, "")}
                  </h3>
                  <div className="space-y-3">
                    {sectionGuides.map((guide) => (
                      <details
                        key={guide.id}
                        className="group overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm open:border-amber-200"
                      >
                        <summary className="cursor-pointer list-none px-4 py-4 marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-700 sm:px-5">
                          <span className="flex items-start justify-between gap-4">
                            <span>
                              <span className="block font-semibold text-stone-900">
                                {guide.title}
                              </span>
                              <span className="mt-1 block text-sm leading-5 text-stone-600">
                                {guide.summary}
                              </span>
                            </span>
                            <span
                              aria-hidden="true"
                              className="mt-1 text-lg leading-none text-amber-900 transition-transform group-open:rotate-45"
                            >
                              +
                            </span>
                          </span>
                        </summary>
                        <div className="border-t border-stone-100 px-4 py-4 sm:px-5">
                          <ol className="space-y-3 text-sm leading-6 text-stone-700">
                            {guide.steps.map((step, index) => (
                              <li key={step} className="flex gap-3">
                                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-amber-50 text-xs font-bold text-amber-950">
                                  {index + 1}
                                </span>
                                <span>{step}</span>
                              </li>
                            ))}
                          </ol>
                          {guide.note && (
                            <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-950">
                              <b>Important:</b> {guide.note}
                            </p>
                          )}
                          <Link
                            to={guide.route}
                            onClick={onClose}
                            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-amber-900 px-3.5 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2"
                          >
                            {guide.routeLabel}
                            <ArrowUpRight className="size-4" aria-hidden="true" />
                          </Link>
                        </div>
                      </details>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-stone-300 bg-white px-5 py-10 text-center">
              <BookOpen className="mx-auto size-7 text-stone-400" aria-hidden="true" />
              <p className="mt-3 font-semibold text-stone-900">
                No matching guide found
              </p>
              <p className="mx-auto mt-1 max-w-sm text-sm leading-5 text-stone-600">
                Try another search. If the process is not covered here, ask the
                General Manager before proceeding.
              </p>
            </div>
          )}
        </div>
        <footer className="border-t border-stone-200 bg-white px-5 py-3 text-xs text-stone-500 sm:px-7">
          Role-filtered help · Ask a manager whenever the hotel policy is unclear.
        </footer>
      </section>
    </div>,
    document.body,
  );
}

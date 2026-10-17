import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "@/features/auth/auth-provider";
import { isSupabaseConfigured, supabase } from "@/lib/supabase/client";

type Feedback = { tone: "error" | "success"; text: string } | null;

export function SignInPage() {
  const { session } = useAuth();
  const emailId = useId();
  const passwordId = useId();
  const feedbackId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(() =>
    new URLSearchParams(window.location.search).get("password") === "updated"
      ? { tone: "success", text: "Password saved. Sign in with your new password." }
      : null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const isBusy = isSubmitting || isResetting;

  useEffect(() => {
    document.title = "Sign in | Mahogany Hotel";
    emailRef.current?.focus();
  }, []);

  if (!isSupabaseConfigured) return <Navigate to="/setup" replace />;
  if (session) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || isBusy) return;

    setIsSubmitting(true);
    setFeedback(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setIsSubmitting(false);
    if (error) {
      setFeedback({
        tone: "error",
        text: "We could not sign you in. Check your email and password.",
      });
      emailRef.current?.focus();
    }
  }

  async function requestPasswordReset() {
    if (!supabase || isBusy) return;
    if (!email.trim()) {
      setFeedback({
        tone: "error",
        text: "Enter your staff email address first, then select Forgot password.",
      });
      emailRef.current?.focus();
      return;
    }

    setIsResetting(true);
    setFeedback(null);
    const normalizedEmail = email.trim().toLowerCase();
    const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: `${window.location.origin}/set-password?flow=recovery`,
    });
    setIsResetting(false);
    if (error) {
      setFeedback({ tone: "error", text: `We could not send the reset email: ${error.message}` });
      return;
    }
    setFeedback({
      tone: "success",
      text: "If this email belongs to a staff account, password reset instructions have been sent. Check the inbox and follow the email instructions.",
    });
  }

  return (
    <main className="grid min-h-screen place-items-center bg-stone-100 p-5">
      <form
        onSubmit={handleSubmit}
        aria-labelledby="sign-in-heading"
        aria-describedby="sign-in-help"
        aria-busy={isBusy}
        className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-stone-200"
      >
        <img src="/mahogany-logo.png" alt="Mahogany Hotel & Suites" className="h-20 w-64 max-w-full object-contain" />
        <h1 id="sign-in-heading" className="mt-6 text-2xl font-semibold tracking-tight">
          Sign in to Mahogany Hotel
        </h1>
        <p id="sign-in-help" className="mt-2 text-sm leading-6 text-stone-600">
          Use the staff account assigned to you. Required fields are marked.
        </p>

        <label htmlFor={emailId} className="mt-7 block text-sm font-medium text-stone-700">
          Email address <span aria-hidden="true">*</span>
        </label>
        <input
          ref={emailRef}
          id={emailId}
          name="email"
          required
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          aria-describedby={feedback?.tone === "error" ? feedbackId : undefined}
          aria-invalid={feedback?.tone === "error" ? true : undefined}
          onChange={(event) => {
            setEmail(event.target.value);
            if (feedback?.tone === "error") setFeedback(null);
          }}
          className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2.5 outline-none transition focus-visible:border-amber-700 focus-visible:ring-2 focus-visible:ring-amber-200"
        />

        <label htmlFor={passwordId} className="mt-4 block text-sm font-medium text-stone-700">
          Password <span aria-hidden="true">*</span>
        </label>
        <div className="relative mt-2" dir="ltr">
          <input
            id={passwordId}
            name="password"
            required
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            aria-describedby={feedback?.tone === "error" ? feedbackId : undefined}
            aria-invalid={feedback?.tone === "error" ? true : undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              if (feedback?.tone === "error") setFeedback(null);
            }}
            className="w-full rounded-lg border border-stone-300 py-2.5 pl-3 pr-14 text-left outline-none transition focus-visible:border-amber-700 focus-visible:ring-2 focus-visible:ring-amber-200"
          />
          <button
            type="button"
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((visible) => !visible)}
            style={{ left: "auto", right: "0.5rem" }}
            className="absolute top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-stone-600 hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
          >
            {showPassword ? (
              <EyeOff className="size-5" aria-hidden="true" />
            ) : (
              <Eye className="size-5" aria-hidden="true" />
            )}
          </button>
        </div>

        <div
          id={feedbackId}
          role={feedback?.tone === "error" ? "alert" : "status"}
          aria-live={feedback?.tone === "error" ? "assertive" : "polite"}
          className={`mt-4 min-h-5 text-sm ${
            feedback?.tone === "error" ? "text-red-700" : "text-emerald-700"
          }`}
        >
          {feedback?.text}
        </div>

        <button
          type="submit"
          disabled={isBusy}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isSubmitting && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
          {isSubmitting ? "Signing in…" : "Sign in"}
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={requestPasswordReset}
          className="mt-4 w-full rounded-md py-1 text-sm font-semibold text-amber-900 hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isResetting ? "Sending reset email…" : "Forgot password?"}
        </button>
      </form>
    </main>
  );
}

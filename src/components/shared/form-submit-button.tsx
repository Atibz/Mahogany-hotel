import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { isRequiredTextComplete } from "./form-readiness";

function isScopeComplete(scope: HTMLFormElement | HTMLDetailsElement): boolean {
  if (scope instanceof HTMLFormElement && !scope.checkValidity()) return false;

  // Native `required` accepts whitespace-only text, which our submit handlers
  // generally reject after trimming. Keep the button in sync with that rule.
  return Array.from(scope.querySelectorAll("input, textarea, select")).every((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (!element.checkValidity()) return false;
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return true;
    if (element.disabled || !element.required) return true;
    if (element instanceof HTMLInputElement && !["text", "email", "tel", "url", "search", "password"].includes(element.type)) return true;
    return isRequiredTextComplete(element.value, element.minLength);
  });
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { validationScope?: "form" | "details" };

/** A submit button that stays inactive until its containing form is complete. */
export function FormSubmitButton({ disabled, className, type = "submit", validationScope = "form", ...props }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [complete, setComplete] = useState(false);

  useLayoutEffect(() => {
    const scope = validationScope === "details"
      ? buttonRef.current?.closest("details")
      : buttonRef.current?.form;
    if (!scope) return;

    const update = () => setComplete(isScopeComplete(scope));
    const updateAfterReset = () => queueMicrotask(update);
    update();
    scope.addEventListener("input", update);
    scope.addEventListener("change", update);
    scope.addEventListener("reset", updateAfterReset);
    return () => {
      scope.removeEventListener("input", update);
      scope.removeEventListener("change", update);
      scope.removeEventListener("reset", updateAfterReset);
    };
  });

  return <button {...props} ref={buttonRef} type={type} disabled={disabled || !complete} className={`${className ?? ""} disabled:cursor-not-allowed disabled:opacity-50`} />;
}

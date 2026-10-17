type PrintElementOptions = {
  source: HTMLElement;
  title: string;
  styles: string;
  removeSelector?: string;
};

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export function printElementInIsolatedFrame({
  source,
  title,
  styles,
  removeSelector,
}: PrintElementOptions): boolean {
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    right: "0",
    bottom: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
  });
  document.body.appendChild(frame);

  const printDocument = frame.contentDocument;
  const printWindow = frame.contentWindow;
  if (!printDocument || !printWindow) {
    frame.remove();
    return false;
  }
  if (typeof printWindow.print !== "function") {
    frame.remove();
    return false;
  }

  printDocument.open();
  printDocument.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body></body></html>`,
  );
  printDocument.close();

  const printableElement = source.cloneNode(true) as HTMLElement;
  if (removeSelector) {
    printableElement
      .querySelectorAll(removeSelector)
      .forEach((element) => element.remove());
  }
  printDocument.body.appendChild(printableElement);

  const cleanup = () => frame.remove();
  printWindow.onafterprint = cleanup;
  window.setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 50);
  window.setTimeout(cleanup, 60_000);
  return true;
}

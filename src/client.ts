import { executeWaitlistRecaptcha } from "./recaptcha-browser.ts";

const form = document.querySelector<HTMLFormElement>("[data-waitlist-form]");
const emailInput = document.querySelector<HTMLInputElement>("[data-waitlist-email]");
const statusText = document.querySelector<HTMLElement>("[data-waitlist-status]");
const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
const endpointInput = document.querySelector<HTMLInputElement>("[data-mcp-endpoint]");
const copyButton = document.querySelector<HTMLButtonElement>("[data-copy-endpoint]");
const copyStatus = document.querySelector<HTMLElement>("[data-copy-status]");

copyButton?.addEventListener("click", async () => {
  if (!endpointInput || !copyStatus) return;
  try {
    await navigator.clipboard.writeText(endpointInput.value);
    copyStatus.textContent = "Copied.";
  } catch {
    endpointInput.focus();
    endpointInput.select();
    copyStatus.textContent = "Select and copy the server URL.";
  }
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = emailInput?.value.trim() ?? "";
  if (!emailInput || !statusText || !submitButton || submitButton.disabled) {
    return;
  }

  if (!email.includes("@")) {
    setStatus("Enter a valid email address.", "error");
    return;
  }

  setStatus("Joining...", "pending");
  submitButton.disabled = true;
  submitButton.textContent = "Joining…";
  form?.setAttribute("aria-busy", "true");

  try {
    const recaptchaToken = await executeWaitlistRecaptcha("join");
    const response = await fetch("/api/waitlist", {
      body: JSON.stringify({ email, recaptchaToken, source: "site" }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as { error?: string; ok?: boolean };

    if (!response.ok) {
      setStatus(body.error ?? "Unable to join right now.", "error");
      return;
    }

    emailInput.value = "";
    setStatus("Thanks. Check your inbox to confirm your address.", "success");
  } catch {
    setStatus("Unable to join right now. Please try again.", "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Join waitlist";
    form?.setAttribute("aria-busy", "false");
  }
});

function setStatus(message: string, state: "error" | "pending" | "success"): void {
  if (!statusText) {
    return;
  }

  statusText.textContent = message;
  statusText.dataset.state = state;
}

import { executeWaitlistRecaptcha } from "./recaptcha-browser.ts";

const button = document.querySelector<HTMLButtonElement>("[data-confirm-button]");
const statusText = document.querySelector<HTMLElement>("[data-confirm-status]");

if (new URLSearchParams(location.search).get("result") === "invalid") {
  setStatus("This confirmation link is invalid or has expired.", "error");
  if (button) button.disabled = true;
  history.replaceState(null, "", "/waitlist/confirm");
}

button?.addEventListener("click", async () => {
  if (!button || !statusText) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setStatus("Verifying your address…", "pending");
  try {
    const recaptchaToken = await executeWaitlistRecaptcha("confirm");
    const response = await fetch("/api/waitlist/confirm", {
      body: JSON.stringify({ recaptchaToken }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      setStatus("This confirmation link is invalid or has expired.", "error");
      return;
    }
    setStatus("Your address is confirmed. You’re on the waitlist.", "success");
    button.textContent = "Confirmed";
  } catch {
    setStatus("Confirmation is temporarily unavailable. Please try the email link again.", "error");
  } finally {
    button.removeAttribute("aria-busy");
    button.disabled = statusText.dataset.state === "success";
  }
});

function setStatus(message: string, state: "error" | "pending" | "success"): void {
  if (!statusText) return;
  statusText.textContent = message;
  statusText.dataset.state = state;
}

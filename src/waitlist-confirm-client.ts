import { executeWaitlistRecaptcha } from "./recaptcha-browser.ts";

const button = document.querySelector<HTMLButtonElement>("[data-confirm-button]");
const statusText = document.querySelector<HTMLElement>("[data-confirm-status]");

if (new URLSearchParams(location.search).get("result") === "invalid") {
  setStatus("This confirmation link is invalid or has expired.", "error");
  history.replaceState(null, "", "/waitlist/confirm");
}

button?.addEventListener("click", async () => {
  if (!button || !statusText) return;
  button.disabled = true;
  setStatus("Verifying your address…", "pending");
  try {
    const recaptchaToken = await executeWaitlistRecaptcha("confirm");
    const response = await fetch("/api/waitlist/confirm", {
      body: JSON.stringify({ recaptchaToken }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      setStatus("This confirmation link is invalid or has expired.", "error");
      return;
    }
    setStatus("Your address is confirmed. You’re on the waitlist.", "success");
  } catch {
    setStatus("Confirmation is temporarily unavailable. Please try the email link again.", "error");
  } finally {
    button.disabled = false;
  }
});

function setStatus(message: string, state: "error" | "pending" | "success"): void {
  if (!statusText) return;
  statusText.textContent = message;
  statusText.dataset.state = state;
}

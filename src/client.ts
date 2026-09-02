import { executeWaitlistRecaptcha } from "./recaptcha-browser.ts";

const form = document.querySelector<HTMLFormElement>("[data-waitlist-form]");
const emailInput = document.querySelector<HTMLInputElement>("[data-waitlist-email]");
const statusText = document.querySelector<HTMLElement>("[data-waitlist-status]");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = emailInput?.value.trim() ?? "";
  if (!emailInput || !statusText) {
    return;
  }

  if (!email.includes("@")) {
    setStatus("Enter a valid email address.", "error");
    return;
  }

  setStatus("Joining...", "pending");

  try {
    const recaptchaToken = await executeWaitlistRecaptcha("join");
    const response = await fetch("/api/waitlist", {
      body: JSON.stringify({ email, recaptchaToken, source: "site" }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = (await response.json()) as { error?: string; ok?: boolean };

    if (!response.ok) {
      setStatus(body.error ?? "Unable to join right now.", "error");
      return;
    }

    emailInput.value = "";
    // One message for every accepted address. The page used to say "You're
    // already on the waitlist" for a known address and something else for a new
    // one, which turned the form into a membership oracle that needed no API
    // knowledge at all -- anyone could type an address and read the answer.
    setStatus("Thanks. Check your inbox to confirm your address.", "success");
  } catch {
    setStatus("Unable to join right now.", "error");
  }
});

function setStatus(message: string, state: "error" | "pending" | "success"): void {
  if (!statusText) {
    return;
  }

  statusText.textContent = message;
  statusText.dataset.state = state;
}

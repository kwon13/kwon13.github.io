(() => {
  "use strict";

  const enPanel = document.getElementById("statement-content-en");
  const koPanel = document.getElementById("statement-content-ko");
  const buttons = Array.from(document.querySelectorAll("[data-lang-btn]"));

  if (!enPanel || !koPanel || buttons.length === 0) {
    return;
  }

  const storageKey = "statement-language";
  const valid = new Set(["en", "ko"]);

  function applyLanguage(lang) {
    const next = valid.has(lang) ? lang : "en";
    enPanel.hidden = next !== "en";
    koPanel.hidden = next !== "ko";

    for (let i = 0; i < buttons.length; i += 1) {
      const button = buttons[i];
      const active = button.getAttribute("data-lang-btn") === next;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }

    document.documentElement.lang = next;

    return next;
  }

  let initial = "en";
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved && valid.has(saved)) {
      initial = saved;
    }
  } catch (_error) {
    initial = "en";
  }

  let current = applyLanguage(initial);

  for (let i = 0; i < buttons.length; i += 1) {
    buttons[i].addEventListener("click", () => {
      const next = buttons[i].getAttribute("data-lang-btn") || "en";
      if (next === current) {
        return;
      }

      try {
        window.localStorage.setItem(storageKey, next);
      } catch (_error) {
        // Ignore storage errors in private mode.
      }

      current = next;
      window.location.reload();
    });
  }
})();

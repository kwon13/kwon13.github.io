(() => {
  "use strict";

  const mount = document.querySelector("[data-shared-header]");
  if (!mount) {
    return;
  }

  const current = String(mount.getAttribute("data-current") || "").toLowerCase();
  const homeClass = current === "home" ? ' class="is-current"' : "";
  const statementClass = current === "statement" ? ' class="is-current"' : "";

  mount.className = "topbar container";
  mount.innerHTML = [
    '<a class="brand" href="index.html">Yonghoon Kwon</a>',
    '<nav class="site-nav" aria-label="Primary navigation">',
    `  <a href="index.html"${homeClass}>Home</a>`,
    `  <a href="statement.html"${statementClass}>Statement</a>`,
    "</nav>"
  ].join("\n");
})();
